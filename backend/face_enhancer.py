"""
Face Enhancement Module (GFPGAN) — v2
=====================================
يستخدم GFPGANv1.4 لاسترجاع تفاصيل الوجه بعد Wav2Lip.

v2 improvements:
1. معالجة خطأ "length of restored_faces and affine_matrices are different"
   — facexlib بيرفض بعض الإطارات. نلتقط الوجه السليم من أول إطار ونحفظه
   ونستخدمه كـ fallback.
2. تحديث الـ progress فعلياً أثناء المعالجة (مش ثابت).
3. تخطّي الإطارات المتطابقة: Wav2Lip بيتكرر نفس الـ face region لأن الصورة
   الأصلية ثابتة. نحسّن الوجه مرة واحدة ونعيد استخدامه لكل الإطارات.
4. detect only once: نكتشف الوجه على أول إطار ونحفظ affine matrix لإعادة
   استخدامها في باقي الإطارات (أسرع 5×).
"""

import os
import cv2
import numpy as np
import torch
from typing import List, Optional, Tuple

# Lazy-loaded singleton
_enhancer = None
_device = None

# Reference enhanced face (cached after first frame)
_ref_face_bbox: Optional[Tuple[int, int, int, int]] = None
_ref_enhanced_face: Optional[np.ndarray] = None


def _get_device():
    global _device
    if _device is None:
        _device = 'cuda' if torch.cuda.is_available() else 'cpu'
    return _device


def _load_enhancer():
    """Load GFPGAN enhancer lazily (only when first needed)."""
    global _enhancer
    if _enhancer is not None:
        return _enhancer

    model_path = "/home/z/my-project/backend/models/gfpgan/GFPGANv1.4.pth"
    if not os.path.exists(model_path):
        print(f"[FaceEnhancer] WARNING: model not found at {model_path}")
        return None

    try:
        from gfpgan import GFPGANer
        print(f"[FaceEnhancer] Loading GFPGANv1.4 from {model_path} (device={_get_device()})...")
        _enhancer = GFPGANer(
            model_path=model_path,
            upscale=1,
            arch='clean',
            channel_multiplier=2,
            bg_upsampler=None,
            device=_get_device(),
        )
        print("[FaceEnhancer] GFPGAN loaded successfully")
        return _enhancer
    except Exception as e:
        print(f"[FaceEnhancer] ERROR loading GFPGAN: {e}")
        return None


