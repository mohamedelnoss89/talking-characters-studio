"""
Pro Lip Enhancer v2
===================
يحسّن جودة حركة الشفايف لمستوى احترافي مع الحفاظ على الحركة الطبيعية.

المشاكل اللي بتحل:
1. Wav2Lip بيشتغل على 96x96 داخلياً → الشفايف بتطلع ناعمة/مبهمة
2. الحلول السابقة إما بطيئة (GFPGAN per-frame) أو بتجمد الوجه (FaceCompositor)
3. التشحذ البسيط على bbox ثابت بيفوّت الشفايف لما تتحرك

الاستراتيجية الجديدة (احترافية):
  لكل إطار:
  1. كشف معالم الشفايف بـ MediaPipe Face Mesh (per-frame tracking)
  2. بناء mask دقيقة للشفايف (outer + inner contour)
  3. تشحذ edge-aware على حواف الشفايف بس (مش الـ bbox كله)
  4. CLAHE محلي على قناة L لزيادة contrast الشفايف
  5. نقل تفاصيل high-frequency من مرجع GFPGAN إلى حواف الشفايف بس
     (الـ interior يفضل من Wav2Lip عشان الحركة)
  6. دمج أنعم بـ Gaussian feather

الميزة:
  - شفايف أوضح وحواف حادة
  - حركة طبيعية محفوظة (per-frame tracking)
  - سريع (~10ms/إطار)
"""

import cv2
import numpy as np
import mediapipe as mp
from typing import List, Optional, Tuple


# MediaPipe Face Mesh indices
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78]
ALL_LIPS = list(set(LIPS_OUTER + LIPS_INNER))


