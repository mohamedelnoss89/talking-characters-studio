"""
Eye Blink Post-Processing Module (v2 - Professional)
=====================================================
يضيف رمش طبيعي للعين على إطارات Wav2Lip الناتجة.

الاستراتيجية v2 (احترافية):
1. كشف معالم الوجه (478 نقطة) باستخدام MediaPipe Face Mesh.
2. تحديد منطقة كل عين + الجفن + الحاجب.
3. تخطيط أوقات الرمش عشوائياً.
4. لكل إطار داخل فترة رمش:
   a. SKIN STRETCH: الجفن العلوي بيمتد للأسفل يغطي العين (ننسخ الجلد من فوق
      العين بطريقة compression، بحيث الجلد العلوي يصير متدلياً على العين).
      هذا يعطي مظهر جفن مغلق بجلد فعلي.
   b. EYELID SHADOW: نضيف ظل خفيف تحت خط الجفن العلوي (اللي نزل) علشان
      يعطي عمق ثلاثي الأبعاد.
   c. LASH LINE: نرسم خط رفيع داكن عند خط إغلاق الجفن (مثل خط الرموش).
   d. ALPHA BLEND: ندمج النتيجة بالتدريج (Gaussian feather) مع الأصلي.
   e. BROW DROP: الحاجب بينزل شوية مع الرمش (حركة طبيعية مصاحبة).

النتيجة: عيون ترمش بشكل واقعي واحترافي فوق فيديو Wav2Lip.
"""

import os
import cv2
import numpy as np
import mediapipe as mp
from typing import List, Tuple, Optional


# =============================================================================
# معالم الوجه في MediaPipe Face Mesh (478 نقطة مع refine_landmarks)
# =============================================================================
# العين اليسرى (يمين المشاهد)
LEFT_EYE_INDICES = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
# العين اليمنى
RIGHT_EYE_INDICES = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]

# الحاجب الأيسر (لإضافة حركة الحاجب)
LEFT_BROW_INDICES = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
# الحاجب الأيمن
RIGHT_BROW_INDICES = [336, 296, 334, 293, 300, 276, 283, 282, 295, 285]


def get_eye_geometry(landmarks, eye_indices, brow_indices, img_w, img_h):
    """
    يحسب الهندسة الكاملة للعين + الجفن + الحاجب.

    Returns: dict with:
        - box: (x_min, y_min, x_max, y_max) bounding box كامل للمعالجة
        - eye_top_y, eye_bot_y, eye_center_y: relative to box
        - brow_top_y: أعلى نقطة في الحاجب (relative)
        - brow_bot_y: أسفل نقطة في الحاجب
        - skin_top_y: أعلى نقطة للجلد فوق العين (نأخذ منها الجفن)
    """
    pts_eye = np.array([(landmarks[i].x * img_w, landmarks[i].y * img_h) for i in eye_indices])
    pts_brow = np.array([(landmarks[i].x * img_w, landmarks[i].y * img_h) for i in brow_indices])

    eye_x_min, eye_y_min = pts_eye.min(axis=0)
    eye_x_max, eye_y_max = pts_eye.max(axis=0)
    eye_h = eye_y_max - eye_y_min
    eye_w = eye_x_max - eye_x_min

    brow_y_min = pts_brow[:, 1].min()
    brow_y_max = pts_brow[:, 1].max()
    brow_x_min = pts_brow[:, 0].min()
    brow_x_max = pts_brow[:, 0].max()

    # البوكس يشمل: من فوق الحاجب بـ 30% لتحت العين بـ 80% من ارتفاع العين
    pad_top = max(5, int((eye_y_min - brow_y_min) * 0.3))
    pad_bot = int(eye_h * 0.8)
    pad_x = int(eye_w * 0.20)

    bx_min = max(0, int(eye_x_min - pad_x))
    bx_max = min(img_w, int(eye_x_max + pad_x))
    by_min = max(0, int(brow_y_min - pad_top))
    by_max = min(img_h, int(eye_y_max + pad_bot))

    # Relative to box
    eye_top_y = eye_y_min - by_min
    eye_bot_y = eye_y_max - by_min
    eye_center_y = (eye_top_y + eye_bot_y) / 2
    brow_top_y = brow_y_min - by_min
    brow_bot_y = brow_y_max - by_min

    # المنطقة بين الحاجب والعين = جلد الجفن العلوي
    skin_top_y = brow_bot_y  # الجلد يبدأ من تحت الحاجب
    skin_bot_y = eye_top_y   # وينتهي عند أعلى العين

    return {
        'box': (bx_min, by_min, bx_max, by_max),
        'eye_top_y': eye_top_y,
        'eye_bot_y': eye_bot_y,
        'eye_center_y': eye_center_y,
        'brow_top_y': brow_top_y,
        'brow_bot_y': brow_bot_y,
        'skin_top_y': skin_top_y,
        'skin_bot_y': skin_bot_y,
        'eye_h': eye_h,
        'eye_w': eye_w,
    }


