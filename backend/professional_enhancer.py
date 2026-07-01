"""
Professional Lip Sync Enhancement
=================================
يحسّن جودة إخراج Wav2Lip لمستوى احترافي بدون بطء.

المشكلة:
  Wav2Lip بيشتغل على 96x96 داخلياً، فالوجه كله (مش الشفايف بس) بيطلع
  مبهر وفاقد التفاصيل (ملمس الجلد، المسام، الحواف الواضحة).
  GFPGAN ممكن يسترجع ده بس بياخد 5s/إطار على CPU = بطء شديد.

الحل الاحترافي - Frequency Blending:
  1. نشغّل GFPGAN مرة واحدة على الصورة الأصلية → وجه بتفاصيل كاملة
  2. نحلل الصورة لطبقتين:
     - Low-frequency: الشكل العام + الألوان (Gaussian blur)
     - High-frequency: الملمس + الحواف + التفاصيل الدقيقة
  3. لكل إطار من Wav2Lip:
     - ناخد low-frequency من Wav2Lip (يحافظ على حركة الشفايف والوجه)
     - نضيف high-frequency من الصورة المحسّنة (يسترجع الملمس والتفاصيل)
     - نطبّق ده على منطقة الوجه بس، مع mask ذكي:
       * الجلد (الخدود، الأنف، الجبين): نضيف تفاصيل كاملة
       * الشفايف: نحافظ على تفاصيل Wav2Lip (لأن الشفايف بتتحرك)

الميزة:
  - سريع: GFPGAN مرة واحدة فقط (5s) + معالجة بسيطة لكل إطار (0.05s)
  - احترافي: ملمس وجه واضح + حركة شفايف طبيعية
  - متناسق: نفس الملمس في كل الإطارات (مفيش flickering)
"""

import cv2
import numpy as np
import mediapipe as mp
from typing import List, Optional, Tuple


# MediaPipe Face Mesh indices
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78]
ALL_LIPS = list(set(LIPS_OUTER + LIPS_INNER))

# العينين (عشان ما نضيفش ملمس على العين - ممكن يبوظ الرمش)
LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
ALL_EYES = list(set(LEFT_EYE + RIGHT_EYE))


