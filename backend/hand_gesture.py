"""
Hand Gesture Module - Audio-Driven Expressive Hand Movements
============================================================
يضيف حركة تعبيرية لليد/الذراع متزامنة مع الكلام.

الاستراتيجية:
1. كشف معالم الجسم (Pose Landmarks) باستخدام MediaPipe Pose.
2. تحديد منطقة الذراع + الكتف + اليد.
3. تحليل الصوت: استخراج beats, onsets, energy envelope.
4. توليد motion curves بناءً على الإيقاع:
   - على كل beat: اليد ترتفع قليلاً (gesture emphasis)
   - بين beats: حركة طبيعية (sway)
   - silent periods: اليد ترجع لمكانها الأصلي
5. تطبيق الحركة بـ affine warp على منطقة الذراع مع inpainting للخلفية.
6. alpha blend مع الـ feathering لتنعيم الحواف.

النتيجة: حركة يد تعبيرية طبيعية متزامنة مع الكلام.
"""

import os
import cv2
import numpy as np
from typing import List, Tuple, Optional, Dict
import subprocess
import tempfile

# mediapipe Tasks API
try:
    import mediapipe as mp
    from mediapipe.tasks.python import vision as mp_vision
    from mediapipe.tasks.python.core.base_options import BaseOptions
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    MEDIAPIPE_AVAILABLE = False
    mp = None
    mp_vision = None
    BaseOptions = None

# Path to pose landmarker model
_POSE_LANDMARKER_PATH = os.environ.get(
    'POSE_LANDMARKER_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 '..', 'public', 'models', 'pose_landmarker.task')
)

# MediaPipe Pose landmarks (33 points)
# https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
LANDMARK_LEFT_SHOULDER = 11
LANDMARK_RIGHT_SHOULDER = 12
LANDMARK_LEFT_ELBOW = 13
LANDMARK_RIGHT_ELBOW = 14
LANDMARK_LEFT_WRIST = 15
LANDMARK_RIGHT_WRIST = 16
LANDMARK_LEFT_HIP = 23
LANDMARK_RIGHT_HIP = 24


# =============================================================================
# تحليل الصوت - استخراج الإيقاع
# =============================================================================