# =============================================================================
# خوارزمية الرمش المحسّنة
# =============================================================================

def build_skin_stretch_warp(region_h: int, region_w: int,
                             geo: dict,
                             blink_factor: float) -> Tuple[np.ndarray, np.ndarray]:
    """
    يبني خريطة warp (v3) بحيث:
      1. الجفن العلوي بيمتد للأسفل ليغطي العين تدريجياً.
      2. العين تنضغط أفقياً قليلاً عند الإغلاق (طبيعي - الجفون بتقرب حواف العين).
      3. هناك falloff ناعم عند حواف العين لتجنب الحواف الحادة.

    عند blink_factor=1:
      - كل بكسل في العين يأخذ قيمته من أعلى العين (eye_top_y).
      - العين تنضغط أفقياً بنسبة ~12% (الحواف بتقرب للداخل).
      - يعني الجلد العلوي بيتمدد ويغطي العين بالكامل.

    عند blink_factor=0: لا تغيير.
    """
    map_x, map_y = np.meshgrid(np.arange(region_w, dtype=np.float32),
                               np.arange(region_h, dtype=np.float32))

    eye_top_y = geo['eye_top_y']
    eye_bot_y = geo['eye_bot_y']
    eye_center_y = (eye_top_y + eye_bot_y) / 2.0
    eye_h = max(1.0, eye_bot_y - eye_top_y)
    eye_w = geo.get('eye_w', region_w * 0.6)
    eye_cx = region_w / 2.0
    b = float(blink_factor)

    src_y = map_y.copy().astype(np.float32)
    src_x = map_x.copy().astype(np.float32)

    # ===== 1. رأسي: الجفن العلوي يغطي العين =====
    eye_mask = (map_y >= eye_top_y) & (map_y <= eye_bot_y)
    if eye_mask.any():
        y_e = map_y[eye_mask]
        # الجفن العلوي ينزل: البكسل العلوي يظل ثابت، البكسل السفلي يصير من الأعلى
        # مع falloff ناعم (cosine) عند الحواف العلوية والسفلية
        rel = (y_e - eye_top_y) / eye_h  # 0 في الأعلى، 1 في الأسفل
        # falloff: ناعم عند الحواف (لازم يبدأ وينتهي بنعومة)
        falloff = 0.5 - 0.5 * np.cos(np.float32(np.pi) * rel)  # 0→1→smooth
        src_y[eye_mask] = (eye_top_y + (y_e - eye_top_y) * (1.0 - b * falloff)).astype(np.float32)

    # ===== 2. أفقي: العين تنضغط أفقياً عند الإغلاق =====
    # معامل الانضغاط: حتى 12% عند blink_factor=1
    compress_ratio = 0.12 * b
    if compress_ratio > 0.001:
        # وزن الانضغاط: أقوى في وسط العين (y = eye_center_y)، يقل كلما ابتعدنا
        y_dist = np.abs(map_y - eye_center_y) / (eye_h * 1.5)
        y_weight = np.exp(-(y_dist ** 2) * 2.0)  # Gaussian around eye center vertically
        # وزن أفقي: أقوى عند الحواف (الحواف بتقرب للداخل)
        x_dist_from_center = np.abs(map_x - eye_cx) / (eye_w * 0.6 + 1)
        x_weight = np.clip(x_dist_from_center, 0, 1)
        # تطبيق الانضغاط
        shift = compress_ratio * (map_x - eye_cx) * y_weight * x_weight
        src_x = (src_x - shift).astype(np.float32)

    return src_x.astype(np.float32), src_y.astype(np.float32)


