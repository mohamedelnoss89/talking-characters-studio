"""
Head Movement Module (Professional)
====================================
يضيف حركة رأس طبيعية (sway + micro-movements + nods + tilt) لإطارات
Wav2Lip الناتجة.

الاستراتيجية:
1. نكشف منطقة الوجه مرة واحدة على الصورة الأصلية (MediaPipe FaceLandmarker)
2. نولّد "خطة حركة" للفيديو كله:
   - Sway دوري بطيء (يمين/يسار) كل 3-6 ثواني
   - Micro-movements مستمرة (±1-2px) للحيوية
   - Nods عند فترات الصمت (نهايات الجمل)
   - Tilt بسيط أحياناً (إمالة بزاوية صغيرة)
3. لكل إطار، نطبّق warpAffine على منطقة الوجه بـ translation + rotation
4. ندمج مع feathered mask للحواف الناعمة (عشان الخلفية تفضل ثابتة)

ملاحظات هامة:
- الحركة بسيطة (±3-5px translation, ±2° rotation) عشان ما تكسرش lip sync
- الوجه كله يتحرك كـ unit، فالشفايف المتحركة من Wav2Lip تتحرك معاه بشكل طبيعي
- نطبّق الحركة على bounding box واسع (مع padding كبير) ونخفّ الحواف
- نستخدم same MediaPipe instance من eye_blink.py لو متاح
"""

import os
import cv2
import math
import numpy as np
from typing import List, Tuple, Optional, Dict

# Reuse mediapipe (same as eye_blink.py)
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
    print("[head_movement] WARNING: mediapipe not available, head movement disabled")

# Face landmarker path (same as eye_blink.py)
_FACE_LANDMARKER_PATH = os.environ.get(
    'FACE_LANDMARKER_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 '..', 'public', 'models', 'face_landmarker.task')
)

# Face oval indices (MediaPipe FaceMesh 478) - حدود الوجه الخارجية
FACE_OVAL_INDICES = [
    10, 151, 9, 8, 12, 55, 65, 52, 53, 46,
    116, 117, 118, 119, 120, 121, 128, 126, 142, 36, 205,
    187, 207, 216, 92, 186, 57, 43, 106, 91, 102, 182,
    106, 143, 36, 101, 50, 205, 36, 142, 128, 121, 120, 119, 118, 117, 116,
    # chin and jaw
    152, 148, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
    33, 246, 161, 160, 159, 158, 157, 173,
    398, 384, 385, 386, 387, 388, 466, 263, 299, 297, 332, 284, 251, 389, 356, 454,
    323, 361, 288, 397, 365, 379, 378, 400, 377, 152,
]

# Simpler jaw + face contour (cleaner)
FACE_CONTOUR = [
    # top of forehead (left to right)
    10, 151, 9, 8, 12,
    # right side (top to bottom) - face's right = our left
    55, 65, 52, 53, 46, 116, 117, 118, 119, 120, 121, 128, 126,
    # chin (right to left)
    142, 36, 205, 187, 207, 216, 92, 186, 57, 43, 106, 91, 102, 182, 143, 101,
    # left side (bottom to top) - face's left = our right
    50, 205, 165, 398, 384, 385, 386, 387, 388, 466,
]


def get_face_bounds(landmarks, img_w, img_h, padding_ratio=0.30) -> Tuple[int, int, int, int]:
    """
    يحسب bounding box للوجه بـ padding كبير.

    Returns: (x_min, y_min, x_max, y_max)
    """
    pts = np.array([(landmarks[i].x * img_w, landmarks[i].y * img_h)
                    for i in FACE_OVAL_INDICES if i < len(landmarks)])
    if len(pts) == 0:
        # fallback: استخدم كل المعالم
        pts = np.array([(lm.x * img_w, lm.y * img_h) for lm in landmarks])

    x_min, y_min = pts.min(axis=0)
    x_max, y_max = pts.max(axis=0)

    w = x_max - x_min
    h = y_max - y_min

    # padding كبير عشان نضمّ الحاجب والذقن والشعر
    pad_x = int(w * padding_ratio)
    pad_y_top = int(h * padding_ratio * 0.8)   # أقل فوق (عشان الشعر ما يتحركش)
    pad_y_bot = int(h * padding_ratio * 0.7)

    x_min = max(0, int(x_min - pad_x))
    x_max = min(img_w, int(x_max + pad_x))
    y_min = max(0, int(y_min - pad_y_top))
    y_max = min(img_h, int(y_max + pad_y_bot))

    return x_min, y_min, x_max, y_max