def analyze_audio_rhythm(audio_path: str, fps: int = 25) -> Dict:
    """
    يحلل الصوت ويستخرج:
    - energy envelope لكل إطار فيديو
    - beats (لحظات التشديد)
    - onsets (بدايات الكلمات/المقاطع)
    - silent periods (فترات الصمت)

    Returns: dict with:
        - 'energy': array of energy values per video frame (0-1)
        - 'beats': list of frame indices where beats occur
        - 'onsets': list of frame indices where speech onsets occur
        - 'silent': boolean array, True if frame is silent
        - 'emphasis': array of emphasis values (0-1) - peaks of energy
    """
    try:
        import librosa
    except ImportError:
        print("[Gesture] WARNING: librosa not available, using synthetic rhythm")
        return _synthetic_rhythm(100, fps)

    try:
        # Load audio
        y, sr = librosa.load(audio_path, sr=16000, mono=True)

        if len(y) == 0:
            return _synthetic_rhythm(100, fps)

        duration = len(y) / sr
        n_frames = max(1, int(duration * fps))

        # === 1. Energy envelope (RMS-based, more robust than mel) ===
        hop_length = 512
        # RMS energy: short-term loudness
        rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop_length)[0]
        # Normalize to 0-1
        if rms.max() > rms.min():
            rms_norm = (rms - rms.min()) / (rms.max() - rms.min() + 1e-9)
        else:
            rms_norm = np.zeros_like(rms)

        # Resample to video frames
        n_steps = len(rms_norm)
        if n_steps > 0:
            energy = np.interp(
                np.linspace(0, n_steps - 1, n_frames),
                np.arange(n_steps),
                rms_norm
            )
        else:
            energy = np.zeros(n_frames)

        # === 2. Beats - try multiple methods, fallback to energy peaks ===
        beats = []
        try:
            tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop_length)
            beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)
            beats = [int(t * fps) for t in beat_times if int(t * fps) < n_frames]
        except Exception:
            pass

        # === 3. Onsets - speech syllable starts ===
        onsets = []
        try:
            # onset_detect with units='time' returns times directly
            onset_times = librosa.onset.onset_detect(
                y=y, sr=sr, hop_length=hop_length, units='time',
                pre_max=3, post_max=3, pre_avg=3, post_avg=5,
                delta=0.07, wait=4
            )
            onsets = [int(t * fps) for t in onset_times if int(t * fps) < n_frames]
        except Exception:
            pass

        # === 3b. If no beats/onsets detected, use energy peaks as onsets ===
        if not onsets and not beats:
            # Find local maxima in energy (with minimum distance)
            from scipy.signal import find_peaks
            # Smooth energy first
            smooth_kernel = max(3, int(fps * 0.1))
            if smooth_kernel % 2 == 0:
                smooth_kernel += 1
            smooth_energy = cv2.GaussianBlur(
                energy.reshape(-1, 1), (smooth_kernel, 1), 0
            ).flatten()
            # Find peaks: minimum height 0.3, minimum distance 0.3s
            min_distance = max(1, int(fps * 0.3))
            peaks, _ = find_peaks(smooth_energy, height=0.25, distance=min_distance)
            onsets = [p for p in peaks if p < n_frames]
            print(f"[Gesture] Used energy-peak fallback: {len(onsets)} onsets")

        # === 4. Silent periods (energy < threshold) ===
        silence_threshold = 0.12
        silent = energy < silence_threshold

        # === 5. Emphasis (smoothed + peaks) ===
        kernel_size = max(3, int(fps * 0.2))  # 200ms smoothing
        if kernel_size % 2 == 0:
            kernel_size += 1
        emphasis = cv2.GaussianBlur(energy.reshape(-1, 1), (kernel_size, 1), 0).flatten()
        if emphasis.max() > 0:
            emphasis = emphasis / emphasis.max()

        # === 6. Fallback beats: if still no beats, use onsets as beats ===
        if not beats and onsets:
            beats = onsets[:10]  # Use first 10 onsets as beats

        print(f"[Gesture] Audio analysis: {n_frames} frames, {duration:.1f}s, "
              f"{len(beats)} beats, {len(onsets)} onsets, "
              f"energy_mean={energy.mean():.3f}")

        return {
            'energy': energy,
            'beats': beats,
            'onsets': onsets,
            'silent': silent,
            'emphasis': emphasis,
            'n_frames': n_frames,
            'duration': duration,
        }

    except Exception as e:
        print(f"[Gesture] WARNING: audio analysis failed: {e}")
        import traceback
        traceback.print_exc()
        return _synthetic_rhythm(100, fps)


def _synthetic_rhythm(n_frames: int, fps: int) -> Dict:
    """Fallback rhythm when librosa unavailable."""
    energy = np.zeros(n_frames)
    beats = []
    onsets = []
    # Simulate a beat every 1 second
    for i in range(0, n_frames, fps):
        beats.append(i)
        energy[i:i+3] = 0.8
    emphasis = energy.copy()
    silent = energy < 0.15
    return {
        'energy': energy,
        'beats': beats,
        'onsets': onsets,
        'silent': silent,
        'emphasis': emphasis,
        'n_frames': n_frames,
        'duration': n_frames / fps,
    }


# =============================================================================
# كشف معالم الجسم (Pose Landmarks)
# =============================================================================