def add_iris_darken(region: np.ndarray, geo: dict, blink_factor: float) -> np.ndarray:
    """
    يُخفي القزحية والحدقة تدريجياً مع إغلاق العين.
    عند الإغلاق الجزئي، العين تفقد لون القزحية تدريجياً ويظهر الجفن الداكن.
    هذا يضيف واقعية كبيرة (القزحية لونها بيختفي تحت الجفن).
    """
    if blink_factor < 0.15:
        return region

    h, w = region.shape[:2]
    eye_top_y = geo['eye_top_y']
    eye_bot_y = geo['eye_bot_y']
    eye_center_y = (eye_top_y + eye_bot_y) / 2.0
    eye_h = max(1, eye_bot_y - eye_top_y)
    eye_w = geo.get('eye_w', w * 0.6)
    cx = w // 2

    # دائرة القزحية: في وسط العين، نصف قطرها ~ 35% من عرض العين
    iris_r = max(2, int(eye_w * 0.32))
    iris_y = int(eye_center_y)

    # شدة الإخفاء تزيد مع blink_factor
    darken_strength = 0.45 * blink_factor  # حتى 45% إظلام عند الإغلاق الكامل

    # إنشاء mask دائري للقزحية
    yy, xx = np.ogrid[:h, :w]
    dist = np.sqrt((xx - cx) ** 2 + (yy - iris_y) ** 2)
    iris_mask = np.clip(1.0 - dist / iris_r, 0, 1) ** 1.5
    iris_mask = iris_mask * darken_strength

    # تطبيق: تصغير الإضاءة (multiply)
    result = region.astype(np.float32)
    iris_mask_3ch = iris_mask[:, :, np.newaxis]
    result = result * (1.0 - iris_mask_3ch * 0.6)  # إظلام 60% من القزحية

    return np.clip(result, 0, 255).astype(np.uint8)


def add_eyelid_shadow(region: np.ndarray, geo: dict, blink_factor: float) -> np.ndarray:
    """
    يضيف ظل خفيف تحت خط الجفن العلوي (الذي نزل) لإعطاء عمق.
    الظل يكون أقوى كلما زاد blink_factor.
    """
    if blink_factor < 0.05:
        return region

    h, w = region.shape[:2]
    eye_top_y = geo['eye_top_y']
    eye_bot_y = geo['eye_bot_y']
    eye_h = max(1, eye_bot_y - eye_top_y)

    # موضع الظل: تحت الجفن العلوي مباشرة (الذي نزل لمستوى eye_top_y + (1-b)*eye_h)
    lid_pos = eye_top_y + (1 - blink_factor) * eye_h * 0.5  # موضع الجفن المغلق تقريباً
    shadow_top = int(lid_pos)
    shadow_bot = min(h, int(lid_pos + eye_h * 0.3 * blink_factor))

    if shadow_bot <= shadow_top:
        return region

    # ظل gradient: أقوى في الأعلى، يختفي في الأسفل
    shadow_h = shadow_bot - shadow_top
    gradient = np.linspace(0.25 * blink_factor, 0.0, shadow_h).reshape(-1, 1, 1)

    result = region.copy().astype(np.float32)
    # الظل يكون في وسط العين أفقياً (عند القزحية)
    cx = w // 2
    eye_w = geo.get('eye_w', w * 0.6)
    half_w = int(eye_w * 0.4)
    x1 = max(0, cx - half_w)
    x2 = min(w, cx + half_w)

    # تطبيق gradient أفقي (Gaussian) + رأسي (linear)
    if x2 > x1:
        h_gradient = np.exp(-((np.arange(x2 - x1) - (x2 - x1) / 2) / (half_w * 0.7)) ** 2)
        h_gradient = h_gradient.reshape(1, -1, 1)
        result[shadow_top:shadow_bot, x1:x2] -= gradient * h_gradient * 80.0

    return np.clip(result, 0, 255).astype(np.uint8)


