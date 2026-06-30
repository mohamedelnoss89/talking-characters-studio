"""
Face Compositor
===============
يحل مشكلة "النخمشة على الفم" اللي بتيجي من Wav2Lip.

المشكلة:
  Wav2Lip بيشتغل على 96x96 داخلياً ثم يكبّر الوجه كله للـ resolution الأصلي.
  النتيجة: الوجه كله (مش الشفايف بس) مبهر ومسحوب التفاصيل.
  حتى مع GFPGAN pre-enhancement على الصورة الأصلية، Wav2Lip بيلغي التحسين
  لأنه بيستبدل الـ face box كامل بإخراجه.

الحل:
  1. الصورة الأصلية المحسّنة بـ GFPGAN = base (وجه حاد)
  2. Wav2Lip output = فيه شفايف متحركة لكن وجه مبهر
  3. نأخذ **منطقة الشفايف فقط** من Wav2Lip
  4. نشحذ منطقة الشفايف (upscale 2x → CLAHE + unsharp → downscale)
  5. ندمج الشفايف المشحوذة على الـ base الحاد
  6. النتيجة: وجه حاد + شفايف متحركة واضحة

الميزة: سريع جداً (millisecond/إطار) لأن مش بنشغّل GFPGAN على كل إطار.
"""

import cv2
import numpy as np
import mediapipe as mp
from typing import List, Optional, Tuple


# MediaPipe Face Mesh indices للشفايف (outer + inner فقط - بدون أنف أو ذقن)
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78]
# فقط outer + inner (بدون إضافات من الأنف/الذقن)
ALL_LIPS = list(set(LIPS_OUTER + LIPS_INNER))