class PoseDetector:
    """يكشف معالم الجسم باستخدام MediaPipe Pose."""

    def __init__(self):
        self._landmarker = None
        self._initialized = False

    def _init(self):
        if self._initialized:
            return
        self._initialized = True
        if not MEDIAPIPE_AVAILABLE:
            print("[PoseDetector] mediapipe not available")
            return
        if not os.path.exists(_POSE_LANDMARKER_PATH):
            print(f"[PoseDetector] WARNING: pose model not found at {_POSE_LANDMARKER_PATH}")
            return
        try:
            options = mp_vision.PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=_POSE_LANDMARKER_PATH),
                running_mode=mp_vision.RunningMode.IMAGE,
                num_poses=1,
                min_pose_detection_confidence=0.5,
                min_pose_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self._landmarker = mp_vision.PoseLandmarker.create_from_options(options)
            print(f"[PoseDetector] initialized (model: {_POSE_LANDMARKER_PATH})")
        except Exception as e:
            print(f"[PoseDetector] WARNING: init failed: {e}")
            self._landmarker = None

    def detect(self, image: np.ndarray) -> Optional[Dict]:
        """
        يكشف معالم الجسم.
        Returns: dict with normalized landmark positions, or None.
        """
        self._init()
        if self._landmarker is None:
            return None
        try:
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = self._landmarker.detect(mp_image)
            if not result.pose_landmarks:
                return None
            landmarks = result.pose_landmarks[0]  # list of NormalizedLandmark
            h, w = image.shape[:2]
            return {
                'landmarks': landmarks,
                'h': h,
                'w': w,
                # Convert to pixel coords for key joints
                'left_shoulder': (int(landmarks[LANDMARK_LEFT_SHOULDER].x * w),
                                  int(landmarks[LANDMARK_LEFT_SHOULDER].y * h),
                                  landmarks[LANDMARK_LEFT_SHOULDER].visibility),
                'right_shoulder': (int(landmarks[LANDMARK_RIGHT_SHOULDER].x * w),
                                   int(landmarks[LANDMARK_RIGHT_SHOULDER].y * h),
                                   landmarks[LANDMARK_RIGHT_SHOULDER].visibility),
                'left_elbow': (int(landmarks[LANDMARK_LEFT_ELBOW].x * w),
                               int(landmarks[LANDMARK_LEFT_ELBOW].y * h),
                               landmarks[LANDMARK_LEFT_ELBOW].visibility),
                'right_elbow': (int(landmarks[LANDMARK_RIGHT_ELBOW].x * w),
                                int(landmarks[LANDMARK_RIGHT_ELBOW].y * h),
                                landmarks[LANDMARK_RIGHT_ELBOW].visibility),
                'left_wrist': (int(landmarks[LANDMARK_LEFT_WRIST].x * w),
                               int(landmarks[LANDMARK_LEFT_WRIST].y * h),
                               landmarks[LANDMARK_LEFT_WRIST].visibility),
                'right_wrist': (int(landmarks[LANDMARK_RIGHT_WRIST].x * w),
                                int(landmarks[LANDMARK_RIGHT_WRIST].y * h),
                                landmarks[LANDMARK_RIGHT_WRIST].visibility),
                'left_hip': (int(landmarks[LANDMARK_LEFT_HIP].x * w),
                             int(landmarks[LANDMARK_LEFT_HIP].y * h),
                             landmarks[LANDMARK_LEFT_HIP].visibility),
                'right_hip': (int(landmarks[LANDMARK_RIGHT_HIP].x * w),
                              int(landmarks[LANDMARK_RIGHT_HIP].y * h),
                              landmarks[LANDMARK_RIGHT_HIP].visibility),
            }
        except Exception as e:
            print(f"[PoseDetector] detect failed: {e}")
            return None

    def close(self):
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception:
                pass
            self._landmarker = None
        self._initialized = False


def select_gesture_arm(pose: Dict) -> Optional[str]:
    """
    يختار الذراع الأنسب للحركة بناءً على:
    - الرؤية (visibility)
    - المساحة المتاحة (لو في إيد ظاهرة في الصورة)

    Returns: 'left', 'right', or None
    """
    if pose is None:
        return None

    # Compare visibility of both wrists
    left_vis = pose['left_wrist'][2]
    right_vis = pose['right_wrist'][2]

    # Need at least one arm visible
    if left_vis < 0.3 and right_vis < 0.3:
        return None

    # Choose the more visible one
    if left_vis > right_vis:
        return 'left'
    else:
        return 'right'


