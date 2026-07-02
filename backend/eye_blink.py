"""
Eye Blink Post-Processing Module (v3 - Professional)
=====================================================
يضيف رمش طبيعي للعين على إطارات Wav2Lip الناتجة.

الاستراتيجية v3 (احترافية - جديدة):
المشكلة في v2: كان بيحاول يعمل الجفن المغلق بإعادة استخدام بكسلات العين
نفسها (iris + sclera) عن طريق warp. النتيجة كانت "smear" مش جفن فعلي.

الحل في v3: نستخدم **جلد الجفن العلوي الفعلي** (المنطقة بين الحاجب والعين)
ونمده ليغطي العين. هذا يعطي مظهر جفن مغلق بجلد فعلي.

الخطوات لكل إطار داخل فترة رمش:
1. EYELID SKIN SAMPLING: نأخذ جلد الجفن العلوي (من تحت الحاجب لفوق العين)
   ونمدّه للأسفل ليغطي العين بـ scale渐进ي حسب blink_factor.
2. CREASE LINE: نرسم خط الجفن العلوي (eyelid crease) - خط داكن رفيع عند
   الحافة العلوية للجلد النازل.
3. SUB-CREASE SHADOW: ظل خفيف تحت خط الجفن لإعطاء عمق.
4. LASH LINE: خط الرموش السفلي عند حافة إغلاق الجفن (يظهر عند الإغلاق الكامل).
5. ALMOND ALPHA MASK: قناع على شكل اللوزة (almond) للدمج - الوسط يغلق أولاً،
   الزوايا تبقى مفتوحة أطول (طبيعي).
6. BROW DROP: الحاجب بينزل شوية مع الرمش (حركة طبيعية مصاحبة).

محسّنات v3 إضافية:
- Micro-saccades: حركات عين صغيرة (1-2px) بين الرمشات لإضفاء الحيوية.
- Variable blink completeness: بعض الرمشات كاملة (100%)، أخرى جزئية (70%).
- Double-blinks: أحياناً رمشتين متتاليتين سريعتين.
- Temporal smoothing: تنعيم blink_factor عبر الإطارات لمنع الـ jitter.
"""

import os
import cv2
import numpy as np
from typing import List, Tuple, Optional, Dict

# mediapipe 0.10+ has only the Tasks API (no legacy solutions API).
# We use FaceLandmarker from mediapipe.tasks.python.vision.
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
    print("[eye_blink] WARNING: mediapipe.tasks not available, blink disabled")

# Path to the face_landmarker.task model file (478 landmarks with refine)
_FACE_LANDMARKER_PATH = os.environ.get(
    'FACE_LANDMARKER_PATH',
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 '..', 'public', 'models', 'face_landmarker.task')
)


# =============================================================================
# معالم الوجه في MediaPipe Face Mesh (478 نقطة مع refine_landmarks)
# =============================================================================
# العين اليسرى (يمين المشاهد)
LEFT_EYE_INDICES = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
# العين اليمنى
RIGHT_EYE_INDICES = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]

# الحاجب الأيسر
LEFT_BROW_INDICES = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
# الحاجب الأيمن
RIGHT_BROW_INDICES = [336, 296, 334, 293, 300, 276, 283, 282, 295, 285]

# الزاوية الخارجية للعين (outer corner) - تبقى مفتوحة أطول في الرمش الطبيعي
LEFT_OUTER_CORNER = 33  # زاوية خارجية (يمين الوجه)
LEFT_INNER_CORNER = 133  # زاوية داخلية (عند الأنف)
RIGHT_OUTER_CORNER = 263
RIGHT_INNER_CORNER = 362

# أعلى نقطة في العين (top center) - أهم نقطة لقياس ارتفاع الجفن
LEFT_EYE_TOP = 159
RIGHT_EYE_TOP = 386
LEFT_EYE_BOTTOM = 145
RIGHT_EYE_BOTTOM = 374


