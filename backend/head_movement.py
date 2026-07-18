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
import shutil
import subprocess
import numpy as np
from typing import List, Tuple, Optional, Dict


def _resolve_ffmpeg():
    """
    Resolve the ffmpeg binary path. Same logic as wav2lip_runner._resolve_ffmpeg.
    Priority: WAV2LIP_FFMPEG_PATH → FFMPEG_PATH → shutil.which("ffmpeg") → "ffmpeg".
    Needed on the desktop app where ffmpeg is bundled in resources/bin/ but
    not in the user's PATH.
    """
    for c in (
        os.environ.get("WAV2LIP_FFMPEG_PATH"),
        os.environ.get("FFMPEG_PATH"),
        shutil.which("ffmpeg"),
    ):
        if c and os.path.isfile(c):
            return c
    return "ffmpeg"

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
# تحليل الصوت - حساب الـ envelope (RMS energy لكل إطار)
# =============================================================================

def compute_audio_envelope(audio_path: str, num_frames: int, fps: int = 25) -> np.ndarray:
    """
    يحسب audio envelope: RMS energy لكل إطار فيديو.

    الـ envelope ده نستخدمه لتضخيم حركة الرأس لما الصوت يكون عالي
    (الكلام نشط)، وتهدئتها لما الصوت يكون هادي (سكتة).

    Args:
        audio_path: مسار ملف الصوت
        num_frames: عدد إطارات الفيديو
        fps: معدل الإطارات
    Returns:
        ndarray shape (num_frames,) - قيم بين 0 (ساكت) و 1 (أعلى طاقة)
    """
    try:
        import librosa
    except ImportError:
        raise RuntimeError("librosa not available for audio envelope")

    # اقرأ الصوت (librosa بيرجّع mono تلقائياً)
    y, sr = librosa.load(audio_path, sr=16000, mono=True)

    if len(y) == 0:
        return np.full(num_frames, 0.3, dtype=np.float32)

    # احسب RMS energy بإطار صغير (hop_length = 256 عينة ≈ 16ms عند 16kHz)
    hop = 256
    frame_length = 512
    rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop)[0]

    # أزمنة الـ RMS frames
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)

    # أزمنة إطارات الفيديو
    video_times = np.arange(num_frames) / fps

    # interp الـ RMS لإطارات الفيديو
    envelope = np.interp(video_times, rms_times, rms).astype(np.float32)

    # normalize: استخدم percentile 90 كـ "أعلى صوت عادي" (تجنب الـ peaks)
    p90 = float(np.percentile(envelope, 90)) if len(envelope) > 0 else 1.0
    if p90 > 1e-6:
        envelope = envelope / p90
    envelope = np.clip(envelope, 0.0, 1.0)

    # smooth بسيط عشان نتجنّب الـ jitter السريع
    smooth_win = max(3, int(0.15 * fps))  # 150ms
    if smooth_win > 1 and len(envelope) > smooth_win:
        kernel = np.ones(smooth_win, dtype=np.float32) / smooth_win
        pad = smooth_win // 2
        padded = np.pad(envelope, (pad, pad), mode='edge')
        envelope = np.convolve(padded, kernel, mode='valid')[:len(envelope)]
        envelope = np.clip(envelope, 0.0, 1.0)

    return envelope


# =============================================================================
# خطة الحركة - توليد قيم الحركة لكل إطار
# =============================================================================