def add_lash_line(region: np.ndarray, geo: dict, blink_factor: float) -> np.ndarray:
    """
    يرسم خط رموش رفيع داكن عند خط إغلاق الجفن (للجفن العلوي الذي نزل).
    """
    if blink_factor < 0.4:
        return region  # الخط يظهر فقط عند الإغلاق الجزئي-الكامل

    h, w = region.shape[:2]
    eye_top_y = geo['eye_top_y']
    eye_bot_y = geo['eye_bot_y']
    eye_h = max(1, eye_bot_y - eye_top_y)

    # موضع خط الرموش
    lid_y = int(eye_top_y + (1 - blink_factor) * eye_h * 0.5)
    if lid_y < 0 or lid_y >= h:
        return region

    result = region.copy()
    cx = w // 2
    eye_w = geo.get('eye_w', w * 0.6)
    half_w = int(eye_w * 0.45)
    x1 = max(0, cx - half_w)
    x2 = min(w, cx + half_w)

    # شدة الخط تزيد مع blink_factor
    darkness = int(80 * blink_factor)
    # الخط يكون أكثر كثافة في الوسط (عند القزحية)
    for x in range(x1, x2):
        dist_from_center = abs(x - cx) / max(1, half_w)
        intensity = darkness * (1 - dist_from_center ** 2)
        result[lid_y, x] = np.clip(result[lid_y, x].astype(np.int32) - int(intensity), 0, 255)
        if lid_y + 1 < h:
            result[lid_y + 1, x] = np.clip(result[lid_y + 1, x].astype(np.int32) - int(intensity * 0.5), 0, 255)

    return result


def apply_brow_drop(region: np.ndarray, geo: dict, blink_factor: float) -> np.ndarray:
    """
    يحرك الحاجب لأسفل قليلاً مع الرمش (حركة طبيعية مصاحبة).
    """
    if blink_factor < 0.05:
        return region

    h, w = region.shape[:2]
    brow_top_y = int(geo['brow_top_y'])
    brow_bot_y = int(geo['brow_bot_y'])
    skin_top_y = int(geo['skin_top_y'])

    # مقدار النزول: حتى 1.5 بكسل عند blink_factor=1
    drop = int(round(1.5 * blink_factor))
    if drop < 1 or brow_bot_y >= skin_top_y:
        return region

    result = region.copy()

    # انسخ منطقة الحاجب وانتقل لأسفل بمقدار drop
    brow_region = region[brow_top_y:brow_bot_y, :].copy()
    new_top = min(brow_top_y + drop, h - brow_region.shape[0])
    new_bot = new_top + brow_region.shape[0]

    if new_bot > h:
        brow_region = brow_region[:h - new_top, :]
        new_bot = h

    if brow_region.shape[0] > 0:
        # انسخ الجلد من فوق لملء الفراغ اللي تركناه
        if new_top > 0:
            fill_source = region[max(0, brow_top_y - drop):brow_top_y, :]
            if fill_source.shape[0] >= new_top:
                result[:new_top, :] = fill_source[:new_top]
            else:
                result[:fill_source.shape[0], :] = fill_source
        # ضع الحاجب في مكانه الجديد
        result[new_top:new_bot, :] = brow_region

    return result