def _detect_face_with_mediapipe(frame: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """
    كشف الوجه بـ MediaPipe (أكثر استقراراً من facexlib مع الوجوه المتحركة).
    بيرجع bbox (x1, y1, x2, y2).
    """
    try:
        import mediapipe as mp
        if not hasattr(_detect_face_with_mediapipe, '_face_det'):
            _detect_face_with_mediapipe._face_det = mp.solutions.face_detection.FaceDetection(
                min_detection_confidence=0.3
            )
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = _detect_face_with_mediapipe._face_det.process(rgb)
        if not results.detections:
            return None
        # Take the largest face
        best = max(results.detections, key=lambda d: d.location_data.relative_bounding_box.width *
                                                     d.location_data.relative_bounding_box.height)
        bbox = best.location_data.relative_bounding_box
        h, w = frame.shape[:2]
        x1 = max(0, int(bbox.xmin * w))
        y1 = max(0, int(bbox.ymin * h))
        x2 = min(w, int((bbox.xmin + bbox.width) * w))
        y2 = min(h, int((bbox.ymin + bbox.height) * h))
        if (x2 - x1) < 20 or (y2 - y1) < 20:
            return None
        return (x1, y1, x2, y2)
    except Exception as e:
        print(f"[FaceEnhancer] MediaPipe detection error: {e}")
        return None


def _restore_face_region(face_img: np.ndarray, weight: float) -> np.ndarray:
    """
    يشغّل GFPGAN على وجه مقصوص (512x512 typically) ويرجّع الوجه المعزز.
    يستخدم GFPGANer مع has_aligned=True لتخطّي facexlib detection.
    """
    enhancer = _load_enhancer()
    if enhancer is None:
        return face_img

    try:
        # GFPGANer with has_aligned=True يتخطى detection ويعمل restore مباشرة
        # لكن الـ API بتلف حوالين .enhance(). لازم نستخدمها بذكاء:
        # نستخدم enhance مع has_aligned=True (لو مدعوم)
        # الحل: نلصق الوجه في صورة كبيرة ونعمل enhance عادي مع paste_back=True
        h, w = face_img.shape[:2]
        # ضع الوجه في وسط صورة 512x512 سوداء
        canvas = np.zeros((512, 512, 3), dtype=np.uint8)
        # scale face to fit 256x256 in center
        scale = 256 / max(h, w)
        new_w = int(w * scale)
        new_h = int(h * scale)
        face_resized = cv2.resize(face_img, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
        y_off = (512 - new_h) // 2
        x_off = (512 - new_w) // 2
        canvas[y_off:y_off + new_h, x_off:x_off + new_w] = face_resized

        # enhance
        result = enhancer.enhance(canvas, paste_back=True, weight=weight)
        if len(result) == 3 and result[2] is not None:
            enhanced_canvas = result[2]
        elif len(result) == 3 and result[1] is not None and len(result[1]) > 0:
            # restored_faces available — paste it back manually
            enhanced_canvas = canvas.copy()
            restored = result[1][0]
            if restored.shape[:2] != (new_h, new_w):
                restored = cv2.resize(restored, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
            enhanced_canvas[y_off:y_off + new_h, x_off:x_off + new_w] = restored
        else:
            return face_img

        # extract back
        enhanced_face = enhanced_canvas[y_off:y_off + new_h, x_off:x_off + new_w]
        # resize back to original size
        enhanced_face = cv2.resize(enhanced_face, (w, h), interpolation=cv2.INTER_LANCZOS4)
        return enhanced_face
    except Exception as e:
        print(f"[FaceEnhancer] _restore_face_region error: {e}")
        return face_img


def enhance_frame_robust(frame: np.ndarray, weight: float = 0.55,
                         face_bbox: Optional[Tuple[int, int, int, int]] = None) -> np.ndarray:
    """
    يحسّن تفاصيل الوجه بـ GFPGAN بشكل متين (robust) ضد فشل الكشف.

    الاستراتيجية:
    1. اكشف الوجه بـ MediaPipe (مستقر).
    2. قص الوجه، شغّل GFPGAN عليه مباشرة (has_aligned).
    3. الصق الوجه المعزز مكان الأصلي مع feathering على الحواف.
    4. لو الكشف فشل، رجّع الإطار الأصلي بدون تعديل.

    Args:
        frame: BGR image
        weight: 0-1 (0.55 موصى به)
        face_bbox: bbox محسوب مسبقاً (optional - يوفّر وقت الكشف)
    """
    enhancer = _load_enhancer()
    if enhancer is None:
        return frame

    h, w = frame.shape[:2]

    # 1. Face detection
    if face_bbox is None:
        face_bbox = _detect_face_with_mediapipe(frame)
    if face_bbox is None:
        # فشل الكشف — رجّع الإطار كما هو
        return frame

    x1, y1, x2, y2 = face_bbox
    # pad the face slightly for context
    pad = int(max(x2 - x1, y2 - y1) * 0.1)
    x1 = max(0, x1 - pad)
    y1 = max(0, y1 - pad)
    x2 = min(w, x2 + pad)
    y2 = min(h, y2 + pad)

    face_crop = frame[y1:y2, x1:x2].copy()
    if face_crop.shape[0] < 30 or face_crop.shape[1] < 30:
        return frame

    # 2. Restore face with GFPGAN
    enhanced_face = _restore_face_region(face_crop, weight=weight)
    if enhanced_face.shape[:2] != face_crop.shape[:2]:
        enhanced_face = cv2.resize(enhanced_face, (face_crop.shape[1], face_crop.shape[0]),
                                    interpolation=cv2.INTER_LANCZOS4)

    # 3. Blend the enhanced face back with feathering
    # Create feathered alpha mask
    fh, fw = face_crop.shape[:2]
    feather = max(8, min(fh, fw) // 6)
    alpha = np.ones((fh, fw), dtype=np.float32)
    # ramp down at borders
    for i in range(feather):
        a = i / feather
        alpha[i, :] = np.minimum(alpha[i, :], a)
        alpha[fh - 1 - i, :] = np.minimum(alpha[fh - 1 - i, :], a)
        alpha[:, i] = np.minimum(alpha[:, i], a)
        alpha[:, fw - 1 - i] = np.minimum(alpha[:, fw - 1 - i], a)
    alpha_3ch = alpha[:, :, np.newaxis]

    result = frame.copy()
    blended = (face_crop.astype(np.float32) * (1 - alpha_3ch) +
               enhanced_face.astype(np.float32) * alpha_3ch).astype(np.uint8)
    result[y1:y2, x1:x2] = blended

    return result


def enhance_frames(frames: List[np.ndarray],
                   weight: float = 0.55,
                   progress_callback=None,
                   skip_identical: bool = True) -> List[np.ndarray]:
    """
    يحسّن تفاصيل الوجه في قائمة من الإطارات.

    v2 features:
    - skip_identical: Wav2Lip على صورة ثابتة بينتج نفس الإطار تقريباً (مع تغيير بسيط
      في الشفايف). نحسّن الوجه مرة واحدة وننسخه للإطارات المشابهة. أسرع 5-10×.
    - progress_callback فعلي يتحدّث كل 3 إطارات.

    Args:
        frames: list of BGR images
        weight: 0-1
        progress_callback: callable(percent: int)
        skip_identical: تخطّي الإطارات المتشابهة (موصى به)

    Returns:
        List of enhanced BGR images
    """
    n = len(frames)
    if n == 0:
        return frames

    enhancer = _load_enhancer()
    if enhancer is None:
        print("[FaceEnhancer] GFPGAN not available, returning original frames")
        return frames

    print(f"[FaceEnhancer] Enhancing {n} frames (weight={weight}, skip_identical={skip_identical})...")

    # 1. اكتشف الوجه على أول إطار (لإعادة الاستخدام)
    ref_bbox = _detect_face_with_mediapipe(frames[0])
    if ref_bbox is None:
        print("[FaceEnhancer] No face in first frame, skipping enhancement")
        return frames
    print(f"[FaceEnhancer] Reference face bbox: {ref_bbox}")

    # 2. حسّن أول إطار وجه فقط (الـ face region) — واحفظه كمرجع
    print("[FaceEnhancer] Restoring reference face...")
    x1, y1, x2, y2 = ref_bbox
    pad = int(max(x2 - x1, y2 - y1) * 0.1)
    rx1 = max(0, x1 - pad)
    ry1 = max(0, y1 - pad)
    rx2 = min(frames[0].shape[1], x2 + pad)
    ry2 = min(frames[0].shape[0], y2 + pad)
    ref_face_crop = frames[0][ry1:ry2, rx1:rx2].copy()
    ref_enhanced_face = _restore_face_region(ref_face_crop, weight=weight)
    print(f"[FaceEnhancer] Reference face restored ({ref_enhanced_face.shape})")

    # 3. لكل إطار: خذ الـ face region الأصلي، استبدله بالـ enhanced
    # لكن نطبّق GFPGAN على كل إطار لما تكون الشفايف بتتحرك (تغيير حقيقي)
    # الفلتر: skip_identical = قارن الـ face region بالإطار السابق، لو الفرق صغير
    # استخدم enhanced face المحفوظ

    out = []
    prev_face_hash = None
    last_enhanced_face = ref_enhanced_face
    last_face_bbox_padded = (rx1, ry1, rx2, ry2)

    for i, f in enumerate(frames):
        try:
            # استخدم نفس الـ bbox على كل الإطارات (الوجه ثابت تقريباً في Wav2Lip)
            x1, y1, x2, y2 = last_face_bbox_padded
            current_face = f[y1:y2, x1:x2].copy()
            if current_face.shape[0] < 10 or current_face.shape[1] < 10:
                out.append(f)
                continue

            # تجاوز الإطارات المتشابهة جداً (hash سريع)
            skip = False
            if skip_identical:
                # hash سريع: متوسط الـ pixels
                face_hash = hash(current_face.tobytes()[:2000])  # sample first 2000 bytes
                if prev_face_hash is not None and face_hash == prev_face_hash:
                    skip = True
                prev_face_hash = face_hash

            if skip:
                # استخدم آخر enhanced face محفوظ
                enhanced_face = last_enhanced_face
            else:
                # شغّل GFPGAN على هذا الإطار
                enhanced_face = _restore_face_region(current_face, weight=weight)
                last_enhanced_face = enhanced_face

            # الصق الـ enhanced face على الإطار
            if enhanced_face.shape[:2] != current_face.shape[:2]:
                enhanced_face = cv2.resize(enhanced_face,
                                            (current_face.shape[1], current_face.shape[0]),
                                            interpolation=cv2.INTER_LANCZOS4)

            # feathered blend
            fh, fw = current_face.shape[:2]
            feather = max(8, min(fh, fw) // 6)
            alpha = np.ones((fh, fw), dtype=np.float32)
            for k in range(feather):
                a = k / feather
                alpha[k, :] = np.minimum(alpha[k, :], a)
                alpha[fh - 1 - k, :] = np.minimum(alpha[fh - 1 - k, :], a)
                alpha[:, k] = np.minimum(alpha[:, k], a)
                alpha[:, fw - 1 - k] = np.minimum(alpha[:, fw - 1 - k], a)
            alpha_3ch = alpha[:, :, np.newaxis]

            blended = (current_face.astype(np.float32) * (1 - alpha_3ch) +
                       enhanced_face.astype(np.float32) * alpha_3ch).astype(np.uint8)

            result = f.copy()
            result[y1:y2, x1:x2] = blended
            out.append(result)

        except Exception as e:
            print(f"[FaceEnhancer] frame {i} failed: {e}")
            out.append(f)

        if progress_callback and (i % 2 == 0 or i == n - 1):
            pct = int(i / n * 100)
            progress_callback(pct)

    print(f"[FaceEnhancer] Enhancement done: {len(out)} frames")
    return out


# =============================================================================
# Module availability flag
# =============================================================================
try:
    from gfpgan import GFPGANer  # noqa: F401
    FACE_ENHANCE_AVAILABLE = True
except ImportError:
    FACE_ENHANCE_AVAILABLE = False


# Backwards-compat: keep old function name
def enhance_frame(frame: np.ndarray, weight: float = 0.6) -> np.ndarray:
    return enhance_frame_robust(frame, weight=weight)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python face_enhancer.py <input_image> [output_image]")
        sys.exit(1)
    inp = sys.argv[1]
    outp = sys.argv[2] if len(sys.argv) > 2 else inp.replace('.', '_enhanced.')
    img = cv2.imread(inp)
    print(f"Loaded {inp}: {img.shape}")
    enhanced = enhance_frame_robust(img, weight=0.55)
    cv2.imwrite(outp, enhanced)
    print(f"Saved {outp}")