def build_feathered_mask(h: int, w: int, feather_ratio: float = 0.25) -> np.ndarray:
    """
    يبني قناع ناعم الحواف للدمج - أقوى في الوسط، يتلاشى عند الحواف.
    """
    # ابدأ بقناع أبيض كامل
    mask = np.ones((h, w), dtype=np.float32)

    # Feathered edges - ارسم تدرّج من الحواف للداخل
    feather = max(5, int(min(h, w) * feather_ratio))

    # بناء gradient 1D للحواف الأفقية والرأسية
    grad = np.linspace(0, 1, feather, dtype=np.float32)

    # vertical gradient (top + bottom)
    # top: grad from 0 to 1 (first `feather` rows)
    # bottom: same but flipped
    mask_v = np.ones((h,), dtype=np.float32)
    mask_v[:feather] = grad
    mask_v[h - feather:] = np.minimum(mask_v[h - feather:], grad[::-1])
    # horizontal gradient
    mask_h = np.ones((w,), dtype=np.float32)
    mask_h[:feather] = grad
    mask_h[w - feather:] = np.minimum(mask_h[w - feather:], grad[::-1])

    # combine: outer product gives 2D feather
    mask = np.outer(mask_v, mask_h)

    # Gaussian blur إضافي للنعومة
    blur_size = max(7, feather)
    if blur_size % 2 == 0:
        blur_size += 1
    mask = cv2.GaussianBlur(mask, (blur_size, blur_size), 0)
    return np.clip(mask, 0, 1)


# =============================================================================
# خطة الحركة - توليد قيم الحركة لكل إطار
# =============================================================================