def get_arm_region(pose: Dict, side: str, padding: int = 20) -> Optional[Tuple[int, int, int, int]]:
    """
    يحسب bounding box للذراع (من الكتف للمعصم + padding).
    Returns: (x1, y1, x2, y2) in pixel coords.
    """
    if pose is None or side not in ('left', 'right'):
        return None

    shoulder = pose[f'{side}_shoulder']
    elbow = pose[f'{side}_elbow']
    wrist = pose[f'{side}_wrist']
    h, w = pose['h'], pose['w']

    # Use shoulder + elbow + wrist to define the arm region
    points = [shoulder[:2], elbow[:2], wrist[:2]]
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]

    x1 = max(0, min(xs) - padding)
    y1 = max(0, min(ys) - padding)
    x2 = min(w, max(xs) + padding)
    y2 = min(h, max(ys) + padding)

    if x2 - x1 < 20 or y2 - y1 < 20:
        return None

    return (x1, y1, x2, y2)


# =============================================================================
# توليد حركة الذراع
# =============================================================================

def generate_arm_motion(rhythm: Dict, n_frames: int, fps: int = 25,
                         max_shift_px: float = 25.0,
                         max_lift_px: float = 18.0) -> List[Dict]:
    """
    يولّد motion curves للذراع لكل إطار.

    Args:
        rhythm: dict from analyze_audio_rhythm
        n_frames: عدد الإطارات
        fps: frame rate
        max_shift_px: أقصى إزاحة أفقية (default 25px - واضحة في الفيديو)
        max_lift_px: أقصى رفع رأسي (default 18px - واضح كإيماءة)

    Returns: list of {'dx': float, 'dy': float, 'rotation': float, 'scale': float}
             for each frame.
    """
    motion = []

    if rhythm is None or rhythm.get('n_frames', 0) == 0:
        return [{'dx': 0, 'dy': 0, 'rotation': 0, 'scale': 1.0} for _ in range(n_frames)]

    energy = rhythm['energy']
    emphasis = rhythm['emphasis']
    beats = rhythm['beats']
    silent = rhythm['silent']

    # Smooth energy for natural motion
    kernel = max(3, int(fps * 0.15))  # 150ms
    if kernel % 2 == 0:
        kernel += 1
    smooth_energy = cv2.GaussianBlur(
        energy[:n_frames].reshape(-1, 1), (kernel, 1), 0
    ).flatten()

    # Generate base sway (slow sinusoidal for natural movement)
    sway_period = 2.5  # seconds
    sway_amp = max_shift_px * 0.3
    for i in range(n_frames):
        t = i / fps
        # Base sway (always present, subtle)
        sway_x = sway_amp * np.sin(2 * np.pi * t / sway_period)
        sway_y = sway_amp * 0.3 * np.cos(2 * np.pi * t / (sway_period * 0.7))

        # Energy-driven lift (hand raises with speech energy)
        # Map energy 0-1 to lift 0-max_lift_px
        e = smooth_energy[i] if i < len(smooth_energy) else 0
        lift_y = -max_lift_px * e  # negative = up

        # Beat-driven emphasis (sharp movement on beats)
        beat_boost = 0
        for beat in beats:
            if beat == i:
                beat_boost = max_shift_px * 0.7  # 70% of max on beat
                break
            elif abs(beat - i) <= 2:
                # Near a beat - decaying emphasis
                beat_boost = max_shift_px * 0.7 * (1 - abs(beat - i) / 3)

        # Beat direction alternates (left-right-left-right) for natural gesture
        beat_dir = 1
        for beat_idx, beat in enumerate(beats):
            if beat <= i:
                beat_dir = 1 if beat_idx % 2 == 0 else -1

        beat_x = beat_boost * beat_dir

        # Silent periods: hand returns to neutral (decay toward 0)
        if i < len(silent) and silent[i]:
            decay = 0.5
            sway_x *= decay
            sway_y *= decay
            lift_y *= decay
            beat_x *= decay

        dx = sway_x + beat_x
        dy = sway_y + lift_y

        # Small rotation proportional to dx (arm tilts with movement)
        rotation = (dx / max_shift_px) * 4.0  # ±4 degrees - more visible tilt

        # Subtle scale on emphasis (hand "pops" slightly on emphasis)
        scale = 1.0 + 0.04 * (emphasis[i] if i < len(emphasis) else 0)

        motion.append({
            'dx': float(dx),
            'dy': float(dy),
            'rotation': float(rotation),
            'scale': float(scale),
        })

    # Smooth the motion (avoid jumpy movement)
    motion = _smooth_motion(motion, kernel_size=5)

    return motion