class ProLipEnhancer:
    """
    يحسّن جودة الشفايف per-frame مع الحفاظ على الحركة.
    """

    def __init__(self,
                 gfpgan_reference: Optional[np.ndarray] = None,
                 sharpen_amount: float = 0.65,
                 detail_strength: float = 0.45,
                 clahe_clip: float = 2.8,
                 edge_only: bool = True):
        """
        Args:
            gfpgan_reference: الصورة الأصلية المحسّنة بـ GFPGAN (لنقل تفاصيل الحواف)
            sharpen_amount: قوة التشحذ (0.5-0.8 موصى به)
            detail_strength: قوة نقل التفاصيل من المرجع (0.3-0.5)
            clahe_clip: حد الـ CLAHE للـ contrast المحلي
            edge_only: True = تشحذ على حواف الشفايف بس (احترافي)
                      False = تشحذ على كل منطقة الشفايف
        """
        self.sharpen_amount = sharpen_amount
        self.detail_strength = detail_strength
        self.clahe_clip = clahe_clip
        self.edge_only = edge_only

        # MediaPipe Face Mesh (one instance, reused for all frames)
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            static_image_mode=False,  # video mode - faster, uses temporal info
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        # GFPGAN reference for detail transfer (optional)
        self.ref_detail = None
        self.ref_shape = None
        if gfpgan_reference is not None:
            self._prepare_reference(gfpgan_reference)

    def _prepare_reference(self, ref_img: np.ndarray):
        """يحضّر طبقة التفاصيل من مرجع GFPGAN."""
        # High-frequency = original - blurred
        blurred = cv2.GaussianBlur(ref_img.astype(np.float32), (0, 0), sigmaX=2.0)
        self.ref_detail = ref_img.astype(np.float32) - blurred
        self.ref_shape = ref_img.shape[:2]
        print(f"[ProLip] Reference detail layer prepared (shape={self.ref_shape})")

    def _get_lip_mask(self, landmarks, img_h: int, img_w: int,
                      dilation: int = 2) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
        """
        يبني mask دقيقة للشفايف من الـ landmarks.

        Returns:
            lip_mask: mask ناعمة للشفايف (float32, 0-1)
            bbox: (x1, y1, x2, y2) bounding box مع padding
        """
        # النقاط الخارجية والداخلية
        outer_pts = np.array([(landmarks[i].x * img_w, landmarks[i].y * img_h) for i in LIPS_OUTER])
        inner_pts = np.array([(landmarks[i].x * img_w, landmarks[i].y * img_h) for i in LIPS_INNER])

        # Mask كاملة للشفايف (outer hull)
        mask_full = np.zeros((img_h, img_w), dtype=np.float32)
        cv2.fillConvexPoly(mask_full, outer_pts.astype(np.int32), 1.0)

        # Edge mask = band حول الـ outer contour + inner contour
        # هذا يحدد "حواف الشفايف" اللي نريد تشحيزها
        mask_edge = np.zeros((img_h, img_w), dtype=np.float32)
        # ارسم الـ outer contour كخطوط سميكة
        cv2.polylines(mask_edge, [outer_pts.astype(np.int32)], True, 1.0, thickness=3)
        cv2.polylines(mask_edge, [inner_pts.astype(np.int32)], True, 1.0, thickness=2)
        # وسّع شوية
        if dilation > 0:
            mask_edge_d = cv2.dilate(mask_edge, np.ones((3, 3), np.uint8), iterations=dilation)
            mask_edge = mask_edge_d

        # الـ mask النهائية: edge_only ? edge_mask : full_mask
        if self.edge_only:
            lip_mask = mask_edge
        else:
            lip_mask = mask_full

        # Feather
        lip_mask = cv2.GaussianBlur(lip_mask, (7, 7), 0)

        # Bounding box مع padding للمعالجة
        all_pts = np.concatenate([outer_pts, inner_pts])
        x_min = int(all_pts[:, 0].min())
        x_max = int(all_pts[:, 0].max())
        y_min = int(all_pts[:, 1].min())
        y_max = int(all_pts[:, 1].max())
        pad = max(8, int((x_max - x_min) * 0.20))
        pad_y = max(8, int((y_max - y_min) * 0.30))
        x_min = max(0, x_min - pad)
        x_max = min(img_w, x_max + pad)
        y_min = max(0, y_min - pad_y)
        y_max = min(img_h, y_max + pad_y)

        return lip_mask, (x_min, y_min, x_max, y_max)

    def _sharpen_edge_aware(self, region: np.ndarray, amount: float) -> np.ndarray:
        """
        تشحذ edge-aware: bilateral filter + unsharp mask على قناة L.
        الـ bilateral بيحافظ على الحواف ويقلل الضوضاء.
        """
        # Bilateral filter (يحافظ على الحواف)
        bilateral = cv2.bilateralFilter(region, d=5, sigmaColor=30, sigmaSpace=30)

        # LAB للعمل على قناة الإضاءة
        lab = cv2.cvtColor(bilateral, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)

        # CLAHE محلي
        clahe = cv2.createCLAHE(clipLimit=self.clahe_clip, tileGridSize=(4, 4))
        l_enhanced = clahe.apply(l)

        # Unsharp mask على قناة L
        blurred_l = cv2.GaussianBlur(l_enhanced, (0, 0), sigmaX=1.0)
        l_sharp = cv2.addWeighted(l_enhanced, 1.0 + amount, blurred_l, -amount, 0)

        # دمج
        enhanced_lab = cv2.merge([l_sharp, a, b])
        enhanced = cv2.cvtColor(enhanced_lab, cv2.COLOR_LAB2BGR)
        return enhanced

    def _transfer_edge_detail(self, region: np.ndarray,
                              ref_detail_region: np.ndarray,
                              strength: float) -> np.ndarray:
        """
        ينقل تفاصيل high-frequency من المرجع إلى المنطقة.
        فقط على الـ edges (المحدد بـ mask لاحقاً).
        """
        if ref_detail_region is None:
            return region
        # تأكد من تطابق الأحجام
        if ref_detail_region.shape[:2] != region.shape[:2]:
            ref_detail_region = cv2.resize(ref_detail_region, (region.shape[1], region.shape[0]))

        region_f = region.astype(np.float32)
        # نضيف تفاصيل المرجع
        enhanced = region_f + strength * ref_detail_region
        return np.clip(enhanced, 0, 255).astype(np.uint8)

    def enhance_frame(self, frame: np.ndarray) -> np.ndarray:
        """
        يحسّن إطار واحد.
        1. كشف معالم الشفايف
        2. بناء mask
        3. تشحذ edge-aware
        4. نقل تفاصيل (لو في مرجع)
        5. دمج بـ mask
        """
        img_h, img_w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.face_mesh.process(rgb)

        if results.multi_face_landmarks is None:
            return frame  # ما فيش وجه، سيب الإطار زي ما هو

        landmarks = results.multi_face_landmarks[0].landmark
        lip_mask, bbox = self._get_lip_mask(landmarks, img_h, img_w)
        x1, y1, x2, y2 = bbox

        # خذ منطقة الشفايف
        region = frame[y1:y2, x1:x2].copy()
        if region.size == 0:
            return frame

        # mask محلية على الـ bbox
        local_mask = lip_mask[y1:y2, x1:x2]
        if local_mask.size == 0:
            return frame

        # 1. تشحذ edge-aware
        sharpened = self._sharpen_edge_aware(region, self.sharpen_amount)

        # 2. نقل تفاصيل من المرجع (لو متاح)
        if self.ref_detail is not None:
            ref_h, ref_w = self.ref_shape
            # خذ نفس المنطقة من المرجع
            # (المرجع له نفس أبعاد الإطار لأنه نفس الصورة الأصلية)
            if y2 <= ref_h and x2 <= ref_w:
                ref_region_detail = self.ref_detail[y1:y2, x1:x2]
                sharpened = self._transfer_edge_detail(sharpened, ref_region_detail, self.detail_strength)

        # 3. دمج بالـ mask
        mask_3ch = local_mask[:, :, np.newaxis]
        blended = (region.astype(np.float32) * (1 - mask_3ch) +
                   sharpened.astype(np.float32) * mask_3ch)
        blended = np.clip(blended, 0, 255).astype(np.uint8)

        # الصق النتيجة
        result = frame.copy()
        result[y1:y2, x1:x2] = blended
        return result

    def enhance_batch(self, frames: List[np.ndarray],
                      progress_callback=None) -> List[np.ndarray]:
        """يعالج قائمة من الإطارات."""
        n = len(frames)
        if n == 0:
            return frames

        print(f"[ProLip] Enhancing {n} frames (per-frame tracking, edge-aware)...")
        out = []
        for i, f in enumerate(frames):
            out.append(self.enhance_frame(f))
            if progress_callback and i % 10 == 0:
                progress_callback(int(i / n * 100))

        if progress_callback:
            progress_callback(100)
        print(f"[ProLip] Done: {len(out)} frames enhanced")
        return out

    def close(self):
        if self.face_mesh is not None:
            self.face_mesh.close()
            self.face_mesh = None


# =============================================================================
# Pipeline entry point
# =============================================================================

def enhance_lips_pro(frames: List[np.ndarray],
                     gfpgan_reference: Optional[np.ndarray] = None,
                     sharpen_amount: float = 0.65,
                     detail_strength: float = 0.45,
                     progress_callback=None) -> List[np.ndarray]:
    """
    يطبّق التحسين الاحترافي على قائمة إطارات.

    Args:
        frames: إطارات Wav2Lip
        gfpgan_reference: الصورة المحسّنة بـ GFPGAN (لنقل تفاصيل الحواف)
        sharpen_amount: قوة التشحذ (0.5-0.8)
        detail_strength: قوة نقل التفاصيل من المرجع (0.3-0.5)
    """
    enhancer = ProLipEnhancer(
        gfpgan_reference=gfpgan_reference,
        sharpen_amount=sharpen_amount,
        detail_strength=detail_strength,
        edge_only=True,
    )
    try:
        result = enhancer.enhance_batch(frames, progress_callback=progress_callback)
    finally:
        enhancer.close()
    return result