class MovementPlan:
    """خطة حركة الرأس للفيديو كله."""

    def __init__(self, num_frames: int, fps: int = 25,
                 audio_pauses: Optional[List[int]] = None,
                 intensity: float = 1.0,
                 seed: Optional[int] = None):
        """
        Args:
            num_frames: عدد الإطارات
            fps: معدل الإطارات
            audio_pauses: قائمة بـ frame indices للفترات الصامتة
            intensity: شدة الحركة (0.5 = خفيفة، 1.0 = عادية، 1.5 = قوية)
            seed: عشوائي seed
        """
        self.num_frames = num_frames
        self.fps = fps
        self.intensity = max(0.1, min(2.0, intensity))
        self.rng = np.random.default_rng(seed if seed is not None else 42)

        # لو فيه audio_pauses، نستخدمها للـ nods
        self.audio_pauses = sorted(audio_pauses or [])

        # ابدأ الـ plan
        self.translations: List[Tuple[float, float]] = []  # (dx, dy) لكل إطار
        self.rotations: List[float] = []                    # angle (degrees) لكل إطار
        self._build_plan()

    def _build_plan(self):
        """يبني خطة الحركة الكاملة."""
        n = self.num_frames
        I = self.intensity

        # --- 1. Sway الأساسي (حركة أفقية بطيئة دورية) ---
        # Frequency: 0.15-0.35 Hz (فترة 3-6 ثواني ذهاب وإياب)
        sway_freq = self.rng.uniform(0.15, 0.30)
        sway_phase = self.rng.uniform(0, 2 * math.pi)
        # Amplitude: ±3-6px (scaled by intensity)
        sway_amp_x = self.rng.uniform(3.0, 6.0) * I
        sway_amp_y = self.rng.uniform(0.5, 1.5) * I  # أقل في الـ y

        # --- 2. Micro-movements (اهتزاز صغير مستمر) ---
        # 1-2px على مدى إطارات قصيرة (1-2 ثانية)
        micro_freq_x = self.rng.uniform(0.8, 1.5)
        micro_freq_y = self.rng.uniform(0.6, 1.2)
        micro_phase_x = self.rng.uniform(0, 2 * math.pi)
        micro_phase_y = self.rng.uniform(0, 2 * math.pi)
        micro_amp = self.rng.uniform(0.8, 1.5) * I

        # --- 3. Drift (انجراف بطيء جداً للـ baseline) ---
        # يحاكي الحركة التلقائية للجسم
        drift_freq = self.rng.uniform(0.05, 0.10)
        drift_phase = self.rng.uniform(0, 2 * math.pi)
        drift_amp = self.rng.uniform(1.0, 2.0) * I

        # --- 4. Nods (تنقيق عند pauses) ---
        # في كل pause، نعمل nod صغير (dy للأعلى ثم للأسفل)
        nods = self._plan_nods()

        # --- 5. Tilt (إمالة دورية) ---
        # زاوية دوران بسيطة ±1-2°
        tilt_freq = self.rng.uniform(0.10, 0.20)
        tilt_phase = self.rng.uniform(0, 2 * math.pi)
        tilt_amp = self.rng.uniform(0.8, 1.5) * I  # degrees

        # --- ادمج كل الحركات ---
        t = np.arange(n) / self.fps

        for i, ti in enumerate(t):
            # Sway (sinusoidal)
            dx_sway = sway_amp_x * math.sin(2 * math.pi * sway_freq * ti + sway_phase)
            dy_sway = sway_amp_y * math.sin(2 * math.pi * sway_freq * ti + sway_phase + 0.3)

            # Micro-movements
            dx_micro = micro_amp * math.sin(2 * math.pi * micro_freq_x * ti + micro_phase_x)
            dy_micro = micro_amp * math.sin(2 * math.pi * micro_freq_y * ti + micro_phase_y)

            # Drift
            dx_drift = drift_amp * math.sin(2 * math.pi * drift_freq * ti + drift_phase)
            dy_drift = drift_amp * 0.5 * math.cos(2 * math.pi * drift_freq * ti + drift_phase)

            # Nod contribution
            dx_nod, dy_nod = nods.get(i, (0.0, 0.0))

            # Total
            dx = dx_sway + dx_micro + dx_drift + dx_nod
            dy = dy_sway + dy_micro + dy_drift + dy_nod

            # Rotation (tilt)
            angle = tilt_amp * math.sin(2 * math.pi * tilt_freq * ti + tilt_phase)
            # إضافة tilt صغير يرتبط بـ sway (لما الرأس يميل يمين، يدور شوية برضو)
            angle += sway_amp_x * 0.15 * math.sin(2 * math.pi * sway_freq * ti + sway_phase)

            self.translations.append((dx, dy))
            self.rotations.append(angle)

    def _plan_nods(self) -> Dict[int, Tuple[float, float]]:
        """يولّد nods عند فترات الصمت (audio pauses)."""
        nods = {}
        if not self.audio_pauses:
            # لو مفيش pauses، ضع nods عشوائية قليلة (15% احتمال كل 2-4 ثواني)
            t = 0
            while t < self.num_frames:
                gap = int(self.rng.uniform(2.0, 4.0) * self.fps)
                t += gap
                if t >= self.num_frames:
                    break
                if self.rng.random() < 0.30:
                    nods.update(self._make_nod(t, intensity=0.7 * self.intensity))
            return nods

        # 50% من pauses نعمل nod
        for pause_frame in self.audio_pauses:
            if self.rng.random() < 0.50:
                nods.update(self._make_nod(pause_frame, intensity=0.8 * self.intensity))
        return nods

    def _make_nod(self, center_frame: int, duration_sec: float = 0.5,
                  intensity: float = 1.0) -> Dict[int, Tuple[float, float]]:
        """يولّد nod واحد (حركة رأسية صغيرة)."""
        duration_frames = max(5, int(duration_sec * self.fps))
        half = duration_frames // 2
        nods = {}
        amp = self.rng.uniform(2.0, 4.0) * intensity

        for i in range(-half, half + 1):
            f = center_frame + i
            if 0 <= f < self.num_frames:
                # شكل جرس (Gaussian-like) - dy يمشي للأسفل ثم للأعلى
                t = i / max(1, half)  # -1 to 1
                # nod down then up: -cos(πt) → -1 عند t=0, 0 عند t=±1
                dy = -amp * math.cos(math.pi * t * 0.5)
                # slight forward movement (small dx)
                dx = amp * 0.2 * (1 - t * t)
                nods[f] = (dx, dy)
        return nods

    def get_at(self, frame_idx: int) -> Tuple[float, float, float]:
        """يرجع (dx, dy, angle) للإطار."""
        if 0 <= frame_idx < len(self.translations):
            dx, dy = self.translations[frame_idx]
            angle = self.rotations[frame_idx]
            return dx, dy, angle
        return 0.0, 0.0, 0.0