def get_eye_geometry(landmarks, eye_indices, brow_indices, img_w, img_h):
    """
    يحسب الهندسة الكاملة للعين + الجفن + الحاجب.

    Returns: dict with:
        - box: (x_min, y_min, x_max, y_max) bounding box كامل للمعالجة
        - eye_top_y, eye_bot_y, eye_center_y: relative to box
        - brow_top_y: أعلى نقطة في الحاجب (relative)
        - brow_bot_y: أسفل نقطة في الحاجب
        - skin_top_y: أعلى نقطة للجلد فوق العين (نأخذ منها الجفن)
        - eye_corner_inner_y, eye_corner_outer_y: زوايا العين (يبقون مفتوحين أطول)
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

    # المنطقة بين الحاجب والعين = جلد الجفن العلوي (هذا اللي هنمده)
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
        'eye_x_min': eye_x_min - bx_min,
        'eye_x_max': eye_x_max - bx_min,
    }


# =============================================================================
# خوارزمية الرمش v3 - استخدم جلد الجفن العلوي الفعلي
# =============================================================================

def sample_upper_eyelid_skin(region: np.ndarray, geo: dict) -> Optional[np.ndarray]:
    """
    v4: يأخذ عيّنة عالية الجودة من جلد الجفن العلوي.
    يأخذ منطقة جلد أعرض وأعلى لضمان استمرارية الجلد عند التغطية.
    """
    h, w = region.shape[:2]
    skin_top = int(geo['skin_top_y'])  # تحت الحاجب
    skin_bot = int(geo['skin_bot_y'])  # فوق العين
    eye_h = max(1, int(geo['eye_h']))
    eye_w = int(geo['eye_w'])
    eye_x_min = int(geo['eye_x_min'])
    eye_x_max = int(geo['eye_x_max'])

    skin_h = skin_bot - skin_top
    if skin_h < 3:
        return None

    # نأخذ الجلد بعرض العين + padding بسيط
    pad = max(3, int(eye_w * 0.15))
    sx1 = max(0, eye_x_min - pad)
    sx2 = min(w, eye_x_max + pad)
    skin_strip = region[skin_top:skin_bot, sx1:sx2].copy()

    if skin_strip.size == 0 or skin_strip.shape[0] < 2 or skin_strip.shape[1] < 2:
        return None

    return skin_strip


def build_closed_eye_overlay(region: np.ndarray, geo: dict,
                              blink_factor: float,
                              completeness: float = 1.0) -> np.ndarray:
    """
    v4: يبني طبقة "العين المغلقة" بشكل احترافي.

    التحسينات عن v3:
    1. الجلد بينزل بشكل متدرّج (gradient) - أعلى الجلد أغمق (ظل الجفن)،
       أسفله أفتح (الجلد القريب من العين).
    2. الجلد مش مجرد resize - بنعمل vertical stretch مع تكرار البكسلات
       الأقرب للعين للحفاظ على texture مطابق.
    3. خط الجفن (crease) بقى أعرض وأكثر شبه الموجود في الواقع.
    4. ظل أسفل خط الجفن بقى gradient ناعم مش hard line.
    5. خط الرموش بقى أكثر سماكة وأقرب للون الطبيعي (داكن).
    6. أضفنا highlight فوق خط الجفن (catch light) - يعكس الضوء بشكل طبيعي.
    7. الجفن السفلي بيرتفع شوية مع الرمش (natural movement).
    """
    if blink_factor < 0.02:
        return region

    h, w = region.shape[:2]
    eye_top_y = int(geo['eye_top_y'])
    eye_bot_y = int(geo['eye_bot_y'])
    eye_h = max(1, eye_bot_y - eye_top_y)
    eye_w = int(geo['eye_w'])
    eye_x_min = int(geo['eye_x_min'])
    eye_x_max = int(geo['eye_x_max'])
    cx = (eye_x_min + eye_x_max) // 2

    # 1. خذ جلد الجفن العلوي
    skin = sample_upper_eyelid_skin(region, geo)
    if skin is None:
        skin_h = max(2, eye_h // 2)
        skin = region[max(0, eye_top_y - skin_h):eye_top_y,
                      max(0, eye_x_min - 2):min(w, eye_x_max + 2)].copy()
        if skin.size == 0:
            return region

    # 2. احسب مقدار التغطية
    cover_ratio = blink_factor * completeness
    cover_h = max(1, int(eye_h * cover_ratio * 1.05))  # شوية زيادة عشان يغطي تماماً

    # 3. مدّ الجلد بطريقة متدرّجة - الجزء القريب من العين يتكرر أكتر
    # (هذا يحافظ على texture الجلد القريب من العين)
    skin_h_src = skin.shape[0]
    # عاوزين نأخذ من الجلد بحيث الجزء الأسفل (قريب من العين) يظهر أكتر
    # Stretch: استخدم power curve for distribution
    dst_rows = np.linspace(0, 1, cover_h) ** 1.3 * (skin_h_src - 1)
    dst_rows = dst_rows.astype(int)
    skin_cover = skin[dst_rows, :, :]

    # 4. ضع الجلد فوق العين
    result = region.copy()
    skin_x1 = max(0, eye_x_min - 2)
    skin_x2 = min(w, skin_x1 + skin_cover.shape[1])
    skin_y1 = eye_top_y  # يبدأ من أعلى العين وينزل
    skin_y2 = min(h, skin_y1 + cover_h)

    actual_h = skin_y2 - skin_y1
    actual_w = skin_x2 - skin_x1
    if actual_h > 0 and actual_w > 0:
        if skin_cover.shape != (actual_h, actual_w, skin.shape[2] if skin.ndim == 3 else 1):
            skin_cover = cv2.resize(skin_cover, (actual_w, actual_h),
                                     interpolation=cv2.INTER_LINEAR)
        result[skin_y1:skin_y2, skin_x1:skin_x2] = skin_cover

    # 5. أضف ظل خط الجفن (crease shadow) - gradient ناعم فوق الجلد النازل
    # خط الجفن يكون في أعلى الجلد النازل (عند eye_top_y) ويظهر كظل منحني
    if cover_h > 2:
        shadow_h = min(cover_h, max(3, eye_h // 3))
        shadow_top = max(0, eye_top_y - 1)
        shadow_bot = min(h, eye_top_y + shadow_h)
        if shadow_bot > shadow_top:
            sh_h = shadow_bot - shadow_top
            # vertical gradient: أقوى في الأعلى، يختفي في الأسفل
            v_grad = np.linspace(1.0, 0.0, sh_h).reshape(-1, 1, 1)
            # horizontal gradient: gaussian (أقوى في الوسط)
            half_w = max(1, (skin_x2 - skin_x1) // 2)
            h_axis = np.arange(skin_x2 - skin_x1)
            h_grad = np.exp(-((h_axis - (cx - skin_x1)) / (half_w * 0.7)) ** 2)
            h_grad = h_grad.reshape(1, -1, 1)
            # شدّة الظل (scale with blink factor)
            shadow_strength = 35 * blink_factor
            shadow_overlay = (v_grad * h_grad * shadow_strength).astype(np.float32)
            patch = result[shadow_top:shadow_bot, skin_x1:skin_x2].astype(np.float32)
            result[shadow_top:shadow_bot, skin_x1:skin_x2] = np.clip(
                patch - shadow_overlay, 0, 255).astype(np.uint8)

    # 6. أضف highlight فوق خط الجفن (catch light - انعكاس الضوء الطبيعي)
    if cover_h > 3 and blink_factor > 0.3:
        highlight_y = max(0, eye_top_y - 2)
        if highlight_y < h:
            half_w = max(1, (skin_x2 - skin_x1) // 2)
            h_axis = np.arange(skin_x2 - skin_x1)
            h_grad = np.exp(-((h_axis - (cx - skin_x1)) / (half_w * 0.5)) ** 2)
            highlight_strength = 15 * blink_factor * h_grad
            # حوّل لـ 3 channels (matching image shape)
            highlight_strength_3ch = np.stack([highlight_strength] * 3, axis=-1)
            highlight_patch = result[highlight_y, skin_x1:skin_x2].astype(np.float32)
            result[highlight_y, skin_x1:skin_x2] = np.clip(
                highlight_patch + highlight_strength_3ch, 0, 255).astype(np.uint8)

    # 7. أضف خط الرموش (lash line) عند الإغلاق - رفيع وداكن
    if blink_factor > 0.5:
        lash_y = min(h - 1, eye_top_y + cover_h - 1)
        lash_h = 2 if blink_factor > 0.8 else 1
        half_w = max(1, (skin_x2 - skin_x1) // 2)
        h_axis = np.arange(skin_x2 - skin_x1)
        h_grad = np.exp(-((h_axis - (cx - skin_x1)) / (half_w * 0.6)) ** 2)
        lash_intensity = 80 * blink_factor * h_grad
        # حوّل لـ 3 channels
        lash_intensity_3ch = np.stack([lash_intensity] * 3, axis=-1)
        for dy in range(lash_h):
            y = lash_y + dy
            if 0 <= y < h:
                lash_patch = result[y, skin_x1:skin_x2].astype(np.float32)
                result[y, skin_x1:skin_x2] = np.clip(
                    lash_patch - lash_intensity_3ch, 0, 255).astype(np.uint8)

    # 8. الجفن السفلي بيرتفع شوية (نقل بكسلات الجفن السفلي لأعلى)
    if blink_factor > 0.4 and eye_bot_y > eye_top_y + cover_h:
        lower_lift = int(2 * blink_factor * completeness)
        if lower_lift > 0:
            lower_y1 = max(0, eye_bot_y - lower_lift - 2)
            lower_y2 = min(h, eye_bot_y + 1)
            if lower_y2 > lower_y1 + lower_lift:
                lower_strip = result[lower_y1:lower_y2, skin_x1:skin_x2].copy()
                shifted = np.zeros_like(lower_strip)
                shifted[:lower_strip.shape[0] - lower_lift, :] = lower_strip[lower_lift:, :]
                # fill top with last row
                shifted[lower_strip.shape[0] - lower_lift:, :] = lower_strip[-1:, :]
                result[lower_y1:lower_y2, skin_x1:skin_x2] = shifted

    return result


def build_almond_alpha_mask(h: int, w: int, geo: dict,
                             blink_factor: float) -> np.ndarray:
    """
    v4: قناع alpha احترافي على شكل اللوزة.
    
    التحسينات:
    1. شكل اللوزة الحقيقي: الجفن العلوي بيغلق أعمق من الجفن السفلي.
    2. توزيع غير متماثل: الزاوية الخارجية (outer corner) تغلق أبطأ من الداخلية
       (مطابق لـ "lagophthalmos" الطبيعي).
    3. التحوّل ناعم مع إستخدام supersampling لتنعيم الحواف.
    4. عند الرمش الجزئي، الوسط يغطي العين والزوايا لا.
    """
    # نستخدم supersampling لتنعيم الحواف (2x)
    SS = 2
    h_ss, w_ss = h * SS, w * SS
    alpha = np.zeros((h_ss, w_ss), dtype=np.float32)
    eye_top_y = geo['eye_top_y'] * SS
    eye_bot_y = geo['eye_bot_y'] * SS
    eye_h = max(1.0, eye_bot_y - eye_top_y)
    eye_w = geo.get('eye_w', w * 0.6) * SS
    eye_x_min = geo['eye_x_min'] * SS
    eye_x_max = geo['eye_x_max'] * SS
    cx = (eye_x_min + eye_x_max) / 2.0
    half_w = eye_w * 0.5

    yy, xx = np.ogrid[:h_ss, :w_ss]

    # المسافة الأفقية من المركز (مقيسة بنصف عرض العين)
    x_dist = np.abs(xx - cx) / (half_w + 1)
    # المسافة الرأسية من المركز (مقيسة بنصف ارتفاع العين)
    y_center = (eye_top_y + eye_bot_y) / 2
    y_dist = np.abs(yy - y_center) / (eye_h * 0.5 + 1)

    # شكل اللوزة: قطع ناقص
    ellipse_dist = (x_dist ** 2 + y_dist ** 2) ** 0.5
    almond = np.clip(1.0 - ellipse_dist, 0, 1) ** 0.5

    # قلّل alpha عند الزوايا (corners) - الزاوية الخارجية تبقى مفتوحة أطول
    # outer corner (عند cx ± half_w): alpha يقل بـ 40%
    # inner corner (عند cx ∓ half_w*0.9): alpha يقل بـ 25%
    corner_factor_outer = np.clip(x_dist - 0.75, 0, 1) ** 2
    almond = almond * (1.0 - corner_factor_outer * 0.45)

    # boost المركز بشكل أكبر (الجفن العلوي يغطي القزحية بالكامل)
    center_boost = np.exp(-(x_dist ** 2 + y_dist ** 2) * 1.5)
    almond = almond + center_boost * 0.25 * blink_factor

    alpha = almond * blink_factor
    alpha = np.clip(alpha, 0, 1)

    # Gaussian blur للـ alpha لتنعيم الحواف (blur أصغر للحفاظ على قوة المركز)
    blur_size = max(3, int(eye_h * 0.4))
    if blur_size % 2 == 0:
        blur_size += 1
    alpha = cv2.GaussianBlur(alpha, (blur_size, blur_size), 0)
    # boost أقوى بعد الـ blur علشان المركز يفضل قوي
    alpha = np.clip(alpha * 1.8, 0, 1)

    # صغّر للحجم الأصلي (downsample)
    alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_AREA)

    return alpha


def apply_micro_saccade(region: np.ndarray, geo: dict,
                         saccade_dx: float, saccade_dy: float) -> np.ndarray:
    """
    يطبق حركة عين صغيرة (micro-saccade) بقدر 1-2 بكسل.
    يحرك فقط منطقة القزحية (iris) وليس الجلد المحيط.
    """
    if abs(saccade_dx) < 0.1 and abs(saccade_dy) < 0.1:
        return region

    h, w = region.shape[:2]
    eye_top_y = int(geo['eye_top_y'])
    eye_bot_y = int(geo['eye_bot_y'])
    eye_h = max(1, eye_bot_y - eye_top_y)
    eye_w = int(geo['eye_w'])
    cx = (int(geo['eye_x_min']) + int(geo['eye_x_max'])) // 2

    # منطقة القزحية: دائرة في وسط العين
    iris_r = max(2, int(eye_w * 0.32))
    iris_y = (eye_top_y + eye_bot_y) // 2

    # إذا القزحية خارج المنطقة، تجاهل
    if iris_y - iris_r < 0 or iris_y + iris_r > h:
        return region
    if cx - iris_r < 0 or cx + iris_r > w:
        return region

    # خذ منطقة القزحية
    iris_x1 = max(0, cx - iris_r - 1)
    iris_x2 = min(w, cx + iris_r + 1)
    iris_y1 = max(0, iris_y - iris_r - 1)
    iris_y2 = min(h, iris_y + iris_r + 1)
    iris_region = region[iris_y1:iris_y2, iris_x1:iris_x2].copy()

    # حرك القزحية بـ sub-pixel precision (warpAffine)
    dx = saccade_dx
    dy = saccade_dy
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    shifted = cv2.warpAffine(iris_region, M, (iris_region.shape[1], iris_region.shape[0]),
                              flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REFLECT)

    # قناع دائري للقزحية (للدمج الناعم)
    ih, iw = iris_region.shape[:2]
    yy, xx = np.ogrid[:ih, :iw]
    mask_dist = np.sqrt((xx - iw / 2) ** 2 + (yy - ih / 2) ** 2)
    iris_mask = np.clip(1.0 - mask_dist / (iris_r + 1), 0, 1) ** 1.2
    # Gaussian blur للقناع
    blur_size = max(3, int(iris_r * 0.4))
    if blur_size % 2 == 0:
        blur_size += 1
    iris_mask = cv2.GaussianBlur(iris_mask, (blur_size, blur_size), 0)
    iris_mask_3ch = iris_mask[:, :, np.newaxis]

    # دمج
    result = region.copy()
    blended = (iris_region.astype(np.float32) * (1 - iris_mask_3ch) +
               shifted.astype(np.float32) * iris_mask_3ch).astype(np.uint8)
    result[iris_y1:iris_y2, iris_x1:iris_x2] = blended

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


def alpha_blend(original: np.ndarray, overlay: np.ndarray,
                alpha: np.ndarray) -> np.ndarray:
    """
    يدمج الأصلي مع overlay باستخدام alpha mask.
    """
    alpha_3ch = alpha[:, :, np.newaxis]
    return (original.astype(np.float32) * (1 - alpha_3ch) +
            overlay.astype(np.float32) * alpha_3ch).astype(np.uint8)


# =============================================================================
# المعالجة الرئيسية
# =============================================================================

class BlinkProcessor:
    """يعالج فيديو Wav2Lip ويضيف رمش العيون الاحترافي v3."""

    def __init__(self, static_image: Optional[np.ndarray] = None):
        self._landmarker = None
        self._landmarker_initialized = False
        self.static_landmarks = None
        self.static_geometries: Optional[Dict[str, dict]] = None

        # micro-saccade state
        self._saccade_rng = np.random.default_rng(seed=42)
        self._saccade_dx = 0.0
        self._saccade_dy = 0.0
        self._saccade_target_dx = 0.0
        self._saccade_target_dy = 0.0
        self._saccade_counter = 0

        if static_image is not None:
            self._detect_static_landmarks(static_image)

    def _init_landmarker(self):
        """يهيّئ FaceLandmarker مرة واحدة (lazy init)."""
        if self._landmarker_initialized:
            return
        self._landmarker_initialized = True
        if not MEDIAPIPE_AVAILABLE:
            print("[BlinkProcessor] mediapipe not available")
            return
        if not os.path.exists(_FACE_LANDMARKER_PATH):
            print(f"[BlinkProcessor] WARNING: face_landmarker.task not found at {_FACE_LANDMARKER_PATH}")
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
            print(f"[BlinkProcessor] FaceLandmarker initialized (model: {_FACE_LANDMARKER_PATH})")
        except Exception as e:
            print(f"[BlinkProcessor] WARNING: failed to init FaceLandmarker: {e}")
            self._landmarker = None

    def _detect_landmarks(self, image: np.ndarray):
        """يكشف المعالم باستخدام FaceLandmarker (Tasks API).
        Returns: list of (x, y, z) normalized landmarks, or None."""
        self._init_landmarker()
        if self._landmarker is None:
            return None
        try:
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = self._landmarker.detect(mp_image)
            if not result.face_landmarks:
                return None
            # face_landmarks[0] is a list of NormalizedLandmark objects with .x, .y, .z
            return result.face_landmarks[0]
        except Exception as e:
            print(f"[BlinkProcessor] detect failed: {e}")
            return None

    def _detect_static_landmarks(self, image: np.ndarray):
        """يكشف المعالم على الصورة الأصلية مرة واحدة."""
        landmarks = self._detect_landmarks(image)
        if landmarks is None:
            print("[BlinkProcessor] WARNING: No face detected in static image!")
            self.static_landmarks = None
            return

        self.static_landmarks = landmarks
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
        return self._detect_landmarks(frame)

    def close(self):
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception:
                pass
            self._landmarker = None
        self._landmarker_initialized = False

    def _update_saccade(self):
        """يحدّث micro-saccade كل ~30 إطار (1.2 ثانية @ 25fps)."""
        self._saccade_counter += 1
        if self._saccade_counter >= 30:
            self._saccade_counter = 0
            # هدف جديد: حركة عشوائية صغيرة (±1.5 px)
            self._saccade_target_dx = self._saccade_rng.uniform(-1.5, 1.5)
            self._saccade_target_dy = self._saccade_rng.uniform(-0.8, 0.8)
        # تحرك نحو الهدف ببطء (easing)
        self._saccade_dx += (self._saccade_target_dx - self._saccade_dx) * 0.15
        self._saccade_dy += (self._saccade_target_dy - self._saccade_dy) * 0.15

    def process_frame(self, frame: np.ndarray, blink_factor: float,
                       completeness: float = 1.0) -> np.ndarray:
        """يطبّق الرمش على إطار واحد (v3)."""
        h, w = frame.shape[:2]

        # لو الإطار صغير جداً، كبّره داخلياً
        # العين تحتاج على الأقل ~15px ارتفاع عشان الرمش يكون واضح
        # صور 250x230 (eye_h ~ 5px) نكبّرها لـ 800px (eye_h ~ 16px)
        MIN_SIDE = 800
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
            if upscale and not hasattr(self, '_upscaled_landmarks'):
                self._detect_static_landmarks(frame_proc)
                self._upscaled_landmarks = True
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

        # تحديث micro-saccade (يتم حتى أثناء الرمش للحركة الطبيعية)
        # لكن نخففها أثناء الرمش لتجنب تداخل الحركات
        saccade_strength = max(0.0, 1.0 - blink_factor * 1.5)
        self._update_saccade()
        saccade_dx = self._saccade_dx * saccade_strength
        saccade_dy = self._saccade_dy * saccade_strength

        for side, eye_indices in [('left', LEFT_EYE_INDICES), ('right', RIGHT_EYE_INDICES)]:
            try:
                geo = geometries[side]
                bx_min, by_min, bx_max, by_max = geo['box']
                region = result[by_min:by_max, bx_min:bx_max].copy()
                if region.size == 0 or region.shape[0] < 5 or region.shape[1] < 5:
                    continue

                # تأمين القيم داخل المنطقة
                region_h = region.shape[0]
                geo_local = dict(geo)
                geo_local['eye_top_y'] = max(0, min(region_h - 1, geo['eye_top_y']))
                geo_local['eye_bot_y'] = max(geo_local['eye_top_y'] + 1,
                                              min(region_h - 1, geo['eye_bot_y']))
                geo_local['eye_x_min'] = max(0, geo['eye_x_min'])
                geo_local['eye_x_max'] = min(region.shape[1], geo['eye_x_max'])

                # 1. طبّق micro-saccade على القزحية (قبل الرمش)
                if saccade_strength > 0.05:
                    region = apply_micro_saccade(region, geo_local, saccade_dx, saccade_dy)

                # 2. لو فيه رمش، ابنِ طبقة العين المغلقة
                if blink_factor > 0.02:
                    overlay = build_closed_eye_overlay(
                        region, geo_local, blink_factor, completeness
                    )
                    # 3. ابنِ قناع alpha على شكل اللوزة
                    alpha = build_almond_alpha_mask(
                        region_h, region.shape[1], geo_local, blink_factor * completeness
                    )
                    # 4. ادمج
                    blended = alpha_blend(region, overlay, alpha)
                    # 5. حركة الحاجب
                    blended = apply_brow_drop(blended, geo_local, blink_factor)
                    result[by_min:by_max, bx_min:bx_max] = blended
                else:
                    result[by_min:by_max, bx_min:bx_max] = region
            except Exception as e:
                print(f"[BlinkProcessor] {side} eye processing failed: {e}")
                import traceback
                traceback.print_exc()
                continue

        # لو الإطار كان مكبّر، صغّره للحجم الأصلي
        if upscale:
            result = cv2.resize(result, (w, h), interpolation=cv2.INTER_LANCZOS4)

        return result

    def process_video_frames(self,
                             frames: List[np.ndarray],
                             fps: int = 25,
                             audio_path: Optional[str] = None,
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

        # اكتشف فترات الصمت في الصوت (لو متاح)
        audio_pauses = []
        if audio_path:
            audio_pauses = find_audio_pauses(audio_path, fps=fps)
            print(f"[BlinkProcessor] Found {len(audio_pauses)} audio pauses for blink sync")

        # خطط الرمشات (متزامنة مع فترات الصمت لو متاحة)
        blinks = plan_blinks(n, fps=fps, audio_pauses=audio_pauses)
        print(f"[BlinkProcessor] Planned {len(blinks)} blinks over {n} frames "
              f"({n/fps:.1f}s): {[(round(s/fps,2), round(e/fps,2), round(c,2)) for s,e,c in blinks]}")

        out = []
        for i, frame in enumerate(frames):
            factor, completeness = get_blink_factor_at_frame(i, blinks)
            if factor > 0.01:
                out.append(self.process_frame(frame, factor, completeness))
            else:
                # حتى بدون رمش، نطبق micro-saccade
                out.append(self.process_frame(frame, 0.0, 0.0))

            if progress_callback and i % 5 == 0:
                progress_callback(int(i / n * 100))

        return out


# =============================================================================
# تخطيط أوقات الرمش (v4 - مع completeness متغير + double-blinks + audio sync)
# =============================================================================

def find_audio_pauses(audio_path: str, fps: int = 25,
                       min_pause_sec: float = 0.3) -> List[int]:
    """
    يحلل الصوت وييجي فترات الصمت (pauses) - الرمش الطبيعي بيحصل فيها.
    Returns: list of frame indices where pauses start.
    """
    if not audio_path or not os.path.isfile(audio_path):
        return []
    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=16000, mono=True)
        # احسب RMS energy في نوافذ 50ms
        hop_length = int(sr * 0.05)
        frame_length = int(sr * 0.1)
        rms = librosa.feature.rms(y=y, frame_length=frame_length,
                                   hop_length=hop_length)[0]
        # normalize
        rms_max = rms.max() + 1e-6
        rms_norm = rms / rms_max
        # عتبة الصمت (نسبة من الذروة)
        silence_threshold = 0.08
        is_silent = rms_norm < silence_threshold

        # نجد بدايات فترات الصمت (transition from sound to silence)
        # نتجاهل الفترات القصيرة جداً
        pause_starts = []
        in_pause = False
        pause_len = 0
        for i, sil in enumerate(is_silent):
            t_sec = i * hop_length / sr
            frame_idx = int(t_sec * fps)
            if sil:
                if not in_pause:
                    in_pause = True
                    pause_start_frame = frame_idx
                pause_len += hop_length / sr
            else:
                if in_pause and pause_len >= min_pause_sec:
                    pause_starts.append(pause_start_frame)
                in_pause = False
                pause_len = 0
        # آخر pause لو الفيديو انتهى بصمت
        if in_pause and pause_len >= min_pause_sec:
            pause_starts.append(pause_start_frame)
        return pause_starts
    except Exception as e:
        print(f"[eye_blink] audio pause detection failed: {e}")
        return []


def plan_blinks(num_frames: int, fps: int = 25,
                min_interval_sec: float = 1.5,
                max_interval_sec: float = 3.5,
                blink_duration_sec: Tuple[float, float] = (0.24, 0.40),
                first_blink_range_sec: Tuple[float, float] = (0.5, 1.2),
                double_blink_prob: float = 0.20,
                audio_pauses: Optional[List[int]] = None,
                pause_sync_prob: float = 0.7,
                seed: Optional[int] = None) -> List[Tuple[int, int, float]]:
    """
    v4: يخطط أوقات الرمش. كل رمشة = (start_frame, end_frame, completeness)
    
    التحسينات:
    - لو فيه audio_pauses، 70% من الرمشات بتحصل في فترات الصمت
      (مطابق للسلوك البشري - بنرمش وقت ما بنسكت)
    - completeness ∈ [0.75, 1.0]: أغلب الرمشات كاملة تقريباً
    - أحياناً (20%) نضيف رمشة مزدوجة (double-blink)
    - مدة الرمش: 0.24-0.40 ثانية (6-10 إطارات @ 25fps)
    - فاصل بين الرمشات: 1.5-3.5 ثانية (متوسط طبيعي للإنسان)
    """
    if seed is not None:
        rng = np.random.default_rng(seed)
    else:
        rng = np.random.default_rng()

    blinks: List[Tuple[int, int, float]] = []
    first_start = rng.uniform(first_blink_range_sec[0], first_blink_range_sec[1]) * fps
    frame = int(first_start)
    used_pauses = set()
    audio_pauses = audio_pauses or []
    # رتّب الـ pauses
    audio_pauses_sorted = sorted(audio_pauses)

    while frame < num_frames:
        # لو فيه pause قريب، نرمش فيه (مع احتمال 70%)
        chosen_frame = frame
        for p_idx, p_frame in enumerate(audio_pauses_sorted):
            if p_idx in used_pauses:
                continue
            if abs(p_frame - frame) < int(0.8 * fps):  # خلال 0.8 ثانية
                if rng.random() < pause_sync_prob:
                    chosen_frame = max(p_frame, frame)
                    used_pauses.add(p_idx)
                    break

        duration = rng.uniform(blink_duration_sec[0], blink_duration_sec[1])
        end = chosen_frame + int(duration * fps)
        if end >= num_frames:
            end = num_frames - 1
        if end > chosen_frame:
            completeness = float(rng.uniform(0.85, 1.0))
            blinks.append((chosen_frame, end, completeness))

            # double-blink: رمشة ثانية سريعة بعد الأولى
            if rng.random() < double_blink_prob:
                gap_frames = int(rng.uniform(0.08, 0.16) * fps)
                second_start = end + gap_frames
                second_duration = rng.uniform(0.18, 0.28)
                second_end = second_start + int(second_duration * fps)
                if second_end < num_frames and second_end > second_start:
                    blinks.append((second_start, second_end,
                                   float(rng.uniform(0.65, 0.90))))
                    end = second_end

        gap = rng.uniform(min_interval_sec, max_interval_sec) * fps
        frame = end + int(gap)

    return blinks


def blink_curve(progress: float) -> float:
    """منحنى الرمش الاحترافي: 0→1→hold→0 خلال progress من 0 إلى 1.
    
    المراحل (مبنية على دراسات فيزيولوجية):
    - 0-35%: الإغلاق (close) - سريع، ease-in-out
    - 35-45%: مرحلة hold قصيرة (العين مغلقة تماماً)
    - 45-100%: الفتح (open) - أبطأ من الإغلاق
    
    الإغلاق أسرع من الفتح بنسبة ~30% (مطابق لـ "Doane 1980" للرمش الطبيعي).
    """
    if progress < 0.35:
        # مرحلة الإغلاق (close) - smoothstep
        p = progress / 0.35
        # ease-in-out (smoother than cosine)
        return p * p * (3 - 2 * p)
    elif progress < 0.45:
        # مرحلة hold (العين مغلقة تماماً)
        return 1.0
    else:
        # مرحلة الفتح (open) - أبطأ
        p = (progress - 0.45) / 0.55
        # ease-out (يبدأ سريع ويتباطأ)
        return 1.0 - (1 - (1 - p) ** 2) ** 0.7


def get_blink_factor_at_frame(frame_idx: int,
                               blinks: List[Tuple[int, int, float]]
                               ) -> Tuple[float, float]:
    """يرجع (blink_factor, completeness) للإطار المعطى."""
    for start, end, completeness in blinks:
        if start <= frame_idx <= end and end > start:
            progress = (frame_idx - start) / (end - start)
            return float(blink_curve(progress)), completeness
    return 0.0, 0.0


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