def alpha_blend_warp(original: np.ndarray, warped: np.ndarray,
                     geo: dict, blink_factor: float) -> np.ndarray:
    """
    يدمج الـ warped مع الأصلي باستخدام alpha mask مع Gaussian feathering ناعم.
    v3: استبدلنا feather اليدوي بـ Gaussian blur لنتائج أنعم بدون حواف مرئية.
    """
    if blink_factor < 0.01:
        return original

    h, w = original.shape[:2]
    eye_top_y = geo['eye_top_y']
    eye_bot_y = geo['eye_bot_y']
    eye_h = max(1, eye_bot_y - eye_top_y)
    eye_w = geo.get('eye_w', w * 0.6)
    cx = w // 2

    # alpha mask: 1 داخل العين، 0 خارجها
    alpha = np.zeros((h, w), dtype=np.float32)
    inner_top = int(eye_top_y)
    inner_bot = int(eye_bot_y)
    if inner_bot > inner_top:
        alpha[inner_top:inner_bot, :] = 1.0

    # وزن أفقي: alpha أقوى في وسط العين، يقل كلما اقتربنا من الحواف الجانبية
    # (الحواف الجانبية للعين لا تتحرك كثيراً في الرمش الطبيعي)
    x_dist = np.abs(np.arange(w) - cx) / (eye_w * 0.55 + 1)
    x_weight = np.clip(1.0 - x_dist, 0, 1) ** 0.6
    alpha = alpha * x_weight[np.newaxis, :]

    # Gaussian blur للـ alpha كله لتنعيم الحواف
    blur_size = max(3, int(eye_h * 0.5))
    if blur_size % 2 == 0:
        blur_size += 1
    alpha = cv2.GaussianBlur(alpha, (blur_size, blur_size), 0)

    # ضرب blink_factor في الـ alpha
    alpha = np.clip(alpha * blink_factor, 0, 1)
    alpha_3ch = alpha[:, :, np.newaxis]

    return (original.astype(np.float32) * (1 - alpha_3ch) +
            warped.astype(np.float32) * alpha_3ch).astype(np.uint8)


# =============================================================================
# المعالجة الرئيسية
# =============================================================================