def _smooth_motion(motion: List[Dict], kernel_size: int = 5) -> List[Dict]:
    """يطبق temporal smoothing على motion curves."""
    if kernel_size < 3 or len(motion) < kernel_size:
        return motion

    n = len(motion)
    half_k = kernel_size // 2
    smoothed = []
    for i in range(n):
        s, e = max(0, i - half_k), min(n, i + half_k + 1)
        window = motion[s:e]
        avg_dx = np.mean([m['dx'] for m in window])
        avg_dy = np.mean([m['dy'] for m in window])
        avg_rot = np.mean([m['rotation'] for m in window])
        avg_scale = np.mean([m['scale'] for m in window])
        smoothed.append({
            'dx': float(avg_dx),
            'dy': float(avg_dy),
            'rotation': float(avg_rot),
            'scale': float(avg_scale),
        })
    return smoothed


# =============================================================================
# تطبيق الحركة على الإطارات
# =============================================================================

def apply_arm_motion_to_frame(frame: np.ndarray, pose: Dict, side: str,
                               motion: Dict) -> np.ndarray:
    """
    يطبّق حركة الذراع على إطار واحد.

    الاستراتيجية:
    - نأخذ منطقة الذراع (shoulder → wrist)
    - نطبق affine warp بناءً على motion (dx, dy, rotation, scale)
    - نقيس الـ rotation حول نقطة الكتف (pivot) علشان الذراع يتحرك طبيعي
    - ندمج مع الـ feathering
    - نعمل inpainting بسيط للخلفية اللي ظهرت

    Args:
        frame: الإطار الأصلي
        pose: معالم الجسم
        side: 'left' أو 'right'
        motion: dict with dx, dy, rotation, scale

    Returns: الإطار بعد تطبيق الحركة
    """
    if motion is None or pose is None or side not in ('left', 'right'):
        return frame

    h, w = frame.shape[:2]
    dx = motion.get('dx', 0)
    dy = motion.get('dy', 0)
    rotation_deg = motion.get('rotation', 0)
    scale = motion.get('scale', 1.0)

    # Skip if motion is negligible
    if abs(dx) < 0.5 and abs(dy) < 0.5 and abs(rotation_deg) < 0.3:
        return frame

    # Get arm region with generous padding for warping
    arm_region = get_arm_region(pose, side, padding=30)
    if arm_region is None:
        return frame

    x1, y1, x2, y2 = arm_region

    # Pivot point: shoulder (rotation center)
    shoulder = pose[f'{side}_shoulder']
    pivot_x, pivot_y = shoulder[0], shoulder[1]

    # Convert region to local coords (relative to pivot)
    # Build affine matrix for rotation around pivot + translation + scale
    rad = np.deg2rad(rotation_deg)
    cos_r, sin_r = np.cos(rad), np.sin(rad)

    # Affine: rotate around pivot, scale, then translate
    # M = T(pivot) * R * S * T(-pivot) * T(dx, dy)
    M = np.float32([
        [scale * cos_r, -scale * sin_r, dx + pivot_x * (1 - scale * cos_r) + pivot_y * scale * sin_r],
        [scale * sin_r,  scale * cos_r, dy + pivot_y * (1 - scale * cos_r) - pivot_x * scale * sin_r],
    ])

    # Expand region slightly to give warp some breathing room
    pad = 15
    ex1 = max(0, x1 - pad)
    ey1 = max(0, y1 - pad)
    ex2 = min(w, x2 + pad)
    ey2 = min(h, y2 + pad)

    region_w = ex2 - ex1
    region_h = ey2 - ey1
    if region_w < 10 or region_h < 10:
        return frame

    # Warp the arm region
    arm_patch = frame[ey1:ey2, ex1:ex2].copy()
    warped = cv2.warpAffine(
        arm_patch, M, (region_w, region_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT
    )

    # Build alpha mask: 1 inside arm region, fades out at edges
    alpha = np.ones((region_h, region_w), dtype=np.float32)
    feather = max(5, min(region_h, region_w) // 6)
    # Create feathered edges
    alpha[:feather, :] *= np.linspace(0, 1, feather).reshape(-1, 1)
    alpha[-feather:, :] *= np.linspace(1, 0, feather).reshape(-1, 1)
    alpha[:, :feather] *= np.linspace(0, 1, feather).reshape(1, -1)
    alpha[:, -feather:] *= np.linspace(1, 0, feather).reshape(1, -1)
    # Gaussian blur for smooth blend
    blur_size = max(3, feather // 2)
    if blur_size % 2 == 0:
        blur_size += 1
    alpha = cv2.GaussianBlur(alpha, (blur_size, blur_size), 0)
    alpha_3ch = alpha[:, :, np.newaxis]

    # Blend warped arm into original frame
    result = frame.copy()
    region_orig = result[ey1:ey2, ex1:ex2].astype(np.float32)
    region_warped = warped.astype(np.float32)
    blended = region_orig * (1 - alpha_3ch) + region_warped * alpha_3ch
    result[ey1:ey2, ex1:ex2] = blended.astype(np.uint8)

    return result


# =============================================================================
# المعالج الرئيسي
# =============================================================================

class GestureProcessor:
    """يضيف حركة تعبيرية للذراع متزامنة مع الكلام."""

    def __init__(self, static_image: Optional[np.ndarray] = None):
        self.pose_detector = PoseDetector()
        self.static_pose: Optional[Dict] = None
        self.gesture_arm: Optional[str] = None  # 'left' or 'right'
        self.motion: Optional[List[Dict]] = None
        self._upscale_factor = 1.0

        if static_image is not None:
            self._init_from_static(static_image)

    def _init_from_static(self, image: np.ndarray):
        """يهيّئ من الصورة الأصلية: كشف الذراع."""
        # Upscale small images for better pose detection
        h, w = image.shape[:2]
        MIN_SIDE = 480
        if min(h, w) < MIN_SIDE:
            self._upscale_factor = MIN_SIDE / min(h, w)
            new_w = int(w * self._upscale_factor)
            new_h = int(h * self._upscale_factor)
            big = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
        else:
            big = image.copy()
            self._upscale_factor = 1.0

        pose = self.pose_detector.detect(big)
        if pose is None:
            print("[GestureProcessor] WARNING: no pose detected, gestures disabled")
            self.static_pose = None
            return

        self.static_pose = pose
        self.gesture_arm = select_gesture_arm(pose)

        if self.gesture_arm:
            shoulder = pose[f'{self.gesture_arm}_shoulder']
            wrist = pose[f'{self.gesture_arm}_wrist']
            print(f"[GestureProcessor] Pose detected, gesture arm: {self.gesture_arm.upper()}")
            print(f"  Shoulder: ({shoulder[0]}, {shoulder[1]}) vis={shoulder[2]:.2f}")
            print(f"  Wrist: ({wrist[0]}, {wrist[1]}) vis={wrist[2]:.2f}")
            arm_region = get_arm_region(pose, self.gesture_arm, padding=30)
            if arm_region:
                print(f"  Arm region: {arm_region}")
        else:
            print("[GestureProcessor] WARNING: no suitable arm detected, gestures disabled")

    def prepare_motion(self, audio_path: str, n_frames: int, fps: int = 25):
        """يحلل الصوت ويولّد motion curves."""
        if self.static_pose is None or self.gesture_arm is None:
            print("[GestureProcessor] No pose available, skipping motion prep")
            self.motion = [{'dx': 0, 'dy': 0, 'rotation': 0, 'scale': 1.0}
                          for _ in range(n_frames)]
            return

        rhythm = analyze_audio_rhythm(audio_path, fps=fps)
        self.motion = generate_arm_motion(rhythm, n_frames, fps=fps)
        print(f"[GestureProcessor] Generated motion for {len(self.motion)} frames")

    def process_frame(self, frame: np.ndarray, frame_idx: int) -> np.ndarray:
        """يطبّق الحركة على إطار واحد."""
        if (self.static_pose is None or self.gesture_arm is None
                or self.motion is None or frame_idx >= len(self.motion)):
            return frame

        # Get motion for this frame
        motion = self.motion[frame_idx]

        # Scale motion by inverse of upscale factor (if we upscaled for detection,
        # the actual frame is smaller, so motion needs to be smaller too)
        scale_factor = 1.0 / self._upscale_factor
        scaled_motion = {
            'dx': motion['dx'] * scale_factor,
            'dy': motion['dy'] * scale_factor,
            'rotation': motion['rotation'],  # rotation doesn't need scaling
            'scale': motion['scale'],
        }

        # Need to scale pose coords too if we upscaled for detection
        if self._upscale_factor != 1.0:
            scaled_pose = self._scale_pose(self.static_pose, scale_factor)
        else:
            scaled_pose = self.static_pose

        return apply_arm_motion_to_frame(frame, scaled_pose, self.gesture_arm, scaled_motion)

    def _scale_pose(self, pose: Dict, scale: float) -> Dict:
        """يصغّر معالم الجسم لتطابق حجم الإطار الفعلي."""
        scaled = dict(pose)
        for key in ['left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
                    'left_wrist', 'right_wrist', 'left_hip', 'right_hip']:
            x, y, v = pose[key]
            scaled[key] = (int(x * scale), int(y * scale), v)
        scaled['h'] = int(pose['h'] * scale)
        scaled['w'] = int(pose['w'] * scale)
        return scaled

    def process_video_frames(self, frames: List[np.ndarray], fps: int = 25,
                              audio_path: Optional[str] = None,
                              progress_callback=None) -> List[np.ndarray]:
        """يعالج كل الإطارات."""
        n = len(frames)
        if n == 0:
            return frames

        # Prepare motion from audio
        if audio_path:
            self.prepare_motion(audio_path, n, fps=fps)
        else:
            self.motion = [{'dx': 0, 'dy': 0, 'rotation': 0, 'scale': 1.0}
                          for _ in range(n)]

        if self.static_pose is None or self.gesture_arm is None:
            print("[GestureProcessor] No pose/arm available, returning frames unchanged")
            return frames

        out = []
        for i, frame in enumerate(frames):
            out.append(self.process_frame(frame, i))
            if progress_callback and i % 10 == 0:
                progress_callback(int(i / n * 100))

        return out

    def close(self):
        self.pose_detector.close()


# =============================================================================
# CLI for testing
# =============================================================================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python hand_gesture.py <input_video> <audio> [output_video]")
        sys.exit(1)

    inp = sys.argv[1]
    audio = sys.argv[2]
    outp = sys.argv[3] if len(sys.argv) > 3 else inp.replace('.mp4', '_gesture.mp4')

    cap = cv2.VideoCapture(inp)
    fps = int(cap.get(cv2.CAP_PROP_FPS))
    frames = []
    while True:
        ret, f = cap.read()
        if not ret:
            break
        frames.append(f)
    cap.release()
    print(f"Loaded {len(frames)} frames @ {fps}fps")

    proc = GestureProcessor(static_image=frames[0])
    out_frames = proc.process_video_frames(frames, fps=fps, audio_path=audio)
    proc.close()

    h, w = out_frames[0].shape[:2]
    temp_avi = outp.replace('.mp4', '_temp.avi')
    fourcc = cv2.VideoWriter_fourcc(*'DIVX')
    out = cv2.VideoWriter(temp_avi, fourcc, fps, (w, h))
    for f in out_frames:
        out.write(f)
    out.release()

    subprocess.call(
        f'ffmpeg -y -i "{temp_avi}" -i "{audio}" -c:v libx264 -crf 18 '
        f'-pix_fmt yuv420p -c:a aac -b:a 128k -shortest "{outp}"',
        shell=True
    )
    try:
        os.remove(temp_avi)
    except:
        pass
    print(f"Done! Output: {outp}")