class FaceCompositor:
    """
    يدمج الشفايف المتحركة من Wav2Lip على الوجه الحاد من GFPGAN.

    Usage:
        compositor = FaceCompositor(enhanced_source_image)
        for frame in wav2lip_frames:
            sharp_frame = compositor.composite(frame)
    """

    def __init__(self, base_image: np.ndarray, lip_expand: float = 0.25):
        """
        Args:
            base_image: الصورة الأصلية المحسّنة بـ GFPGAN (الـ base الحاد)
            lip_expand: مقدار التوسيع حول الشفايف (0.25 = 25% padding)
        """
        self.base_image = base_image.copy()
        self.h, self.w = base_image.shape[:2]
        self.lip_expand = lip_expand

        # كشف معالم الشفايف على الصورة الأصلية (مرة واحدة)
        self.lip_bbox: Optional[Tuple[int, int, int, int]] = None
        self.lip_polygon: Optional[np.ndarray] = None
        self.lip_mask: Optional[np.ndarray] = None  # feathered mask للحجم الكامل
        self._detect_lips(base_image)

        if self.lip_bbox is not None:
            self._build_lip_mask()
            print(f"[FaceCompositor] Lip bbox: {self.lip_bbox}")
        else:
            print("[FaceCompositor] WARNING: No lips detected, compositor will be no-op")

    def _detect_lips(self, image: np.ndarray):
        """يكشف منطقة الشفايف باستخدام MediaPipe Face Mesh."""
        try:
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

            lip_pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in ALL_LIPS])

            x_min = int(lip_pts[:, 0].min())
            x_max = int(lip_pts[:, 0].max())
            y_min = int(lip_pts[:, 1].min())
            y_max = int(lip_pts[:, 1].max())

            # Padding حول الشفايف للسياق
            # أفقي: 40% (يشمل زوايا الفم والجلد المحيط)
            # رأسي: 60% فوق (تحت الأنف) + 80% تحت (الذقن العلوي)
            # هذا يغطي منطقة "الفم" بالكامل اللي Wav2Lip بيغيّرها
            lip_w = x_max - x_min
            lip_h = y_max - y_min
            pad_x = int(lip_w * 0.40)
            pad_y_top = int(lip_h * 0.60)   # فوق: تحت الأنف
            pad_y_bot = int(lip_h * 0.80)   # تحت: الذقن العلوي
            x_min = max(0, x_min - pad_x)
            x_max = min(w, x_max + pad_x)
            y_min = max(0, y_min - pad_y_top)
            y_max = min(h, y_max + pad_y_bot)

            self.lip_bbox = (x_min, y_min, x_max, y_max)
            self.lip_polygon = lip_pts.astype(np.int32)
        except Exception as e:
            print(f"[FaceCompositor] Lip detection error: {e}")

    def _build_lip_mask(self):
        """يبني mask ناعمة للشفايف (للدمج المريّش)."""
        x1, y1, x2, y2 = self.lip_bbox
        bw, bh = x2 - x1, y2 - y1

        # mask محلية على الـ lip bbox
        local_mask = np.zeros((bh, bw), dtype=np.float32)

        # إزاحة الـ polygon للإحداثيات المحلية
        local_poly = self.lip_polygon - np.array([x1, y1])

        # املأ polygon الخارجي
        cv2.fillConvexPoly(local_mask, local_poly, 1.0)

        # وسّع الـ mask شوية عشان يشمل المنطقة المحيطة بالشفايف (الجلد القريب)
        # ده مهم عشان الانتقال بين الشفايف والوجه يكون أنعم
        expand_kernel = max(3, bh // 8)
        local_mask = cv2.dilate(local_mask, np.ones((expand_kernel, expand_kernel), np.uint8), iterations=1)

        # Gaussian blur للـ feathering
        feather = max(5, bh // 4)
        local_mask = cv2.GaussianBlur(local_mask, (feather * 2 + 1, feather * 2 + 1), 0)

        # خزّن الـ mask محلياً (هتتطبّق على الـ lip bbox بس)
        self.lip_mask_local = local_mask

    def _sharpen_lip_crop(self, lip_crop: np.ndarray) -> np.ndarray:
        """
        يشحذ منطقة الشفايف لإزالة النخمشة.
        1. Upscale 2x بـ Lanczos (يسترجع تفاصيل من 96x96)
        2. CLAHE على قناة L (contrast محلي)
        3. Unsharp mask معتدل (مش قوي عشان ميبوظش طبيعة الشفايف)
        4. Downscale للـ size الأصلي
        """
        h, w = lip_crop.shape[:2]
        if h < 5 or w < 5:
            return lip_crop

        # 1. Upscale 2x
        up = cv2.resize(lip_crop, (w * 2, h * 2), interpolation=cv2.INTER_LANCZOS4)

        # 2. CLAHE على قناة L (contrast محلي معتدل)
        lab = cv2.cvtColor(up, cv2.COLOR_BGR2LAB)
        l_ch, a_ch, b_ch = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(4, 4))
        l_enhanced = clahe.apply(l_ch)

        # 3. Unsharp mask معتدل على قناة L
        blurred = cv2.GaussianBlur(l_enhanced, (0, 0), sigmaX=1.2)
        l_sharp = cv2.addWeighted(l_enhanced, 1.5, blurred, -0.5, 0)

        enhanced_lab = cv2.merge([l_sharp, a_ch, b_ch])
        enhanced_up = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)

        # 4. Downscale للـ size الأصلي بـ Lanczos (يحافظ على الحواف)
        result = cv2.resize(enhanced_up, (w, h), interpolation=cv2.INTER_LANCZOS4)
        return result

    def composite(self, wav2lip_frame: np.ndarray) -> np.ndarray:
        """
        يدمج الشفايف من Wav2Lip على الـ base الحاد.

        Args:
            wav2lip_frame: إطار من Wav2Lip (وجه مبهر + شفايف متحركة)
        Returns:
            إطار مركّب: base حاد + شفايف مشحوذة من Wav2Lip
        """
        if self.lip_bbox is None:
            return wav2lip_frame

        x1, y1, x2, y2 = self.lip_bbox

        # خذ الشفايف من Wav2Lip
        wav2lip_lip = wav2lip_frame[y1:y2, x1:x2].copy()

        # شحذ الشفايف
        sharpened_lip = self._sharpen_lip_crop(wav2lip_lip)

        # خذ نفس المنطقة من الـ base الحاد
        base_lip = self.base_image[y1:y2, x1:x2].copy()

        # ادمج: mask عالية للشفايف المتحركة، منخفضة للجلد المحيط
        # ده يخلي الشفايف من Wav2Lip (المتحركة) تظهر بوضوح
        # والجلد القريب ياخد من الـ base الحاد
        mask_3ch = self.lip_mask_local[:, :, np.newaxis]

        # blend: في منتصف الشفايف (mask=1) → Wav2Lip sharpened
        #         على الحواف (mask=0) → base
        blended = (base_lip.astype(np.float32) * (1 - mask_3ch) +
                   sharpened_lip.astype(np.float32) * mask_3ch).astype(np.uint8)

        # النتيجة: base image كامل + منطقة الشفايف مدموجة
        result = self.base_image.copy()
        result[y1:y2, x1:x2] = blended
        return result

    def composite_batch(self, frames: List[np.ndarray],
                        progress_callback=None) -> List[np.ndarray]:
        """
        يطبّق composite على قائمة من الإطارات.

        Args:
            frames: إطارات Wav2Lip
            progress_callback: callable(percent: int)
        Returns:
            إطارات مركّبة
        """
        n = len(frames)
        if n == 0 or self.lip_bbox is None:
            return frames

        print(f"[FaceCompositor] Compositing {n} frames...")
        out = []
        for i, f in enumerate(frames):
            out.append(self.composite(f))
            if progress_callback and i % 10 == 0:
                progress_callback(int(i / n * 100))

        if progress_callback:
            progress_callback(100)
        print(f"[FaceCompositor] Done: {len(out)} frames composited")
        return out


# =============================================================================
# Helper: اختبار سريع
# =============================================================================
def _test():
    import sys
    if len(sys.argv) < 3:
        print("Usage: python face_compositor.py <base_image> <wav2lip_frame> [output]")
        sys.exit(1)
    base = cv2.imread(sys.argv[1])
    w2l = cv2.imread(sys.argv[2])
    outp = sys.argv[3] if len(sys.argv) > 3 else "composited.jpg"

    comp = FaceCompositor(base)
    result = comp.composite(w2l)
    cv2.imwrite(outp, result)
    print(f"Saved {outp}")


if __name__ == "__main__":
    _test()