class BlinkProcessor:
    """يعالج فيديو Wav2Lip ويضيف رمش العيون الاحترافي."""

    def __init__(self, static_image: Optional[np.ndarray] = None):
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = None
        self.static_landmarks = None
        self.static_geometries = None  # قاموس: 'left' / 'right' -> geometry

        if static_image is not None:
            self._detect_static_landmarks(static_image)

    def _detect_static_landmarks(self, image: np.ndarray):
        """يكشف المعالم على الصورة الأصلية مرة واحدة."""
        if self.face_mesh is None:
            self.face_mesh = self.mp_face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5
            )

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = self.face_mesh.process(rgb)

        if results.multi_face_landmarks is None:
            print("[BlinkProcessor] WARNING: No face detected in static image!")
            self.static_landmarks = None
            return

        self.static_landmarks = results.multi_face_landmarks[0].landmark
        h, w = image.shape[:2]

        # احسب هندسة كل عين مرة واحدة
        self.static_geometries = {
            'left': get_eye_geometry(self.static_landmarks, LEFT_EYE_INDICES,
                                     LEFT_BROW_INDICES, w, h),
            'right': get_eye_geometry(self.static_landmarks, RIGHT_EYE_INDICES,
                                      RIGHT_BROW_INDICES, w, h),
        }
        print(f"[BlinkProcessor] Static landmarks: {len(self.static_landmarks)} points")
        for side in ['left', 'right']:
            g = self.static_geometries[side]
            print(f"  {side.upper()}: eye_top={g['eye_top_y']:.1f} eye_bot={g['eye_bot_y']:.1f} "
                  f"brow=[{g['brow_top_y']:.1f},{g['brow_bot_y']:.1f}] "
                  f"box={g['box']}")

    def detect_landmarks_for_frame(self, frame: np.ndarray):
        if self.face_mesh is None:
            self.face_mesh = self.mp_face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5
            )
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.face_mesh.process(rgb)
        if results.multi_face_landmarks is None:
            return None
        return results.multi_face_landmarks[0].landmark

    def close(self):
        if self.face_mesh is not None:
            self.face_mesh.close()
            self.face_mesh = None

    def process_frame(self, frame: np.ndarray, blink_factor: float) -> np.ndarray:
        """يطبّق الرمش على إطار واحد."""
        if blink_factor < 0.01:
            return frame

        h, w = frame.shape[:2]

        # لو الإطار صغير جداً (العين هتبقى أقل من 10 بكسل)، كبّره داخلياً
        # لضمان جودة الرمش، وبعدين صغّر الناتج للحجم الأصلي
        MIN_SIDE = 400
        upscale = False
        if min(h, w) < MIN_SIDE:
            scale = MIN_SIDE / min(h, w)
            new_w = int(w * scale)
            new_h = int(h * scale)
            frame_proc = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
            upscale = True
        else:
            frame_proc = frame
            scale = 1.0

        h_p, w_p = frame_proc.shape[:2]

        if self.static_geometries is not None:
            # استخدم geometry ثابت (لكن الإطار مكبّر، فنحتاج نعيد الحساب)
            # حل بسيط: نعيد كشف المعالم على الإطار المكبّر مرة واحدة
            if upscale and not hasattr(self, '_upscaled_landmarks'):
                self._detect_static_landmarks(frame_proc)
            geometries = self.static_geometries
        else:
            landmarks = self.detect_landmarks_for_frame(frame_proc)
            if landmarks is None:
                return frame
            geometries = {
                'left': get_eye_geometry(landmarks, LEFT_EYE_INDICES, LEFT_BROW_INDICES, w_p, h_p),
                'right': get_eye_geometry(landmarks, RIGHT_EYE_INDICES, RIGHT_BROW_INDICES, w_p, h_p),
            }

        result = frame_proc.copy()

        for side, eye_indices in [('left', LEFT_EYE_INDICES), ('right', RIGHT_EYE_INDICES)]:
            try:
                geo = geometries[side]
                bx_min, by_min, bx_max, by_max = geo['box']
                region = result[by_min:by_max, bx_min:bx_max].copy()
                if region.size == 0 or region.shape[0] < 3 or region.shape[1] < 3:
                    continue

                # تأمين القيم داخل المنطقة
                region_h = region.shape[0]
                geo_local = dict(geo)
                geo_local['eye_top_y'] = max(0, min(region_h - 1, geo['eye_top_y']))
                geo_local['eye_bot_y'] = max(geo_local['eye_top_y'] + 1,
                                              min(region_h - 1, geo['eye_bot_y']))

                # 1. Skin stretch warp (الجفن العلوي يمتد + انضغاط أفقي) - v3
                map_x, map_y = build_skin_stretch_warp(
                    region_h, region.shape[1], geo_local, blink_factor
                )
                warped = cv2.remap(region, map_x, map_y,
                                   interpolation=cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_REFLECT)

                # 2. إخفاء القزحية تدريجياً (v3)
                warped = add_iris_darken(warped, geo_local, blink_factor)

                # 3. ظل الجفن
                warped = add_eyelid_shadow(warped, geo_local, blink_factor)

                # 4. خط الرموش
                warped = add_lash_line(warped, geo_local, blink_factor)

                # 5. alpha blend مع الأصلي (Gaussian feather) - v3
                blended = alpha_blend_warp(region, warped, geo_local, blink_factor)

                # 6. حركة الحاجب
                blended = apply_brow_drop(blended, geo_local, blink_factor)

                result[by_min:by_max, bx_min:bx_max] = blended
            except Exception as e:
                print(f"[BlinkProcessor] {side} eye warp failed: {e}")
                continue

        # لو الإطار كان مكبّر، صغّره للحجم الأصلي
        if upscale:
            result = cv2.resize(result, (w, h), interpolation=cv2.INTER_LANCZOS4)

        return result

    def process_video_frames(self,
                             frames: List[np.ndarray],
                             fps: int = 25,
                             progress_callback=None) -> List[np.ndarray]:
        n = len(frames)
        if n == 0:
            return frames

        if self.static_landmarks is None and len(frames) > 0:
            print("[BlinkProcessor] Detecting landmarks from first frame...")
            self._detect_static_landmarks(frames[0])

        if self.static_landmarks is None:
            print("[BlinkProcessor] No landmarks available, skipping blink.")
            return frames

        blinks = plan_blinks(n, fps=fps)
        print(f"[BlinkProcessor] Planned {len(blinks)} blinks over {n} frames "
              f"({n/fps:.1f}s): {[(round(s/fps,2), round(e/fps,2)) for s,e in blinks]}")

        out = []
        for i, frame in enumerate(frames):
            factor = get_blink_factor_at_frame(i, blinks)
            if factor > 0.01:
                out.append(self.process_frame(frame, factor))
            else:
                out.append(frame)

            if progress_callback and i % 5 == 0:
                progress_callback(int(i / n * 100))

        return out