class ProfessionalEnhancer:
    """
    يحسّن جودة إطارات Wav2Lip لمستوى احترافي باستخدام Frequency Blending.

    Usage:
        enhancer = ProfessionalEnhancer(gfpgan_enhanced_image)
        for frame in wav2lip_frames:
            pro_frame = enhancer.enhance(frame)
    """

    def __init__(self, enhanced_source: np.ndarray, detail_strength: float = 0.7):
        """
        Args:
            enhanced_source: الصورة الأصلية المحسّنة بـ GFPGAN (المرجع للملمس)
            detail_strength: 0-1, قوة إضافة التفاصيل (0.7 موصى به)
        """
        self.detail_strength = detail_strength
        self.source = enhanced_source.copy()
        self.h, self.w = enhanced_source.shape[:2]

        # كشف الوجه والمعالم على الصورة الأصلية
        self.face_bbox: Optional[Tuple[int, int, int, int]] = None
        self.skin_mask: Optional[np.ndarray] = None  # mask للجلد (بدون شفايف/عيون)
        self.source_detail: Optional[np.ndarray] = None  # طبقة التفاصيل من GFPGAN

        self._prepare_reference(enhanced_source)

        if self.face_bbox is not None:
            print(f"[ProEnhancer] Face bbox: {self.face_bbox}")
            print(f"[ProEnhancer] Reference detail layer prepared")
        else:
            print("[ProEnhancer] WARNING: No face detected, enhancer will be no-op")

    def _prepare_reference(self, image: np.ndarray):
        """يحضّر طبقة التفاصيل المرجعية من الصورة المحسّنة."""
        try:
            # 1. كشف الوجه ومعالمه
            face_mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=True,
                max_num_faces=1,
                refine_landmarks=True,
                min_detection_confidence=0.5,
            )
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            results = face_mesh.process(rgb)
            face_mesh.close()

            if results.multi_face_landmarks is None:
                return

            landmarks = results.multi_face_landmarks[0].landmark
            h, w = image.shape[:2]

            # 2. حساب face bbox مع padding كافٍ
            all_pts = np.array([(lm.x * w, lm.y * h) for lm in landmarks])
            x1, y1 = int(all_pts[:, 0].min()), int(all_pts[:, 1].min())
            x2, y2 = int(all_pts[:, 0].max()), int(all_pts[:, 1].max())
            pad = int(max(x2 - x1, y2 - y1) * 0.15)
            self.face_bbox = (
                max(0, x1 - pad),
                max(0, y1 - pad),
                min(w, x2 + pad),
                min(h, y2 + pad),
            )

            # 3. بناء skin mask (الوجه كله ما عدا الشفايف والعينين)
            self._build_skin_mask(image, landmarks)

            # 4. استخراج طبقة التفاصيل من الصورة المحسّنة
            self.source_detail = self._extract_detail_layer(image)

            # 5. ⚠️ صفّر التفاصيل بالقرب من الشفايف لتجنب الهالات البيضاء
            # الـ detail عند حدود الشفايف بيكون كبير (تباين عالي)، وإضافته
            # بيعمل هالة بيضاء. صفّره في منطقة أوسع حول الشفايف.
            self._zero_detail_near_lips(landmarks, image.shape[:2])

        except Exception as e:
            print(f"[ProEnhancer] Reference preparation error: {e}")
            import traceback
            traceback.print_exc()

    def _build_skin_mask(self, image: np.ndarray, landmarks):
        """يبني mask للجلد (الوجه بدون شفايف وعيون)."""
        h, w = image.shape[:2]
        fx1, fy1, fx2, fy2 = self.face_bbox
        fw, fh = fx2 - fx1, fy2 - fy1

        # ابدأ mask محلية على الـ face bbox
        mask = np.zeros((fh, fw), dtype=np.float32)

        # 1. املأ الوجه كله (oval تقريباً) - نستخدم كل الـ landmarks
        all_pts = np.array([(lm.x * w, lm.y * h) for lm in landmarks])
        # Convex hull يعطينا الوجه كله
        hull = cv2.convexHull(all_pts.astype(np.int32))
        hull_local = hull - np.array([fx1, fy1])
        cv2.fillConvexPoly(mask, hull_local, 1.0)

        # 2. شيل الشفايف من الـ mask (نحافظ على تفاصيل Wav2Lip هناك)
        lip_pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in ALL_LIPS])
        lip_local = lip_pts.astype(np.int32) - np.array([fx1, fy1])
        # وسّع منطقة الشفايف شوية عشان نأخذ الجلد المحيط مباشرة
        cv2.fillConvexPoly(mask, lip_local, 0.0)
        # توسيع إضافي للمنطقة حول الشفايف
        lip_dilated = cv2.dilate(
            (mask == 0).astype(np.uint8) * 255,
            np.ones((7, 7), np.uint8), iterations=2
        )
        mask[lip_dilated > 0] = 0.0

        # 3. شيل العينين (عشان ما نبوظش الرمش)
        for eye_indices in [LEFT_EYE, RIGHT_EYE]:
            eye_pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in eye_indices])
            eye_local = eye_pts.astype(np.int32) - np.array([fx1, fy1])
            cv2.fillConvexPoly(mask, eye_local, 0.0)
            # توسيع حول العين
            eye_mask = np.zeros((fh, fw), dtype=np.uint8)
            cv2.fillConvexPoly(eye_mask, eye_local, 255)
            eye_dilated = cv2.dilate(eye_mask, np.ones((5, 5), np.uint8), iterations=2)
            mask[eye_dilated > 0] = 0.0

        # 4. Gaussian blur للـ mask (feathering ناعم على الحواف)
        feather = max(7, fh // 12)
        mask = cv2.GaussianBlur(mask, (feather * 2 + 1, feather * 2 + 1), 0)

        self.skin_mask = mask

    def _zero_detail_near_lips(self, landmarks, img_shape):
        """يصفّر طبقة التفاصيل في منطقة واسعة حول الشفايف.

        هذا يمنع الهالات البيضاء عند حدود الشفايف، لأن الـ detail هناك
        بيكون كبير جداً (تباين عالي بين الجلد الفاتح والشفايف الداكنة).
        """
        if self.source_detail is None:
            return
        h, w = img_shape
        fx1, fy1, fx2, fy2 = self.face_bbox
        fh, fw = fy2 - fy1, fx2 - fx1

        # بناء mask للمنطقة حول الشفايف (أوسع من الشفايف نفسها)
        lip_pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in ALL_LIPS])
        lip_local = lip_pts.astype(np.int32) - np.array([fx1, fy1])

        # mask محلية بـ نفس حجم الـ detail
        zero_mask = np.zeros((fh, fw), dtype=np.float32)
        cv2.fillConvexPoly(zero_mask, lip_local, 1.0)

        # وسّع المنطقة بـ 25px عشان نلغي التفاصيل في الجلد المحيط بالشفايف
        zero_mask = cv2.dilate(zero_mask, np.ones((25, 25), np.uint8), iterations=2)

        # feather عشان الانتقال يكون ناعم
        zero_mask = cv2.GaussianBlur(zero_mask, (31, 31), 0)

        # اضرب التفاصيل في (1 - zero_mask) → يصفّرها حول الشفايف
        self.source_detail = self.source_detail * (1.0 - zero_mask[:, :, np.newaxis])

    def _extract_detail_layer(self, image: np.ndarray) -> np.ndarray:
        """
        يستخرج طبقة التفاصيل (high-frequency) من الصورة.
        detail = original - blur(original)

        مهم: نقوم بـ soft-compress للقيم المتطرفة لتجنب الهالات البيضاء
        عند حدود الشفايف (حيث التباين عالي = تفاصيل كبيرة).
        """
        fx1, fy1, fx2, fy2 = self.face_bbox
        face_region = image[fy1:fy2, fx1:fx2].astype(np.float32)

        # Gaussian blur كبير = low-frequency (الشكل العام)
        blurred = cv2.GaussianBlur(face_region, (0, 0), sigmaX=3.0)

        # التفاصيل = الأصلي - المبهر
        detail = face_region - blurred

        # ⚠️ مهم: soft-compress للقيم المتطرفة
        # عند حدود الشفايف (جلد فاتح vs شفايف داكنة) الـ detail بيكون كبير جداً
        # (مثلاً ±80)، وإضافة ده بـ strength=0.7 بتعمل هالة بيضاء.
        # الحل: نضغط القيم فوق threshold لـ حد أقصى.
        # tanh-like compression: detail' = threshold * tanh(detail / threshold)
        threshold = 18.0  # caps detail magnitude at ~18 per channel
        detail = threshold * np.tanh(detail / threshold)

        return detail

    def enhance(self, wav2lip_frame: np.ndarray) -> np.ndarray:
        """
        يحسّن إطار من Wav2Lip بإضافة تفاصيل الوجه من المرجع.

        Args:
            wav2lip_frame: إطار من Wav2Lip (وجه مبهر + حركة شفايف)
        Returns:
            إطار محسّن: ملمس واضح + حركة شفايف طبيعية
        """
        if self.face_bbox is None or self.source_detail is None:
            return wav2lip_frame

        fx1, fy1, fx2, fy2 = self.face_bbox
        fw, fh = fx2 - fx1, fy2 - fy1

        # خذ منطقة الوجه من Wav2Lip
        w2l_face = wav2lip_frame[fy1:fy2, fx1:fx2].astype(np.float32)

        # تأكد إن الأحجام متطابقة
        if w2l_face.shape[:2] != self.source_detail.shape[:2]:
            # resize المرجع ليتوافق
            ref_detail_resized = cv2.resize(
                self.source_detail, (w2l_face.shape[1], w2l_face.shape[0])
            )
        else:
            ref_detail_resized = self.source_detail

        # 1. استخرج low-frequency من Wav2Lip (الشكل والحركة)
        w2l_low = cv2.GaussianBlur(w2l_face, (0, 0), sigmaX=3.0)

        # 2. ضيف تفاصيل المرجع على الـ low-frequency
        # result = w2l_low + strength * ref_detail
        enhanced_face = w2l_low + self.detail_strength * ref_detail_resized

        # 3. ادمج مع الأصلي باستخدام skin mask
        # - على الجلد: استخدم enhanced (فيه تفاصيل)
        # - على الشفايف والعينين: استخدم Wav2Lip الأصلي (يحافظ على الحركة)
        mask_3ch = self.skin_mask[:, :, np.newaxis]
        blended = (w2l_face * (1 - mask_3ch) + enhanced_face * mask_3ch)

        # clip للمدى الصحيح
        blended = np.clip(blended, 0, 255).astype(np.uint8)

        # الصق الوجه المحسّن على الإطار
        result = wav2lip_frame.copy()
        result[fy1:fy2, fx1:fx2] = blended
        return result

    def enhance_batch(self, frames: List[np.ndarray],
                      progress_callback=None) -> List[np.ndarray]:
        """
        يحسّن قائمة من الإطارات.

        Args:
            frames: إطارات Wav2Lip
            progress_callback: callable(percent: int)
        Returns:
            إطارات محسّنة احترافياً
        """
        n = len(frames)
        if n == 0 or self.face_bbox is None:
            return frames

        print(f"[ProEnhancer] Enhancing {n} frames (frequency blending)...")
        out = []
        for i, f in enumerate(frames):
            out.append(self.enhance(f))
            if progress_callback and i % 10 == 0:
                progress_callback(int(i / n * 100))

        if progress_callback:
            progress_callback(100)
        print(f"[ProEnhancer] Done: {len(out)} frames enhanced")
        return out


# =============================================================================
# Helper: اختبار سريع
# =============================================================================
def _test():
    import sys
    if len(sys.argv) < 3:
        print("Usage: python professional_enhancer.py <source_enhanced> <wav2lip_frame> [output]")
        sys.exit(1)
    source = cv2.imread(sys.argv[1])
    w2l = cv2.imread(sys.argv[2])
    outp = sys.argv[3] if len(sys.argv) > 3 else "pro_enhanced.jpg"

    enhancer = ProfessionalEnhancer(source, detail_strength=0.7)
    result = enhancer.enhance(w2l)
    cv2.imwrite(outp, result)
    print(f"Saved {outp}")


if __name__ == "__main__":
    _test()