# =============================================================================
# تطبيق الحركة على الإطار
# =============================================================================

class HeadMover:
    """يطبّق حركة الرأس على فيديو Wav2Lip."""

    def __init__(self, static_image: Optional[np.ndarray] = None,
                 intensity: float = 1.0):
        """
        Args:
            static_image: الصورة الأصلية (لاكتشاف الوجه مرة واحدة)
            intensity: شدة الحركة (0.5-2.0)
        """
        self._landmarker = None
        self._landmarker_initialized = False
        self.static_face_bounds: Optional[Tuple[int, int, int, int]] = None
        self.face_mask: Optional[np.ndarray] = None
        self.intensity = intensity
        self._plan: Optional[MovementPlan] = None

        if static_image is not None:
            self._detect_static_face(static_image)

    def _init_landmarker(self):
        """يهيّئ FaceLandmarker مرة واحدة."""
        if self._landmarker_initialized:
            return
        self._landmarker_initialized = True
        if not MEDIAPIPE_AVAILABLE:
            print("[HeadMover] mediapipe not available")
            return
        if not os.path.exists(_FACE_LANDMARKER_PATH):
            print(f"[HeadMover] WARNING: face_landmarker.task not found at {_FACE_LANDMARKER_PATH}")
            return
        try:
            options = mp_vision.FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=_FACE_LANDMARKER_PATH),
                running_mode=mp_vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self._landmarker = mp_vision.FaceLandmarker.create_from_options(options)
            print(f"[HeadMover] FaceLandmarker initialized")
        except Exception as e:
            print(f"[HeadMover] WARNING: failed to init FaceLandmarker: {e}")
            self._landmarker = None

    def _detect_landmarks(self, image: np.ndarray):
        """يكشف معالم الوجه."""
        self._init_landmarker()
        if self._landmarker is None:
            return None
        try:
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = self._landmarker.detect(mp_image)
            if not result.face_landmarks:
                return None
            return result.face_landmarks[0]
        except Exception as e:
            print(f"[HeadMover] detect failed: {e}")
            return None

    def _detect_static_face(self, image: np.ndarray):
        """يكشف حدود الوجه مرة واحدة على الصورة الأصلية."""
        h, w = image.shape[:2]
        landmarks = self._detect_landmarks(image)
        if landmarks is None:
            print("[HeadMover] WARNING: No face detected in static image!")
            # Fallback: استخدم وسط الصورة
            cx, cy = w // 2, h // 2
            face_size = min(w, h) // 2
            self.static_face_bounds = (
                max(0, cx - face_size // 2),
                max(0, cy - face_size // 2 - face_size // 8),
                min(w, cx + face_size // 2),
                min(h, cy + face_size // 2 + face_size // 8),
            )
        else:
            self.static_face_bounds = get_face_bounds(landmarks, w, h, padding_ratio=0.30)
            print(f"[HeadMover] Face bounds: {self.static_face_bounds} (image {w}x{h})")

        # ابنِ قناع النعومة للوجه
        x1, y1, x2, y2 = self.static_face_bounds
        face_h = y2 - y1
        face_w = x2 - x1
        if face_h > 5 and face_w > 5:
            self.face_mask = build_feathered_mask(face_h, face_w, feather_ratio=0.30)
        else:
            print("[HeadMover] WARNING: face region too small, disabling head movement")
            self.static_face_bounds = None

    def close(self):
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception:
                pass
            self._landmarker = None
        self._landmarker_initialized = False

    def apply_to_frame(self, frame: np.ndarray, dx: float, dy: float,
                       angle_deg: float) -> np.ndarray:
        """يطبّق حركة الرأس على إطار واحد."""
        # لو الحركة ضئيلة جداً، نرجع الإطار كما هو
        if abs(dx) < 0.3 and abs(dy) < 0.3 and abs(angle_deg) < 0.2:
            return frame

        if self.static_face_bounds is None or self.face_mask is None:
            return frame

        h, w = frame.shape[:2]
        x1, y1, x2, y2 = self.static_face_bounds

        # وسّع المنطقة عشان نضمّ مساحة للحركة
        # (لو الوجه هيتحرك ±5px، لازم نأخذ منطقة أوسع بـ 10px على الأقل)
        margin = max(8, int(max(abs(dx), abs(dy)) * 2) + 4)
        # قلل من margin لو هيقرب من حدود الصورة
        ex1 = max(0, x1 - margin)
        ey1 = max(0, y1 - margin)
        ex2 = min(w, x2 + margin)
        ey2 = min(h, y2 + margin)

        # خذ منطقة الوجه الموسّعة
        face_region = frame[ey1:ey2, ex1:ex2].copy()
        if face_region.size == 0 or face_region.shape[0] < 5 or face_region.shape[1] < 5:
            return frame

        fr_h, fr_w = face_region.shape[:2]

        # ابنِ مصفوفة التحويل: rotation حول مركز الوجه + translation
        cx_local = (x1 - ex1) + (x2 - x1) / 2  # مركز الوجه بالنسبة للمنطقة الموسّعة
        cy_local = (y1 - ey1) + (y2 - y1) / 2

        angle_rad = math.radians(angle_deg)
        cos_a = math.cos(angle_rad)
        sin_a = math.sin(angle_rad)

        # rotation matrix around (cx_local, cy_local) + translation
        # M = R * T (rotate first, then translate)
        M = np.float32([
            [cos_a, -sin_a, dx + cx_local * (1 - cos_a) + cy_local * sin_a],
            [sin_a,  cos_a, dy - cx_local * sin_a + cy_local * (1 - cos_a)],
        ])

        # طبّق warp
        warped = cv2.warpAffine(
            face_region, M, (fr_w, fr_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT
        )

        # خذ قناع الوجه الأصلي وكبّره للمنطقة الموسّعة
        # أولاً، خذ الـ mask الأصلية (لمنطقة الوجه الأصلي)
        face_h_orig = y2 - y1
        face_w_orig = x2 - x1
        if self.face_mask.shape != (face_h_orig, face_w_orig):
            # لو الـ mask اتبنت مرة واحدة على الـ static bounds
            pass

        # ابنِ mask للمنطقة الموسّعة
        full_mask = np.zeros((fr_h, fr_w), dtype=np.float32)
        # مكان الوجه الأصلي بالنسبة للمنطقة الموسّعة
        ox1 = x1 - ex1
        oy1 = y1 - ey1
        ox2 = x2 - ex1
        oy2 = y2 - ey1

        # لو الـ mask المحفوظة بنفس مقاس الوجه الأصلي
        if self.face_mask.shape == (face_h_orig, face_w_orig):
            try:
                full_mask[oy1:oy2, ox1:ox2] = self.face_mask
            except ValueError:
                # لو فيه mismatch بسبب clipping
                mh, mw = self.face_mask.shape
                full_mask[oy1:oy1 + mh, ox1:ox1 + mw] = self.face_mask[:min(mh, fr_h - oy1), :min(mw, fr_w - ox1)]
        else:
            # fallback: مباشرة ابنِ mask على المنطقة الموسّعة
            full_mask = build_feathered_mask(fr_h, fr_w, feather_ratio=0.25)

        # Smooth الـ mask كمان
        blur = max(5, min(fr_h, fr_w) // 6)
        if blur % 2 == 0:
            blur += 1
        full_mask = cv2.GaussianBlur(full_mask, (blur, blur), 0)

        # إضافة vignette إضافي عند حواف المنطقة الموسّعة (عشان الـ border_reflect
        # ما يبقاش واضح)
        edge_fade = max(4, margin // 2)
        for i in range(edge_fade):
            alpha = i / edge_fade
            full_mask[i, :] = np.minimum(full_mask[i, :], alpha)
            full_mask[fr_h - 1 - i, :] = np.minimum(full_mask[fr_h - 1 - i, :], alpha)
            full_mask[:, i] = np.minimum(full_mask[:, i], alpha)
            full_mask[:, fr_w - 1 - i] = np.minimum(full_mask[:, fr_w - 1 - i], alpha)

        # ادمج
        mask_3ch = full_mask[:, :, np.newaxis]
        result = frame.copy()
        blended = (face_region.astype(np.float32) * (1 - mask_3ch) +
                   warped.astype(np.float32) * mask_3ch).astype(np.uint8)
        result[ey1:ey2, ex1:ex2] = blended

        return result

    def process_video_frames(self, frames: List[np.ndarray],
                             fps: int = 25,
                             audio_path: Optional[str] = None,
                             progress_callback=None) -> List[np.ndarray]:
        """يطبّق حركة الرأس على كل الإطارات."""
        n = len(frames)
        if n == 0:
            return frames

        if self.static_face_bounds is None and len(frames) > 0:
            print("[HeadMover] Detecting face from first frame...")
            self._detect_static_face(frames[0])

        if self.static_face_bounds is None:
            print("[HeadMover] No face available, skipping head movement.")
            return frames

        # اكتشف pauses (لو فيه صوت)
        audio_pauses = []
        if audio_path:
            try:
                from eye_blink import find_audio_pauses
                audio_pauses = find_audio_pauses(audio_path, fps=fps)
                print(f"[HeadMover] Using {len(audio_pauses)} audio pauses for nod sync")
            except ImportError:
                print("[HeadMover] eye_blink.find_audio_pauses not available, skipping nod sync")

        # ابنِ خطة الحركة
        self._plan = MovementPlan(
            num_frames=n,
            fps=fps,
            audio_pauses=audio_pauses,
            intensity=self.intensity,
        )

        print(f"[HeadMover] Head movement plan: {n} frames, "
              f"intensity={self.intensity}, "
              f"sway range=[{min(t[0] for t in self._plan.translations):.1f},"
              f"{max(t[0] for t in self._plan.translations):.1f}]px, "
              f"tilt range=[{min(self._plan.rotations):.2f},"
              f"{max(self._plan.rotations):.2f}]°")

        out = []
        for i, frame in enumerate(frames):
            dx, dy, angle = self._plan.get_at(i)
            if abs(dx) > 0.2 or abs(dy) > 0.2 or abs(angle) > 0.15:
                out.append(self.apply_to_frame(frame, dx, dy, angle))
            else:
                out.append(frame)

            if progress_callback and i % 10 == 0:
                progress_callback(int(i / n * 100))

        return out


# =============================================================================
# Test harness
# =============================================================================

if __name__ == "__main__":
    import sys
    import tempfile
    import subprocess

    if len(sys.argv) < 2:
        print("Usage: python head_movement.py <input_video> [output_video]")
        sys.exit(1)

    inp = sys.argv[1]
    outp = sys.argv[2] if len(sys.argv) > 2 else inp.replace('.mp4', '_head.mp4')

    print(f"[Test] Loading {inp}...")
    cap = cv2.VideoCapture(inp)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {inp}")
    fps = int(cap.get(cv2.CAP_PROP_FPS)) or 25
    frames = []
    while True:
        ret, f = cap.read()
        if not ret:
            break
        frames.append(f)
    cap.release()
    print(f"[Test] Loaded {len(frames)} frames @ {fps}fps")

    mover = HeadMover(intensity=1.0)
    out_frames = mover.process_video_frames(frames, fps=fps, audio_path=inp)
    mover.close()

    # Save
    h, w = out_frames[0].shape[:2]
    temp_avi = outp.replace('.mp4', '_temp.avi')
    fourcc = cv2.VideoWriter_fourcc(*'DIVX')
    out = cv2.VideoWriter(temp_avi, fourcc, fps, (w, h))
    for f in out_frames:
        out.write(f)
    out.release()

    # Extract audio
    temp_audio = tempfile.mktemp(suffix='.wav')
    subprocess.run(['ffmpeg', '-y', '-i', inp, '-vn', temp_audio],
                   capture_output=True)

    # Merge
    subprocess.run([
        'ffmpeg', '-y',
        '-i', temp_avi, '-i', temp_audio,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', outp
    ], capture_output=True)

    try:
        os.remove(temp_avi)
        os.remove(temp_audio)
    except:
        pass

    print(f"[Test] Done! Output: {outp}")