# =============================================================================
# تخطيط أوقات الرمش
# =============================================================================

def plan_blinks(num_frames: int, fps: int = 25,
                min_interval_sec: float = 2.0,
                max_interval_sec: float = 4.5,
                blink_duration_sec: Tuple[float, float] = (0.18, 0.32),
                first_blink_range_sec: Tuple[float, float] = (0.8, 1.8),
                seed: Optional[int] = None) -> List[Tuple[int, int]]:
    if seed is not None:
        rng = np.random.default_rng(seed)
    else:
        rng = np.random.default_rng()

    blinks = []
    first_start = rng.uniform(first_blink_range_sec[0], first_blink_range_sec[1]) * fps
    frame = int(first_start)

    while frame < num_frames:
        duration = rng.uniform(blink_duration_sec[0], blink_duration_sec[1])
        end = frame + int(duration * fps)
        if end >= num_frames:
            end = num_frames - 1
        if end > frame:
            blinks.append((frame, end))
        gap = rng.uniform(min_interval_sec, max_interval_sec) * fps
        frame = end + int(gap)

    return blinks


def blink_curve(progress: float) -> float:
    """منحنى الرمش: 0→1→0 خلال progress من 0 إلى 1 (إغلاق أسرع من الفتح)."""
    if progress < 0.4:
        p = progress / 0.4
        return 0.5 * (1 - np.cos(np.pi * p))
    else:
        p = (progress - 0.4) / 0.6
        return 0.5 * (1 + np.cos(np.pi * p))


def get_blink_factor_at_frame(frame_idx: int, blinks: List[Tuple[int, int]]) -> float:
    for start, end in blinks:
        if start <= frame_idx <= end and end > start:
            progress = (frame_idx - start) / (end - start)
            return blink_curve(progress)
    return 0.0


# =============================================================================
# Helpers
# =============================================================================

def load_video_frames(video_path: str, max_frames: Optional[int] = None):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = int(cap.get(cv2.CAP_PROP_FPS))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frames.append(frame)
        if max_frames and len(frames) >= max_frames:
            break

    cap.release()
    return frames, fps, (w, h)


def save_video_frames(frames: List[np.ndarray], output_path: str,
                      fps: int = 25, audio_path: Optional[str] = None):
    if not frames:
        raise RuntimeError("No frames to save")

    h, w = frames[0].shape[:2]
    temp_avi = output_path.replace('.mp4', '_temp.avi')

    fourcc = cv2.VideoWriter_fourcc(*'DIVX')
    out = cv2.VideoWriter(temp_avi, fourcc, fps, (w, h))

    for f in frames:
        out.write(f)
    out.release()

    if audio_path and os.path.exists(audio_path):
        cmd = f'ffmpeg -y -i "{temp_avi}" -i "{audio_path}" -strict -2 -q:v 1 "{output_path}"'
    else:
        cmd = f'ffmpeg -y -i "{temp_avi}" -strict -2 -q:v 1 "{output_path}"'

    import subprocess
    subprocess.call(cmd, shell=True)

    try:
        os.remove(temp_avi)
    except:
        pass


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python eye_blink.py <input_video> [output_video]")
        sys.exit(1)

    inp = sys.argv[1]
    outp = sys.argv[2] if len(sys.argv) > 2 else inp.replace('.mp4', '_blink.mp4')

    print(f"[Test] Loading {inp}...")
    frames, fps, (w, h) = load_video_frames(inp)
    print(f"[Test] Loaded {len(frames)} frames @ {fps}fps, {w}x{h}")

    proc = BlinkProcessor()
    out_frames = proc.process_video_frames(frames, fps=fps)
    proc.close()

    import tempfile
    temp_audio = tempfile.mktemp(suffix='.wav')
    import subprocess
    subprocess.call(f'ffmpeg -y -i "{inp}" -vn "{temp_audio}"', shell=True)

    save_video_frames(out_frames, outp, fps=fps, audio_path=temp_audio)
    try:
        os.remove(temp_audio)
    except:
        pass

    print(f"[Test] Done! Output: {outp}")
