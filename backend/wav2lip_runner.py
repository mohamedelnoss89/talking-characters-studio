"""
Wav2Lip inference wrapper - يحول صورة + صوت لفيديو الـ lip sync حقيقي

NOTE: Heavy imports (torch, cv2, models, face_detection, w2l_audio) are
performed LAZILY inside the functions that need them. This allows the
FastAPI server to import this module and serve /voices and /tts endpoints
even when Wav2Lip's heavy dependencies (torch, the Wav2Lip/ submodule,
checkpoint files) are not installed. Only /lip-sync will fail with a
clear error in that case.
"""
import sys
import os
import subprocess
import platform
import shutil

# Add Wav2Lip to path (directory may not exist; that's fine, we check at use time)
WAV2LIP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Wav2Lip")
if os.path.isdir(WAV2LIP_DIR):
    sys.path.insert(0, WAV2LIP_DIR)

# These lightweight libs are always needed; import up front.
import numpy as np
import cv2  # opencv is always installed in this env


def _resolve_ffmpeg():
    """
    Resolve the ffmpeg binary path.

    Priority:
      1. WAV2LIP_FFMPEG_PATH env var (set by the desktop app to point at
         the bundled ffmpeg.exe inside resources/bin/)
      2. FFMPEG_PATH env var (same idea, alternative name)
      3. shutil.which("ffmpeg") — system PATH (works on dev machines and
         Linux servers where ffmpeg is installed globally)
      4. Fall back to bare "ffmpeg" — keeps the old behavior so any
         RuntimeError message still mentions ffmpeg by name.

    This is critical for the desktop app: most Windows users do NOT have
    ffmpeg in their PATH, and the Wav2Lip pipeline calls ffmpeg twice
    (audio conversion + final A/V merge). Without this resolution, both
    calls raise FileNotFoundError("[WinError 2]") and /lip-sync fails.
    """
    candidates = [
        os.environ.get("WAV2LIP_FFMPEG_PATH"),
        os.environ.get("FFMPEG_PATH"),
        shutil.which("ffmpeg"),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return "ffmpeg"  # last resort — let subprocess raise the error


def _ffmpeg_cmd(*extra_args):
    """Build an ffmpeg command list using the resolved binary path."""
    return [_resolve_ffmpeg()] + list(extra_args)

# Lazy-loaded heavy modules (torch / Wav2Lip submodules). We expose them
# via helper accessors so functions can call `_torch()` etc., and the
# module remains importable even if torch is missing.
_torch_module = None  # cache (NOT named _torch — that's the accessor fn)
_w2l_models = None  # cache for `models.Wav2Lip`
_face_detection_module = None  # cache
_w2l_audio_module = None  # cache
_tqdm_module = None  # cache


def _torch():
    """Lazy torch import. Raises ImportError with clear message if missing."""
    global _torch_module
    if _torch_module is None:
        try:
            import torch as _t
        except ImportError as e:
            raise ImportError(
                "torch is not installed. Wav2Lip video generation requires "
                "PyTorch. Install it with: pip install torch --index-url "
                "https://download.pytorch.org/whl/cpu"
            ) from e
        _torch_module = _t
    return _torch_module


def _w2l_Wav2Lip():
    global _w2l_models
    if _w2l_models is None:
        try:
            from models import Wav2Lip
        except ImportError as e:
            raise ImportError(
                f"Could not import Wav2Lip model class. Make sure the "
                f"Wav2Lip/ submodule exists under backend/. Original error: {e}"
            ) from e
        _w2l_models = Wav2Lip
    return _w2l_models


def _face_detection():
    global _face_detection_module
    if _face_detection_module is None:
        try:
            import face_detection as fd
        except ImportError as e:
            raise ImportError(
                f"face_detection package not available. Original error: {e}"
            ) from e
        _face_detection_module = fd
    return _face_detection_module


def _w2l_audio():
    global _w2l_audio_module
    if _w2l_audio_module is None:
        try:
            import audio as a
        except ImportError as e:
            raise ImportError(
                f"Wav2Lip 'audio' helper module not available. Original error: {e}"
            ) from e
        _w2l_audio_module = a
    return _w2l_audio_module


def _tqdm():
    global _tqdm_module
    if _tqdm_module is None:
        try:
            from tqdm import tqdm as _t
        except ImportError as e:
            raise ImportError(f"tqdm not installed: {e}") from e
        _tqdm_module = _t
    return _tqdm_module


# Eye blink post-processing (optional)
try:
    from eye_blink import BlinkProcessor
    BLINK_AVAILABLE = True
except ImportError as e:
    print(f"[Wav2Lip] WARNING: eye_blink module not available ({e})")
    BLINK_AVAILABLE = False

# Head movement is DISABLED by user request - keep flag for backward compat
HEAD_MOVEMENT_AVAILABLE = False

# Face enhancement (GFPGAN) - optional
try:
    from face_enhancer import enhance_frames, FACE_ENHANCE_AVAILABLE
    ENHANCE_AVAILABLE = FACE_ENHANCE_AVAILABLE
except ImportError as e:
    print(f"[Wav2Lip] WARNING: face_enhancer module not available ({e})")
    ENHANCE_AVAILABLE = False

# Lip enhancement - optional (also depends on legacy mediapipe.solutions API)
LIP_ENHANCE_AVAILABLE = False
try:
    import mediapipe as _mp_probe2  # noqa: F401
    if hasattr(_mp_probe2, 'solutions') and hasattr(_mp_probe2.solutions, 'face_mesh'):
        from lip_enhancer import enhance_lips_pipeline
        LIP_ENHANCE_AVAILABLE = True
        del _mp_probe2
    else:
        print("[Wav2Lip] WARNING: lip_enhancer disabled (mediapipe.solutions API not available)")
except ImportError as e:
    print(f"[Wav2Lip] WARNING: lip_enhancer module not available ({e})")

# Pro Lip Enhancer v2 - optional (uses legacy mediapipe.solutions API which
# was removed in mediapipe 0.10+; disable gracefully when unavailable).
PRO_LIP_AVAILABLE = False
try:
    import mediapipe as _mp_probe  # noqa: F401
    if hasattr(_mp_probe, 'solutions') and hasattr(_mp_probe.solutions, 'face_mesh'):
        from pro_lip_enhancer import enhance_lips_pro
        PRO_LIP_AVAILABLE = True
        del _mp_probe
    else:
        print("[Wav2Lip] WARNING: pro_lip_enhancer disabled (mediapipe.solutions API not available)")
except ImportError as e:
    print(f"[Wav2Lip] WARNING: pro_lip_enhancer module not available ({e})")

# Professional enhancer - optional (also depends on legacy mediapipe API)
PRO_ENHANCE_AVAILABLE = False
try:
    import mediapipe as _mp_probe3  # noqa: F401
    if hasattr(_mp_probe3, 'solutions') and hasattr(_mp_probe3.solutions, 'face_mesh'):
        from professional_enhancer import ProfessionalEnhancer
        PRO_ENHANCE_AVAILABLE = True
        del _mp_probe3
    else:
        print("[Wav2Lip] WARNING: professional_enhancer disabled (mediapipe.solutions API not available)")
except ImportError as e:
    print(f"[Wav2Lip] WARNING: professional_enhancer module not available ({e})")


def _check_wav2lip_available():
    """Raises a clear, user-friendly error if Wav2Lip can't run."""
    if not os.path.isdir(WAV2LIP_DIR):
        raise RuntimeError(
            f"Wav2Lip directory not found at {WAV2LIP_DIR}. "
            f"Clone the Wav2Lip repo into backend/Wav2Lip to enable video generation."
        )
    ckpt = os.path.join(WAV2LIP_DIR, "checkpoints", "wav2lip_gan.pth")
    if not os.path.isfile(ckpt):
        raise RuntimeError(
            f"Wav2Lip checkpoint not found at {ckpt}. "
            f"Download wav2lip_gan.pth and place it under "
            f"backend/Wav2Lip/checkpoints/."
        )
    # Will raise ImportError with clear message if torch is missing
    _torch()


# Output dirs (only create if Wav2Lip dir exists)
if os.path.isdir(WAV2LIP_DIR):
    TEMP_DIR = os.path.join(WAV2LIP_DIR, "temp")
    RESULTS_DIR = os.path.join(WAV2LIP_DIR, "results")
    os.makedirs(TEMP_DIR, exist_ok=True)
    os.makedirs(RESULTS_DIR, exist_ok=True)
else:
    TEMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
    RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
    os.makedirs(TEMP_DIR, exist_ok=True)
    os.makedirs(RESULTS_DIR, exist_ok=True)

# Config
CHECKPOINT_PATH = os.path.join(WAV2LIP_DIR, "checkpoints", "wav2lip_gan.pth")
IMG_SIZE = 96
MEL_STEP_SIZE = 16
FPS = 25

# Device — defer real detection until torch is needed. Default to 'cpu'
# so /health doesn't crash if torch is missing.
DEVICE = 'cpu'
try:
    import torch as _torch_probe  # noqa: F401
    if _torch_probe.cuda.is_available():
        DEVICE = 'cuda'
    del _torch_probe
except ImportError:
    pass
print(f"[Wav2Lip] Using device: {DEVICE}")

# Load model once
_model = None


def load_model():
    global _model
    if _model is not None:
        return _model
    _check_wav2lip_available()
    torch = _torch()
    Wav2Lip = _w2l_Wav2Lip()
    print(f"[Wav2Lip] Loading checkpoint from: {CHECKPOINT_PATH}")

    # The Wav2Lip+GAN checkpoint may be saved as either:
    #   (a) a pickled dict with "state_dict" key (original Wav2Lip), OR
    #   (b) a TorchScript archive (newer PyTorch auto-detects and dispatches
    #       to torch.jit.load).
    # We try both. weights_only=False is required for option (a) on torch 2.6+.
    try:
        checkpoint = torch.load(
            CHECKPOINT_PATH,
            map_location=lambda storage, loc: storage,
            weights_only=False,
        )
        # If it's a dict with "state_dict", use original path
        if isinstance(checkpoint, dict) and "state_dict" in checkpoint:
            s = checkpoint["state_dict"]
            new_s = {k.replace('module.', ''): v for k, v in s.items()}
            model = Wav2Lip()
            model.load_state_dict(new_s)
            print("[Wav2Lip] Model loaded from pickled state_dict")
        elif hasattr(checkpoint, "state_dict"):
            # TorchScript module — extract state_dict into Wav2Lip class
            sd = checkpoint.state_dict()
            new_s = {k.replace('module.', ''): v for k, v in sd.items()}
            model = Wav2Lip()
            model.load_state_dict(new_s)
            print("[Wav2Lip] Model loaded from TorchScript state_dict")
        else:
            raise RuntimeError(f"Unrecognized checkpoint format: {type(checkpoint)}")
    except (RuntimeError, ValueError) as e:
        # Fall back to torch.jit.load if torch.load fails (TorchScript archive)
        print(f"[Wav2Lip] torch.load failed ({e}); trying torch.jit.load...")
        jit_model = torch.jit.load(CHECKPOINT_PATH, map_location='cpu')
        sd = jit_model.state_dict()
        new_s = {k.replace('module.', ''): v for k, v in sd.items()}
        model = Wav2Lip()
        model.load_state_dict(new_s)
        print("[Wav2Lip] Model loaded from TorchScript via jit.load")

    model = model.to(DEVICE)
    model.eval()
    _model = model
    print("[Wav2Lip] Model loaded successfully")
    return model


def get_smoothened_boxes(boxes, T):
    for i in range(len(boxes)):
        if i + T > len(boxes):
            window = boxes[len(boxes) - T:]
        else:
            window = boxes[i : i + T]
        boxes[i] = np.mean(window, axis=0)
    return boxes


def _create_face_detector():
    """Create a fresh FaceAlignment detector instance."""
    face_detection = _face_detection()
    return face_detection.FaceAlignment(
        face_detection.LandmarksType._2D,
        flip_input=False,
        device=DEVICE
    )


def detect_all_faces(image):
    """
    كشف كل الوجوه الموجودة في صورة واحدة.

    Returns:
        list of dicts: [{"bbox": [x1, y1, x2, y2], "confidence": float, "index": int}, ...]
        مرتبة من اليسار لليمين (ومن فوق لتحت لو نفس x).
    بيرجع list فاضية لو مفيش وجوه.
    """
    if isinstance(image, str):
        image = cv2.imread(image)
        if image is None:
            raise ValueError(f"Could not read image: {image}")

    detector = _create_face_detector()
    try:
        # get_detections_for_batch بترجع list of rects (كل rect = [x1,y1,x2,y2] أو None)
        # لكن هي بترجع أكبر face بس لكل صورة. عشان نكشف كل الوجوه، نستخدم detect_faces
        try:
            # الواجهة الجديدة في face_detection package
            detections = detector.face_detector.detect_from_image(image.copy())
        except Exception:
            # fallback للواجهة القديمة
            detections = detector.get_detections_for_batch(np.array([image]))
            detections = detections[0] if detections else None
            if detections is not None:
                detections = [detections]
            else:
                detections = []

        results = []
        for i, det in enumerate(detections):
            if det is None:
                continue
            # det ممكن يكون array [x1,y1,x2,y2] أو dict فيه 'bbox' و 'score'
            if isinstance(det, dict):
                bbox = det.get('bbox') or det.get('box')
                score = det.get('score', det.get('confidence', 0.0))
            else:
                bbox = det
                score = 1.0
            if bbox is None:
                continue
            x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
            # تأكد إن القيم موجبة وضمن حدود الصورة
            x1 = max(0, min(image.shape[1] - 1, x1))
            y1 = max(0, min(image.shape[0] - 1, y1))
            x2 = max(0, min(image.shape[1], x2))
            y2 = max(0, min(image.shape[0], y2))
            if x2 - x1 < 10 or y2 - y1 < 10:
                continue  #太小，跳过
            results.append({
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "confidence": float(score) if isinstance(score, (int, float)) else 1.0,
            })

        # ترتيب من اليسار لليمين
        results.sort(key=lambda r: (r["bbox"][0], r["bbox"][1]))
        for i, r in enumerate(results):
            r["index"] = i
        return results
    finally:
        del detector


def face_detect(images, pads=(0, 10, 0, 0), batch_size=16, face_index=None):
    """
    كشف الوجه في كل صورة.

    Args:
        images: list of numpy images (عادة صورة واحدة مكررة)
        pads: (top, bottom, left, right) padding
        batch_size: حجم batch
        face_index: لو الصورة فيها أكتر من وجه، حدد index الوجه اللي هيتكلم
                   (None = أول وجه يتم كشفه، السلوك الأصلي)

    ملاحظة مهمة عن الذاكرة:
        لو face_index >= 0، بنستخدم detect_all_faces مباشرة (detector واحد بس)
        بدل ما نعمل detector إضافي. ده بيوفّر ~200MB رام، وبيمنع OOM على السيرفرات
        اللي عندها رام قليلة (< 4GB).
    """
    # =========================================================
    # فرع face_index: استخدم detector واحد بس (detect_all_faces)
    # بن_skip كشف الـ batch الأصلي تماماً عشان نوفر ذاكرة ووقت.
    # =========================================================
    if face_index is not None and face_index >= 0 and len(images) > 0:
        print(f"[Wav2Lip] face_index={face_index} requested, detecting all faces with single detector...")
        all_faces = detect_all_faces(images[0])
        print(f"[Wav2Lip] Found {len(all_faces)} faces in image")
        if len(all_faces) == 0:
            raise ValueError('Face not detected! Ensure the image contains a clear face.')
        if face_index >= len(all_faces):
            raise ValueError(
                f'face_index {face_index} out of range. Only {len(all_faces)} faces detected (0..{len(all_faces)-1}).'
            )
        selected = all_faces[face_index]
        # ابنِ predictions للوجه المحدد لكل صورة
        predictions = [selected["bbox"] for _ in images]
        # طبّق padding
        results = []
        pady1, pady2, padx1, padx2 = pads
        for rect, image in zip(predictions, images):
            y1 = max(0, int(rect[1]) - pady1)
            y2 = min(image.shape[0], int(rect[3]) + pady2)
            x1 = max(0, int(rect[0]) - padx1)
            x2 = min(image.shape[1], int(rect[2]) + padx2)
            # تأكد إن الـ bbox صالح (مش معكوس أو صغير جداً)
            if x2 - x1 < 10 or y2 - y1 < 10:
                raise ValueError(
                    f'Detected face box too small after padding: {x2-x1}x{y2-y1}. '
                    f'Try a clearer image or different face_index.'
                )
            results.append([x1, y1, x2, y2])
        boxes = np.array(results)
        boxes = get_smoothened_boxes(boxes, T=5)
        results = [
            [image[int(y1): int(y2), int(x1): int(x2)], (int(y1), int(y2), int(x1), int(x2))]
            for image, (x1, y1, x2, y2) in zip(images, boxes)
        ]
        # حرّر الذاكرة قبل ما نرجع (عشان model loading اللي بعده)
        import gc
        gc.collect()
        return results

    # =========================================================
    # السلوك الأصلي: كشف أول وجه في كل صورة (لـ face_index = None)
    # =========================================================
    face_detection = _face_detection()
    tqdm = _tqdm()
    detector = face_detection.FaceAlignment(
        face_detection.LandmarksType._2D,
        flip_input=False,
        device=DEVICE
    )

    predictions = []
    try:
        for i in tqdm(range(0, len(images), batch_size), desc="Face detection"):
            predictions.extend(detector.get_detections_for_batch(np.array(images[i:i + batch_size])))
    except RuntimeError:
        # Reduce batch size on OOM
        batch_size = 1
        predictions = []
        for i in tqdm(range(0, len(images), batch_size), desc="Face detection (batch=1)"):
            predictions.extend(detector.get_detections_for_batch(np.array(images[i:i + batch_size])))

    results = []
    pady1, pady2, padx1, padx2 = pads
    for rect, image in zip(predictions, images):
        if rect is None:
            raise ValueError('Face not detected in one of the frames! Ensure the image contains a clear face.')

        y1 = max(0, int(rect[1]) - pady1)
        y2 = min(image.shape[0], int(rect[3]) + pady2)
        x1 = max(0, int(rect[0]) - padx1)
        x2 = min(image.shape[1], int(rect[2]) + padx2)

        results.append([x1, y1, x2, y2])

    boxes = np.array(results)
    boxes = get_smoothened_boxes(boxes, T=5)
    results = [[image[int(y1): int(y2), int(x1): int(x2)], (int(y1), int(y2), int(x1), int(x2))] for image, (x1, y1, x2, y2) in zip(images, boxes)]

    del detector
    import gc
    gc.collect()
    return results


def run_lip_sync(
    image_path: str,
    audio_path: str,
    output_path: str,
    pads=(0, 20, 0, 0),  # padding أكبر للذقن = سياق أكتر للشفايف
    resize_factor: int = 1,
    face_det_batch_size: int = 4,
    wav2lip_batch_size: int = 16,
    progress_callback=None,
    face_index: int = None,
) -> str:
    """
    يحول صورة + ملف صوتي لفيديو lip sync حقيقي

    Args:
        image_path: مسار صورة الشخصية
        audio_path: مسار الملف الصوتي
        output_path: مسار الفيديو الناتج
        pads: (top, bottom, left, right) padding around face
        resize_factor: تقليل الدقة
        face_det_batch_size: حجم batch لكشف الوجه
        wav2lip_batch_size: حجم batch لنموذج Wav2Lip
        progress_callback: callable(percent: int)
        face_index: index الوجه اللي هيتكلم (لو الصورة فيها أكتر من وجه).
                    None = السلوك الأصلي (أول وجه يتم كشفه)
    Returns:
        output_path
    """
    if face_index is not None:
        print(f"[Wav2Lip] Starting lip sync: image={image_path}, audio={audio_path}, face_index={face_index}")
    else:
        print(f"[Wav2Lip] Starting lip sync: image={image_path}, audio={audio_path}")

    # Fail fast with a clear error if Wav2Lip is not set up
    _check_wav2lip_available()
    w2l_audio = _w2l_audio()
    torch = _torch()

    # 1. Load image
    full_frames = [cv2.imread(image_path)]
    if full_frames[0] is None:
        raise ValueError(f"Could not read image: {image_path}")
    print(f"[Wav2Lip] Image loaded: {full_frames[0].shape}")

    # 1.5. Upscale small images so eye blink post-processing has enough resolution.
    # MediaPipe needs at least ~15px eye height for clean warping; on a 230x250 image
    # the eye is only ~4px which produces invisible blinks. Upscale to >= 480px on the
    # shorter side (preserves aspect ratio).
    MIN_SIDE = 480
    h0, w0 = full_frames[0].shape[:2]
    if min(h0, w0) < MIN_SIDE:
        scale = MIN_SIDE / min(h0, w0)
        new_w = int(w0 * scale)
        new_h = int(h0 * scale)
        full_frames[0] = cv2.resize(full_frames[0], (new_w, new_h),
                                    interpolation=cv2.INTER_LANCZOS4)
        print(f"[Wav2Lip] Upscaled to {new_w}x{new_h} (scale={scale:.2f}) for blink quality")

    # 1.5b. Downscale large images to save memory.
    # Wav2Lip بيشتغل على face crops 96×96، فمش محتاجين صورة full-res كـ canvas.
    # صورة 1024×1024 بتيجي ~3MB لكل إطار × 289 إطار = 867MB في generated_frames.
    # بتصغير لـ 640×640 بنوفّر ~63% من الذاكرة (من 867MB لـ ~320MB).
    # ده بيدّي وضاحة كافية للـ face animation + بيمنع OOM على السيرفرات اللي رامها قليلة.
    MAX_SIDE = 640
    h0b, w0b = full_frames[0].shape[:2]
    if max(h0b, w0b) > MAX_SIDE:
        scale = MAX_SIDE / max(h0b, w0b)
        new_w = int(w0b * scale)
        new_h = int(h0b * scale)
        full_frames[0] = cv2.resize(full_frames[0], (new_w, new_h),
                                    interpolation=cv2.INTER_AREA)
        print(f"[Wav2Lip] Downscaled to {new_w}x{new_h} (scale={scale:.2f}) to save memory")

    # =====================================================================
    # 1.6. PRE-ENHANCE: GFPGAN على الصورة الأصلية مرة واحدة فقط
    # بدلاً من تطبيق GFPGAN على 690+ إطار (بياخد ساعات على CPU)،
    # نحسّن الصورة الأصلية مرة واحدة، ثم Wav2Lip يشتغل على الصورة المحسّنة.
    # النتيجة: شفايف أوضح في كل الإطارات + سرعة 100× أكتر
    # =====================================================================
    if ENHANCE_AVAILABLE:
        print("[Wav2Lip] Pre-enhancing source image with GFPGAN...")
        if progress_callback:
            progress_callback(5)
        try:
            from face_enhancer import enhance_frame_robust
            enhanced_img = enhance_frame_robust(full_frames[0].copy(), weight=0.55)
            # تحقق إنه فعلاً حصّل تغيير (مش skip)
            diff = (cv2.absdiff(full_frames[0], enhanced_img).mean() > 0.1)
            if diff:
                full_frames[0] = enhanced_img
                print("[Wav2Lip] Source image enhanced with GFPGAN ✓")
            else:
                print("[Wav2Lip] GFPGAN skipped (no face detected)")
        except Exception as e:
            print(f"[Wav2Lip] WARNING: pre-enhancement failed: {e}")
        if progress_callback:
            progress_callback(10)
    else:
        print("[Wav2Lip] Skipping pre-enhancement (GFPGAN not available)")
        if progress_callback:
            progress_callback(10)

    # 2. Convert audio to wav if needed
    if not audio_path.endswith('.wav'):
        temp_wav = os.path.join(TEMP_DIR, f"input_{os.getpid()}.wav")
        command = _ffmpeg_cmd(
            '-y',
            '-i', audio_path,
            '-ac', '1',           # mono
            '-ar', '16000',       # 16 kHz (Wav2Lip requirement)
            '-acodec', 'pcm_s16le',
            temp_wav
        )
        try:
            r = subprocess.run(command, capture_output=True, text=True, timeout=60)
            if r.returncode != 0 or not os.path.isfile(temp_wav):
                raise RuntimeError(
                    f"FFmpeg audio conversion failed (code {r.returncode}):\n"
                    f"stderr: {r.stderr[-1500:]}"
                )
        except subprocess.TimeoutExpired:
            raise RuntimeError("FFmpeg timed out converting audio (60s)")
        audio_path = temp_wav

    # 3. Load audio and compute mel spectrogram
    print("[Wav2Lip] Computing mel spectrogram...")
    wav = w2l_audio.load_wav(audio_path, 16000)
    mel = w2l_audio.melspectrogram(wav)
    print(f"[Wav2Lip] Mel shape: {mel.shape}")

    if np.isnan(mel.reshape(-1)).sum() > 0:
        raise ValueError('Mel contains NaN! Try a different audio file.')

    # 4. Split mel into chunks
    mel_chunks = []
    mel_idx_multiplier = 80.0 / FPS
    i = 0
    while 1:
        start_idx = int(i * mel_idx_multiplier)
        if start_idx + MEL_STEP_SIZE > len(mel[0]):
            mel_chunks.append(mel[:, len(mel[0]) - MEL_STEP_SIZE:])
            break
        mel_chunks.append(mel[:, start_idx : start_idx + MEL_STEP_SIZE])
        i += 1

    print(f"[Wav2Lip] Mel chunks: {len(mel_chunks)} (= number of video frames)")

    # 5. Duplicate the single frame to match mel chunks
    full_frames = [full_frames[0] for _ in range(len(mel_chunks))]

    # 6. Resize frames if needed
    if resize_factor > 1:
        full_frames = [cv2.resize(f, (f.shape[1]//resize_factor, f.shape[0]//resize_factor)) for f in full_frames]

    # 7. Face detection (on first frame, applied to all)
    print("[Wav2Lip] Running face detection...")
    face_det_results = face_detect([full_frames[0]], pads=pads, batch_size=1, face_index=face_index)
    face_det_results = face_det_results * len(full_frames)  # replicate

    # 8. Load model
    model = load_model()

    # 9. Generate video frames
    print("[Wav2Lip] Generating lip-synced frames...")
    frame_h, frame_w = full_frames[0].shape[:-1]
    temp_avi = os.path.join(TEMP_DIR, f"result_{os.getpid()}.avi")
    out = cv2.VideoWriter(
        temp_avi,
        cv2.VideoWriter_fourcc(*'DIVX'),
        FPS,
        (frame_w, frame_h)
    )

    total_chunks = len(mel_chunks)
    img_batch, mel_batch, frame_batch, coords_batch = [], [], [], []

    # نجمع الإطارات الناتجة في الذاكرة لمعالجة الرمش لاحقاً
    generated_frames = []

    def _process_batch_to_frames():
        """يعالج batch ويُرجع الإطارات الناتجة (دون كتابة مباشرة)."""
        img_arr = np.asarray(img_batch)
        mel_arr = np.asarray(mel_batch)

        img_masked = img_arr.copy()
        img_masked[:, IMG_SIZE//2:] = 0

        img_arr = np.concatenate((img_masked, img_arr), axis=3) / 255.
        mel_arr = np.reshape(mel_arr, [len(mel_arr), mel_arr.shape[1], mel_arr.shape[2], 1])

        img_tensor = torch.FloatTensor(np.transpose(img_arr, (0, 3, 1, 2))).to(DEVICE)
        mel_tensor = torch.FloatTensor(np.transpose(mel_arr, (0, 3, 1, 2))).to(DEVICE)

        with torch.no_grad():
            pred = model(mel_tensor, img_tensor)

        pred = pred.cpu().numpy().transpose(0, 2, 3, 1) * 255.

        batch_frames = []
        for p, f, c in zip(pred, frame_batch, coords_batch):
            y1, y2, x1, x2 = c
            p = cv2.resize(p.astype(np.uint8), (x2 - x1, y2 - y1))
            f[y1:y2, x1:x2] = p
            batch_frames.append(f)
        return batch_frames

    for i, m in enumerate(mel_chunks):
        idx = i % len(full_frames)
        frame_to_save = full_frames[idx].copy()
        face, coords = face_det_results[idx].copy()

        face = cv2.resize(face, (IMG_SIZE, IMG_SIZE))

        img_batch.append(face)
        mel_batch.append(m)
        frame_batch.append(frame_to_save)
        coords_batch.append(coords)

        if len(img_batch) >= wav2lip_batch_size:
            batch_frames = _process_batch_to_frames()
            generated_frames.extend(batch_frames)
            img_batch, mel_batch, frame_batch, coords_batch = [], [], [], []

        if progress_callback and i % 5 == 0:
            # progress: 10-70% for Wav2Lip generation (5% for pre-enhance, 10-70 = 60% range)
            progress_callback(10 + int(i / total_chunks * 60))

    # Process remaining batch
    if len(img_batch) > 0:
        batch_frames = _process_batch_to_frames()
        generated_frames.extend(batch_frames)

    print(f"[Wav2Lip] Generated {len(generated_frames)} frames")

    # =====================================================================
    # 9.4. Professional Enhancement (Frequency Blending)
    # يضيف ملمس الوجه وتفاصيل الجلد من GFPGAN على إطارات Wav2Lip.
    # الفكرة: GFPGAN مرة واحدة على الصورة الأصلية → طبقة تفاصيل مرجعية
    #         لكل إطار: ناخد low-freq من Wav2Lip (الحركة) + high-freq من GFPGAN (الملمس)
    #         النتيجة: وجه واضح + حركة شفايف طبيعية
    # السرعة: GFPGAN مرة واحدة (5s) + 1.6ms لكل إطار
    # =====================================================================
    if PRO_ENHANCE_AVAILABLE:
        print("[Wav2Lip] Applying professional enhancement (frequency blending)...")
        try:
            # progress: 70-80% during pro enhancement (10% range)
            def _pro_cb(p):
                if progress_callback:
                    progress_callback(70 + int(p * 0.10))
            # الصورة الأصلية المحسّنة بـ GFPGAN (المرجع للملمس)
            pro_enhancer = ProfessionalEnhancer(
                enhanced_source=full_frames[0].copy(),
                detail_strength=0.35,
            )
            generated_frames = pro_enhancer.enhance_batch(
                generated_frames,
                progress_callback=_pro_cb,
            )
            print(f"[Wav2Lip] Professional enhancement done ({len(generated_frames)} frames)")
            if progress_callback:
                progress_callback(80)
        except Exception as e:
            print(f"[Wav2Lip] WARNING: professional enhancement failed: {e}")
            import traceback
            traceback.print_exc()
            if progress_callback:
                progress_callback(80)
    else:
        print("[Wav2Lip] Skipping professional enhancement (module not available)")
        if progress_callback:
            progress_callback(80)

    # =====================================================================
    # 9.4b. Pro Lip Enhancement v2 (per-frame tracking + edge-aware sharpening)
    # هذا هو التحسين الاحترافي الجديد:
    #   - per-frame lip tracking (MediaPipe) → يشحذ الشفايف الفعلية مش bbox ثابت
    #   - edge-aware sharpening (bilateral + CLAHE + unsharp على قناة L)
    #   - detail transfer من مرجع GFPGAN إلى حواف الشفايف بس (يحافظ على الحركة)
    # لو مش متاح، نرجع للـ lip_enhancer القديم كـ fallback
    # =====================================================================
    if PRO_LIP_AVAILABLE:
        print("[Wav2Lip] Applying Pro Lip Enhancement v2 (per-frame, edge-aware)...")
        try:
            # progress: 80-82% during lip enhancement (2% range)
            def _pro_lip_cb(p):
                if progress_callback:
                    progress_callback(80 + int(p * 0.02))
            generated_frames = enhance_lips_pro(
                generated_frames,
                gfpgan_reference=full_frames[0].copy(),
                sharpen_amount=0.65,
                detail_strength=0.30,
                progress_callback=_pro_lip_cb,
            )
            print(f"[Wav2Lip] Pro lip enhancement done ({len(generated_frames)} frames)")
        except Exception as e:
            print(f"[Wav2Lip] WARNING: pro lip enhancement failed: {e}")
            import traceback
            traceback.print_exc()
            if progress_callback:
                progress_callback(82)
    elif LIP_ENHANCE_AVAILABLE:
        print("[Wav2Lip] Falling back to legacy lip enhancer...")
        try:
            def _lip_cb(p):
                if progress_callback:
                    progress_callback(80 + int(p * 0.02))
            generated_frames = enhance_lips_pipeline(
                generated_frames,
                static_image=full_frames[0].copy(),
                temporal_alpha=1.0,
                sharpen_amount=0.4,
                color_boost=False,
                progress_callback=_lip_cb,
            )
            print(f"[Wav2Lip] Legacy lip sharpening done ({len(generated_frames)} frames)")
        except Exception as e:
            print(f"[Wav2Lip] WARNING: lip sharpening failed: {e}")
            if progress_callback:
                progress_callback(82)
    else:
        print("[Wav2Lip] Skipping lip enhancement (no module available)")
        if progress_callback:
            progress_callback(82)

    # =====================================================================
    # 9.5. Eye Blink Post-Processing (v3)
    # =====================================================================
    if BLINK_AVAILABLE:
        print("[Wav2Lip] Applying eye blink post-processing (v4 professional)...")
        try:
            # progress: 82-90% during blink (8% range)
            def _blink_cb(p):
                if progress_callback:
                    progress_callback(82 + int(p * 0.08))
            blink_proc = BlinkProcessor(static_image=full_frames[0].copy())
            generated_frames = blink_proc.process_video_frames(
                generated_frames,
                fps=FPS,
                audio_path=audio_path,
                progress_callback=_blink_cb
            )
            blink_proc.close()
            print("[Wav2Lip] Eye blink applied successfully")
        except Exception as e:
            print(f"[Wav2Lip] WARNING: blink post-processing failed: {e}")
            if progress_callback:
                progress_callback(90)
    else:
        print("[Wav2Lip] Skipping blink (module not available)")
        if progress_callback:
            progress_callback(90)

    # =====================================================================
    # 9.5b. Head Movement - معطّل بناءً على طلب المستخدم
    # (المستخدم طلب تشيل حركة الراس خالص وسيب حركة الشفايف ورمش العين)
    # =====================================================================
    print("[Wav2Lip] Head movement disabled by user request (lip sync + eye blink only)")
    if progress_callback:
        progress_callback(95)

    if progress_callback:
        progress_callback(95)

    # =====================================================================
    # 9.6. Write frames to AVI
    # =====================================================================
    print(f"[Wav2Lip] Writing {len(generated_frames)} frames to AVI...")
    for f in generated_frames:
        out.write(f)
    out.release()
    print(f"[Wav2Lip] Frames written to {temp_avi}")

    # حرّر generated_frames فوراً بعد ما كتبناهم لـ AVI.
    # ده بيوفر ~300MB رام (لـ 640×640×3×289) قبل ما نبدأ خطوة ffmpeg.
    # ffmpeg بنفسه محتاج رام عشان libx264 encoding، فتحرير الذاكرة هنا ضروري
    # عشان نمنع OOM على السيرفرات اللي رامها قليلة (< 4GB).
    del generated_frames
    import gc
    gc.collect()
    print("[Wav2Lip] Memory freed after AVI write")

    # 10. Merge audio + video
    if progress_callback:
        progress_callback(85)

    print("[Wav2Lip] Merging audio with video...")
    # Get original audio path (might be temp wav)
    final_audio = audio_path if audio_path.endswith('.wav') else audio_path
    # جودة عالية: CRF 18 (visually lossless) + H.264 + AAC audio + faststart
    merge_cmd = _ffmpeg_cmd(
        '-y',
        '-i', temp_avi,
        '-i', final_audio,
        '-c:v', 'libx264',
        '-crf', '18',
        '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        '-shortest',
        output_path
    )
    try:
        r = subprocess.run(merge_cmd, capture_output=True, text=True, timeout=120)
        if r.returncode != 0 or not os.path.isfile(output_path):
            raise RuntimeError(
                f"FFmpeg merge failed (code {r.returncode}):\n"
                f"stderr: {r.stderr[-1500:]}"
            )
    except subprocess.TimeoutExpired:
        raise RuntimeError("FFmpeg timed out merging audio+video (120s)")
    print(f"[Wav2Lip] Final video: {output_path}")

    # Cleanup temp avi
    try:
        os.remove(temp_avi)
    except:
        pass

    if progress_callback:
        progress_callback(100)

    return output_path


if __name__ == "__main__":
    # Quick test
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--audio', required=True)
    parser.add_argument('--output', default='results/test.mp4')
    args = parser.parse_args()

    out = os.path.join(RESULTS_DIR, args.output) if not os.path.isabs(args.output) else args.output
    run_lip_sync(args.image, args.audio, out)
    print(f"Done! Output: {out}")