class MovementPlan:
    """خطة حركة الرأس للفيديو كله - طبيعية ومتصلة بالكلام.

    فلسفة الحركة الطبيعية:
    - معظم الوقت الوجه شبه ثابت (micro-movements ±0.3px فقط)
    - حركة حقيقية بتحصل في لحظات معينة (بداية جمل، accents، pauses)
    - الصوت العالي = حركة أكبر (audio-driven envelope)
    - فترات راحة (rest periods) الوجه فيها ثابت تماماً
    - مفيش sway مستمر ولا tilt مستمر - دول اللي بيخلو الراس "بترقص"
    """

    def __init__(self, num_frames: int, fps: int = 25,
                 audio_pauses: Optional[List[int]] = None,
                 intensity: float = 1.0,
                 audio_envelope: Optional[np.ndarray] = None,
                 seed: Optional[int] = None):
        """
        Args:
            num_frames: عدد الإطارات
            fps: معدل الإطارات
            audio_pauses: قائمة بـ frame indices للفترات الصامتة
            intensity: شدة الحركة (0.5 = خفيفة، 1.0 = عادية، 1.5 = قوية)
            audio_envelope: قيمة RMS energy لكل إطار (0-1) - لتضخيم الحركة مع الكلام
            seed: عشوائي seed
        """
        self.num_frames = num_frames
        self.fps = fps
        self.intensity = max(0.1, min(2.0, intensity))
        self.rng = np.random.default_rng(seed if seed is not None else 42)

        # لو فيه audio_pauses، نستخدمها للـ nods
        self.audio_pauses = sorted(audio_pauses or [])

        # audio envelope (RMS energy per frame, normalized 0-1)
        # لو مش متاح، نستخدم envelope ثابت = 0.5
        if audio_envelope is not None and len(audio_envelope) == num_frames:
            self.audio_env = np.asarray(audio_envelope, dtype=np.float32)
        else:
            self.audio_env = np.full(num_frames, 0.5, dtype=np.float32)

        # ابدأ الـ plan
        self.translations: List[Tuple[float, float]] = []  # (dx, dy) لكل إطار
        self.rotations: List[float] = []                    # angle (degrees) لكل إطار
        self._build_plan()

    def _build_plan(self):
        """يبني خطة حركة طبيعية - الحركة أغلبيتها في لحظات معينة، مش مستمرة."""
        n = self.num_frames
        I = self.intensity

        # =========================================================
        # 1. Base layer: micro-movements فقط (±0.3px) - للحيوية
        # =========================================================
        # تردد عالي بس amplitude صغيرة جداً - يحاكي الاهتزاز الطبيعي
        # للراس البشرية الثابتة (مش حركة واضحة، بس يمنع "الجامد الميت")
        base_freq_x = self.rng.uniform(1.5, 2.5)
        base_freq_y = self.rng.uniform(1.2, 2.0)
        base_phase_x = self.rng.uniform(0, 2 * math.pi)
        base_phase_y = self.rng.uniform(0, 2 * math.pi)
        base_amp = 0.3 * I  # ±0.3px فقط - بالكاد ملحوظ

        # =========================================================
        # 2. Slow drift (واحد بس طوال الفيديو، بطيء جداً)
        # =========================================================
        # فترة 20-40 ثانية (0.025-0.05 Hz) - انجراف بطيء جداً للـ baseline
        # ده يحاكي إن الشخص بيغيّر وضعية جسمه ببطء
        drift_freq = self.rng.uniform(0.025, 0.05)
        drift_phase = self.rng.uniform(0, 2 * math.pi)
        drift_amp_x = self.rng.uniform(1.0, 2.0) * I
        drift_amp_y = self.rng.uniform(0.3, 0.8) * I

        # =========================================================
        # 3. Occasional slow sway (حركة بطيئة كل فترة طويلة)
        # =========================================================
        # فترة 8-15 ثانية (0.07-0.12 Hz) - أبطأ بكثير من القديم
        # amplitude صغيرة ±1.5-2.5px فقط
        sway_freq = self.rng.uniform(0.07, 0.12)
        sway_phase = self.rng.uniform(0, 2 * math.pi)
        sway_amp_x = self.rng.uniform(1.5, 2.5) * I
        sway_amp_y = self.rng.uniform(0.2, 0.5) * I

        # =========================================================
        # 4. Nods + head turns + tilts عند audio pauses (الحركة الحقيقية)
        # =========================================================
        # عند كل pause (بداية جملة): 45% nod، 25% turn، 15% tilt، 15% لا حركة
        motion_events = self._plan_motion_events()

        # =========================================================
        # 5. Rest periods (الوجه ثابت تماماً)
        # =========================================================
        # 25-35% من الفيديو، الوجه ثابت. كل rest period 1-3 ثواني.
        rest_mask = self._plan_rest_periods(coverage=0.30)

        # =========================================================
        # ادمج كل الطبقات
        # =========================================================
        t = np.arange(n) / self.fps

        # Audio envelope (smoothed) - نستخدمها لتضخيم الحركة لما الصوت عالي
        # لكن مش بنضربها في الـ base (عشان لو ساكت، الوجه يفضل ثابت تقريباً)
        audio_smooth = self._smooth_envelope(self.audio_env, window=int(0.3 * self.fps))

        for i, ti in enumerate(t):
            # Base micro-movement (دائم بس صغير)
            dx_base = base_amp * math.sin(2 * math.pi * base_freq_x * ti + base_phase_x)
            dy_base = base_amp * math.sin(2 * math.pi * base_freq_y * ti + base_phase_y)

            # Drift (بطيء جداً)
            dx_drift = drift_amp_x * math.sin(2 * math.pi * drift_freq * ti + drift_phase)
            dy_drift = drift_amp_y * math.cos(2 * math.pi * drift_freq * ti + drift_phase)

            # Sway (بطيء)
            dx_sway = sway_amp_x * math.sin(2 * math.pi * sway_freq * ti + sway_phase)
            dy_sway = sway_amp_y * math.sin(2 * math.pi * sway_freq * ti + sway_phase + 0.3)

            # Motion events (nods + turns + tilts) - الحركة الواضحة
            dx_event, dy_event, angle_event = motion_events.get(i, (0.0, 0.0, 0.0))

            # Audio envelope: ضخّم الحركة لما الصوت يكون عالي
            # بس ما تضربش في الـ base (عشان لو ساكت، يفضل فيه micro-movement)
            audio_boost = 0.4 + 0.6 * audio_smooth[i]  # 0.4-1.0
            # نطبّق الـ boost على الجزء اللي فوق الـ base فقط
            dx_above_base = dx_drift + dx_sway + dx_event
            dy_above_base = dy_drift + dy_sway + dy_event
            dx = dx_base + dx_above_base * audio_boost
            dy = dy_base + dy_above_base * audio_boost
            angle = angle_event + 0.3 * math.sin(2 * math.pi * sway_freq * ti + sway_phase)
            angle = angle * audio_boost

            # Rest period: خفّف الحركة جداً (بس ابقى الـ base micro)
            if rest_mask[i]:
                dx = dx_base * 0.5  # فقط نصف الـ micro
                dy = dy_base * 0.5
                angle = 0.0

            self.translations.append((dx, dy))
            self.rotations.append(angle)

    def _plan_motion_events(self) -> Dict[int, Tuple[float, float, float]]:
        """
        يولّد أحداث الحركة الحقيقية (nods + turns + tilts) عند audio pauses.
        دي الحركة الواضحة اللي بتحسس إن الراس بتتحرك طبيعي مع الكلام.
        """
        events: Dict[int, Tuple[float, float, float]] = {}
        if not self.audio_pauses:
            # لو مفيش pauses، ضع أحداث نادرة (كل 4-8 ثواني)
            t = 0
            while t < self.num_frames:
                gap = int(self.rng.uniform(4.0, 8.0) * self.fps)
                t += gap
                if t >= self.num_frames:
                    break
                # 40% احتمال حدث
                if self.rng.random() < 0.40:
                    self._add_event_at(events, t)
            return events

        # عند كل pause: نختار نوع الحركة
        for pause_frame in self.audio_pauses:
            r = self.rng.random()
            if r < 0.45:
                # Nod (تنقيق) - الحركة الأكثر شيوعاً
                self._add_nod(events, pause_frame)
            elif r < 0.70:
                # Head turn (يلتف يمين أو يسار شوية)
                self._add_turn(events, pause_frame)
            elif r < 0.85:
                # Tilt (إمالة جانبية)
                self._add_tilt(events, pause_frame)
            # 15% لا حركة (السكتة الطبيعية بدون رد فعل)

        return events

    def _add_nod(self, events: dict, center: int, duration_sec: float = 0.6):
        """يضيف nod (حركة رأسية) عند بداية جملة."""
        dur = max(8, int(duration_sec * self.fps))
        half = dur // 2
        amp_y = self.rng.uniform(2.5, 4.5) * self.intensity
        amp_x = self.rng.uniform(0.5, 1.0) * self.intensity  # slight forward

        for i in range(-half, half + 1):
            f = center + i
            if 0 <= f < self.num_frames:
                t = i / max(1, half)  # -1 to 1
                # Smooth bell: -cos(πt/2) → 0 at edges, -1 at center
                dy = -amp_y * math.cos(math.pi * t * 0.5)
                dx = amp_x * (1 - t * t)
                # blend with existing event (لو فيه)
                ex, ey, ea = events.get(f, (0.0, 0.0, 0.0))
                events[f] = (ex + dx, ey + dy, ea)

    def _add_turn(self, events: dict, center: int, duration_sec: float = 0.8):
        """يضيف head turn (التفاف يمين/يسار) عند بداية جملة."""
        dur = max(10, int(duration_sec * self.fps))
        half = dur // 2
        # direction عشوائي
        direction = 1 if self.rng.random() < 0.5 else -1
        amp_x = direction * self.rng.uniform(3.0, 5.0) * self.intensity
        # slight angle مع الـ turn
        angle_amp = direction * self.rng.uniform(0.5, 1.0) * self.intensity

        for i in range(-half, half + 1):
            f = center + i
            if 0 <= f < self.num_frames:
                t = i / max(1, half)  # -1 to 1
                # Smoothstep: 3t² - 2t³ → 0 at edges, 1 at center
                # Use -cos for asymmetric turn (faster out, slower back)
                envelope = math.cos(math.pi * t * 0.5)  # 0 at edges, 1 at center
                dx = amp_x * envelope
                angle = angle_amp * envelope
                ex, ey, ea = events.get(f, (0.0, 0.0, 0.0))
                events[f] = (ex + dx, ey, ea + angle)

    def _add_tilt(self, events: dict, center: int, duration_sec: float = 0.7):
        """يضيف tilt (إمالة جانبية بسيطة) - الزاوية فقط."""
        dur = max(8, int(duration_sec * self.fps))
        half = dur // 2
        direction = 1 if self.rng.random() < 0.5 else -1
        angle_amp = direction * self.rng.uniform(1.5, 2.5) * self.intensity

        for i in range(-half, half + 1):
            f = center + i
            if 0 <= f < self.num_frames:
                t = i / max(1, half)
                envelope = math.cos(math.pi * t * 0.5)
                angle = angle_amp * envelope
                ex, ey, ea = events.get(f, (0.0, 0.0, 0.0))
                events[f] = (ex, ey, ea + angle)

    def _add_event_at(self, events: dict, center: int):
        """يضيف حدث عشوائي نادر (لو مفيش audio pauses)."""
        r = self.rng.random()
        if r < 0.5:
            self._add_nod(events, center)
        elif r < 0.8:
            self._add_turn(events, center)
        else:
            self._add_tilt(events, center)

    def _plan_rest_periods(self, coverage: float = 0.30) -> np.ndarray:
        """
        يولّد rest periods (الوجه ثابت تماماً).

        Args:
            coverage: نسبة الإطارات اللي تكون rest (0.30 = 30%)
        Returns:
            boolean array, True = rest frame
        """
        rest = np.zeros(self.num_frames, dtype=bool)
        target_rest_frames = int(self.num_frames * coverage)
        placed = 0
        attempts = 0

        while placed < target_rest_frames and attempts < 100:
            attempts += 1
            # ضع rest period بمدة 1-3 ثانية
            dur = int(self.rng.uniform(1.0, 3.0) * self.fps)
            start = int(self.rng.integers(0, max(1, self.num_frames - dur)))
            # متضعش rest لو في motion event قريب (نحتفظ بالـ pauses للحركة)
            # بنفحص لو فيه audio pause في النطاق ده
            has_pause_near = any(
                abs(start + dur // 2 - p) < int(1.5 * self.fps)
                for p in self.audio_pauses
            )
            if has_pause_near:
                continue
            # امسح أي rest موجود قبل كده في النطاق (تجنب التداخل)
            if not rest[start:start + dur].any():
                rest[start:start + dur] = True
                placed += dur

        return rest

    def _smooth_envelope(self, env: np.ndarray, window: int = 8) -> np.ndarray:
        """يعمل smoothing للـ envelope (moving average)."""
        if window < 2:
            return env
        # استخدام cumulative sum لحساب moving average بسرعة
        kernel = np.ones(window, dtype=np.float32) / window
        # same padding
        pad = window // 2
        padded = np.pad(env, (pad, pad), mode='edge')
        smoothed = np.convolve(padded, kernel, mode='valid')
        # ضبط الطول
        if len(smoothed) > len(env):
            smoothed = smoothed[:len(env)]
        elif len(smoothed) < len(env):
            smoothed = np.pad(smoothed, (0, len(env) - len(smoothed)), mode='edge')
        return smoothed

    def get_at(self, frame_idx: int) -> Tuple[float, float, float]:
        """يرجع (dx, dy, angle) للإطار."""
        if 0 <= frame_idx < len(self.translations):
            dx, dy = self.translations[frame_idx]
            angle = self.rotations[frame_idx]
            return dx, dy, angle
        return 0.0, 0.0, 0.0

    def stats(self) -> dict:
        """يرجع إحصائيات الحركة (للdebug/التحقق)."""
        if not self.translations:
            return {}
        dx_arr = np.array([t[0] for t in self.translations])
        dy_arr = np.array([t[1] for t in self.translations])
        ang_arr = np.array(self.rotations)
        # نسبة الإطارات شبه الثابتة (|dx| < 0.5)
        rest_ratio = float(np.mean(np.abs(dx_arr) < 0.5))
        return {
            'dx_min': float(dx_arr.min()), 'dx_max': float(dx_arr.max()),
            'dy_min': float(dy_arr.min()), 'dy_max': float(dy_arr.max()),
            'angle_min': float(ang_arr.min()), 'angle_max': float(ang_arr.max()),
            'rest_ratio': rest_ratio,
            'mean_motion': float(np.mean(np.sqrt(dx_arr**2 + dy_arr**2))),
        }


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
        # clean_plate: الصورة الأصلية بعد مسح الوجه (للخلفية النظيفة)
        # ضروري لتجنّب الـ ghosting/double head عند تحريك الوجه
        self.clean_plate: Optional[np.ndarray] = None
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
            return

        # ============= CRITICAL: ابنِ clean background plate =============
        # نستخدم cv2.inpaint لمسح الوجه من الصورة الأصلية، فتبقى الخلفية
        # نظيفة بدون وجه. لما نحرّك الوجه ونركّبه فوقها، مش هيظهر وجه
        # قديم تحت الوجه المتحرك (ده اللي بيسبب الـ ghosting/double head).
        self._build_clean_plate(image)

    def close(self):
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception:
                pass
            self._landmarker = None
        self._landmarker_initialized = False

    def _build_clean_plate(self, image: np.ndarray):
        """
        يبني 'clean background plate' بمسح الوجه من الصورة الأصلية باستخدام
        cv2.inpaint. النتيجة: نفس الصورة بس بدون وجه (الخلفية فقط).

        لما نركّب الوجه المتحرك فوق هذه الخلفية النظيفة، مش هيظهر وجه
        قديم تحته - ده اللي بيلغي مشكلة الـ ghosting/double head.
        """
        h, w = image.shape[:2]
        x1, y1, x2, y2 = self.static_face_bounds

        # ابنِ mask تغطّي منطقة الوجه (مع shrink بسيط عشان نخلي حواف ناعمة)
        inpaint_mask = np.zeros((h, w), dtype=np.uint8)
        # Shrink الـ bounds بشوية عشان inpaint ياخد context كافي من حوله
        shrink = max(2, int(min(x2 - x1, y2 - y1) * 0.05))
        ix1, iy1 = x1 + shrink, y1 + shrink
        ix2, iy2 = x2 - shrink, y2 - shrink
        if ix2 <= ix1 or iy2 <= iy1:
            ix1, iy1, ix2, iy2 = x1, y1, x2, y2
        inpaint_mask[iy1:iy2, ix1:ix2] = 255

        # Dilate الـ mask بشوية عشان نضمّ حواف الوجه (شعر، حواجب)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        inpaint_mask = cv2.dilate(inpaint_mask, kernel, iterations=1)

        try:
            # TELEA: أسرع ونتيجته كويسة للمناطق الصغيرة. NS: أكتر دقة بس أبطأ.
            # استخدمنا TELEA عشان السرعة (الفيديو فيه إطارات كتير).
            inpaint_radius = 5
            self.clean_plate = cv2.inpaint(
                image, inpaint_mask, inpaint_radius, cv2.INPAINT_TELEA
            )
            print(f"[HeadMover] Clean plate built ({w}x{h}), face area inpainted")
        except Exception as e:
            print(f"[HeadMover] WARNING: inpaint failed: {e}, using original as clean plate")
            self.clean_plate = image.copy()

    def apply_to_frame(self, frame: np.ndarray, dx: float, dy: float,
                       angle_deg: float) -> np.ndarray:
        """
        يطبّق حركة الرأس على إطار واحد.

        الاستراتيجية الجديدة (بدون ghosting):
        1. نأخذ منطقة موسّعة من الإطار (face + margin)
        2. نأخذ نفس المنطقة من clean_plate (الخلفية بدون وجه)
        3. نعمل warp لمنطقة الإطار (الوجه + الخلفية) بالـ M matrix
        4. نركّب الوجه المتحرك فوق الخلفية النظيفة باستخدام mask
           تغطّي موقع الوجه الجديد (بعد الحركة)
        5. النتيجة: الخلفية النظيفة + الوجه في موضعه الجديد - بدون double head
        """
        # لو الحركة ضئيلة جداً، نرجع الإطار كما هو
        if abs(dx) < 0.3 and abs(dy) < 0.3 and abs(angle_deg) < 0.2:
            return frame

        if self.static_face_bounds is None or self.face_mask is None:
            return frame
        if self.clean_plate is None:
            return frame

        h, w = frame.shape[:2]
        x1, y1, x2, y2 = self.static_face_bounds

        # وسّع المنطقة عشان نضمّ مساحة للحركة + مساحة للـ feathering
        # (لو الوجه هيتحرك ±5px، لازم نأخذ منطقة أوسع بـ 12-15px على الأقل)
        max_shift = max(abs(dx), abs(dy))
        margin = max(12, int(max_shift * 2.5) + 6)
        ex1 = max(0, x1 - margin)
        ey1 = max(0, y1 - margin)
        ex2 = min(w, x2 + margin)
        ey2 = min(h, y2 + margin)

        # خذ المنطقة الموسّعة من الإطار (الوجه + الخلفية حوله) - source
        region_src = frame[ey1:ey2, ex1:ex2].copy()
        if region_src.size == 0 or region_src.shape[0] < 5 or region_src.shape[1] < 5:
            return frame

        # خذ نفس المنطقة من clean_plate (الخلفية النظيفة بدون وجه) - destination
        region_clean = self.clean_plate[ey1:ey2, ex1:ex2].copy()

        fr_h, fr_w = region_src.shape[:2]

        # ابنِ مصفوفة التحويل: rotation حول مركز الوجه + translation
        cx_local = (x1 - ex1) + (x2 - x1) / 2  # مركز الوجه بالنسبة للمنطقة الموسّعة
        cy_local = (y1 - ey1) + (y2 - y1) / 2

        angle_rad = math.radians(angle_deg)
        cos_a = math.cos(angle_rad)
        sin_a = math.sin(angle_rad)

        # rotation matrix around (cx_local, cy_local) + translation
        M = np.float32([
            [cos_a, -sin_a, dx + cx_local * (1 - cos_a) + cy_local * sin_a],
            [sin_a,  cos_a, dy - cx_local * sin_a + cy_local * (1 - cos_a)],
        ])

        # طبّق warp على منطقة الإطار (الوجه + الخلفية حوله)
        # BORDER_REFLECT_101 (وليس REFLECT) - أقل تطرف في الانعكاس
        warped = cv2.warpAffine(
            region_src, M, (fr_w, fr_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT_101
        )

        # ============= ابنِ mask لموقع الوجه الجديد (بعد الحركة) =============
        # mask الأصلية تغطّي موقع الوجه القديم - نعمل warp ليها بنفس M
        # فتبقى تغطّي موقع الوجه الجديد. كده نركّب الوجه المتحرك في موضعه
        # الجديد فوق الخلفية النظيفة، بدون ما الوجه القديم يظهر تحته.
        ox1 = x1 - ex1
        oy1 = y1 - ey1
        ox2 = x2 - ex1
        oy2 = y2 - ey1

        face_h_orig = y2 - y1
        face_w_orig = x2 - x1

        # mask ثنائية (1 = وجه, 0 = خلفية) على المنطقة الموسّعة
        face_mask_bin = np.zeros((fr_h, fr_w), dtype=np.float32)
        if self.face_mask.shape == (face_h_orig, face_w_orig):
            try:
                face_mask_bin[oy1:oy2, ox1:ox2] = self.face_mask
            except ValueError:
                mh, mw = self.face_mask.shape
                face_mask_bin[oy1:oy1 + mh, ox1:ox1 + mw] = \
                    self.face_mask[:min(mh, fr_h - oy1), :min(mw, fr_w - ox1)]
        else:
            face_mask_bin = build_feathered_mask(fr_h, fr_w, feather_ratio=0.25)

        # Smooth الـ mask قبل الـ warp (عشان الحواف تتفيّم بشكل طبيعي)
        pre_blur = max(5, min(fr_h, fr_w) // 10)
        if pre_blur % 2 == 0:
            pre_blur += 1
        face_mask_bin = cv2.GaussianBlur(face_mask_bin, (pre_blur, pre_blur), 0)

        # اعمل warp للـ mask بنفس الـ M (عشان تغطّي موقع الوجه الجديد)
        # BORDER_CONSTANT + borderValue=0: برّ الـ warped face يكون شفاف
        warped_mask = cv2.warpAffine(
            face_mask_bin, M, (fr_w, fr_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0
        )

        # Smooth الـ warped_mask كمان مرة (عشان الحواف النهائية تفضل ناعمة)
        post_blur = max(7, min(fr_h, fr_w) // 8)
        if post_blur % 2 == 0:
            post_blur += 1
        warped_mask = cv2.GaussianBlur(warped_mask, (post_blur, post_blur), 0)
        warped_mask = np.clip(warped_mask, 0, 1)

        # ============= ادمج =============
        # region_clean (الخلفية النظيفة) * (1 - mask) +
        # warped (الوجه المتحرك) * mask
        # =
        # الخلفية النظيفة تظهر برّ الوجه، والوجه المتحرك يظهر في موضعه الجديد
        mask_3ch = warped_mask[:, :, np.newaxis]
        blended = (region_clean.astype(np.float32) * (1 - mask_3ch) +
                   warped.astype(np.float32) * mask_3ch).astype(np.uint8)

        result = frame.copy()
        result[ey1:ey2, ex1:ex2] = blended

        return result

    def process_video_frames(self, frames: List[np.ndarray],
                             fps: int = 25,
                             audio_path: Optional[str] = None,
                             progress_callback=None) -> List[np.ndarray]:
        """يطبّق حركة الرأس على كل الإطارات - حركة طبيعية متصلة بالكلام."""
        n = len(frames)
        if n == 0:
            return frames

        if self.static_face_bounds is None and len(frames) > 0:
            print("[HeadMover] Detecting face from first frame...")
            self._detect_static_face(frames[0])

        if self.static_face_bounds is None:
            print("[HeadMover] No face available, skipping head movement.")
            return frames

        # اكتشف pauses + audio envelope (لو فيه صوت)
        audio_pauses = []
        audio_envelope = None
        if audio_path:
            try:
                from eye_blink import find_audio_pauses
                audio_pauses = find_audio_pauses(audio_path, fps=fps)
                print(f"[HeadMover] Using {len(audio_pauses)} audio pauses for event sync")
            except ImportError:
                print("[HeadMover] eye_blink.find_audio_pauses not available, skipping event sync")

            # احسب audio envelope (RMS energy per frame)
            try:
                audio_envelope = compute_audio_envelope(audio_path, num_frames=n, fps=fps)
                print(f"[HeadMover] Audio envelope computed: "
                      f"min={audio_envelope.min():.2f}, max={audio_envelope.max():.2f}, "
                      f"mean={audio_envelope.mean():.2f}")
            except Exception as e:
                print(f"[HeadMover] WARNING: audio envelope failed: {e}")
                audio_envelope = None

        # ابنِ خطة الحركة (مع audio envelope)
        self._plan = MovementPlan(
            num_frames=n,
            fps=fps,
            audio_pauses=audio_pauses,
            intensity=self.intensity,
            audio_envelope=audio_envelope,
        )

        # اطبع إحصائيات الحركة (للتحقق إنها طبيعية)
        s = self._plan.stats()
        print(f"[HeadMover] Movement plan: {n} frames, intensity={self.intensity}")
        print(f"  dx range:  [{s['dx_min']:.2f}, {s['dx_max']:.2f}]px")
        print(f"  dy range:  [{s['dy_min']:.2f}, {s['dy_max']:.2f}]px")
        print(f"  angle:     [{s['angle_min']:.2f}, {s['angle_max']:.2f}]°")
        print(f"  rest ratio: {s['rest_ratio']*100:.0f}% of frames near-static")
        print(f"  mean motion: {s['mean_motion']:.2f}px/frame")

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
    ffmpeg_bin = _resolve_ffmpeg()
    subprocess.run([ffmpeg_bin, '-y', '-i', inp, '-vn', temp_audio],
                   capture_output=True)

    # Merge
    subprocess.run([
        ffmpeg_bin, '-y',
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
