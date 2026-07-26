"""
FastAPI server for Wav2Lip lip sync.
- POST /lip-sync: accepts image + audio file, returns generated video.
- GET /health: health check.
"""
import os
import sys
import uuid
import shutil
import asyncio
import subprocess
import json
from pathlib import Path

# Add backend dir to path
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BACKEND_DIR)

from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import uvicorn


def _resolve_ffmpeg():
    """
    Resolve the ffmpeg binary path.

    Priority: WAV2LIP_FFMPEG_PATH → FFMPEG_PATH → shutil.which("ffmpeg") → "ffmpeg".

    Critical for the desktop app: most Windows users do NOT have ffmpeg in
    their PATH, but we bundle it in resources/bin/ffmpeg.exe. The Electron
    main process sets WAV2LIP_FFMPEG_PATH before spawning this server.
    """
    for c in (
        os.environ.get("WAV2LIP_FFMPEG_PATH"),
        os.environ.get("FFMPEG_PATH"),
        shutil.which("ffmpeg"),
    ):
        if c and os.path.isfile(c):
            return c
    return "ffmpeg"

# Import tts_engine (needed for /voices and /tts) — try gracefully
try:
    import tts_engine
    TTS_AVAILABLE = True
except Exception as e:
    print(f"[Server] WARNING: tts_engine not available ({e})")
    TTS_AVAILABLE = False

# ---------------------------------------------------------------------------
# Wav2Lip: deferred import + background model pre-load
# ---------------------------------------------------------------------------
# CRITICAL (v1.1.14+): wav2lip_runner imports torch (5-10s), mediapipe (2-3s),
# opencv (1-2s) at module load time. Doing this at server.py top-level
# blocked uvicorn from starting for 8-15s, which delayed /health and made
# the desktop app appear to hang on startup.
#
# Now we import wav2lip_runner in a BACKGROUND THREAD that starts when
# uvicorn starts (via the lifespan handler below). The /health endpoint
# returns immediately with wav2lip_available=False + wav2lip_importing=True,
# and /lip-sync waits for the import to finish before proceeding.
#
# This cuts server startup time from ~15-30s down to ~3-5s.
WAV2LIP_AVAILABLE = False
wav2lip_runner = None  # will be set by _import_and_preload_wav2lip_background()

import threading
import re
_model_load_status = {
    "loaded": False,
    "loading": False,
    "error": None,
    "import_done": False,  # True after wav2lip_runner import finishes (success or fail)
    "thread_started": False,  # v1.1.23: True once the import thread has been kicked off
    "deferred": False,  # v1.1.23: True on low-RAM — import deferred to first /lip-sync
}
_wav2lip_lock = threading.Lock()


# ============================================================
# v1.1.21: Low-Memory Mode — automatic detection + override flag.
#
# The Wav2Lip pipeline normally needs ~4-5GB of RAM at peak:
#   - Wav2Lip model (~415MB) + GFPGAN model (~300MB) in memory
#   - ~750 generated frames × 640×640×3 bytes = ~920MB
#   - Additional copies during pro_enhance + lip_enhance + eye_blink passes
#
# On a 4GB machine, Windows alone eats ~2GB, leaving only ~2GB for the app.
# Without Low-Memory Mode, /lip-sync crashes with OOM mid-generation.
#
# Low-Memory Mode (auto-enabled when RAM < 6GB):
#   - Skips pro_enhance and pro_lip_enhance passes (saves ~1.5GB peak)
#   - Uses smaller frames (480×480 instead of 640×640, saves ~44% frame memory)
#   - Streams frames to AVI as they're generated instead of holding all in RAM
#   - Smaller batch sizes (4 instead of 8) to reduce peak tensor memory
#
# The user can also toggle it manually via the /lip-sync `low_memory` form
# field, which overrides the auto-detection.
# ============================================================
import psutil  # type: ignore

# Threshold below which Low-Memory Mode is auto-enabled (in GB).
# 6GB chosen because: Windows (~2GB) + app stack (~1GB) leaves ~3GB for the
# pipeline, and Low-Memory Mode needs ~2.5GB peak. Above 6GB, full quality
# is safe. Below 6GB, we MUST enable Low-Memory to avoid OOM.
LOW_MEMORY_THRESHOLD_GB = 6.0

# Cache the total system RAM so we don't call psutil on every request.
_total_ram_gb_cache: float | None = None


def _get_total_ram_gb() -> float:
    """Return total physical RAM in GB (cached after first call)."""
    global _total_ram_gb_cache
    if _total_ram_gb_cache is None:
        try:
            _total_ram_gb_cache = psutil.virtual_memory().total / (1024 ** 3)
        except Exception:
            # If psutil fails (shouldn't happen, it's in requirements),
            # assume a safe large value so we don't accidentally enable
            # Low-Memory Mode on a machine that actually has plenty of RAM.
            _total_ram_gb_cache = 16.0
    return _total_ram_gb_cache


def _should_use_low_memory(user_override: str | None = None) -> bool:
    """
    Decide whether to use Low-Memory Mode for this /lip-sync call.

    Priority:
      1. Explicit user override via the `low_memory` form field
         ("true"/"1"/"yes" → force on, "false"/"0"/"no" → force off)
      2. Auto-detection: if total RAM < LOW_MEMORY_THRESHOLD_GB, enable it
      3. Default: off (full quality)

    Returns True if Low-Memory Mode should be active for this call.
    """
    if user_override is not None:
        v = user_override.strip().lower()
        if v in ("true", "1", "yes", "on"):
            return True
        if v in ("false", "0", "no", "off"):
            return False
    return _get_total_ram_gb() < LOW_MEMORY_THRESHOLD_GB

def _import_and_preload_wav2lip_background():
    """
    Background thread: import wav2lip_runner (which imports torch etc.)
    and then pre-load the Wav2Lip model checkpoint.

    Phase 1 (import): ~5-15s on CPU — imports torch, mediapipe, opencv.
    Phase 2 (model load): ~30s-3min on CPU — loads the 415MB checkpoint.

    Both phases run in this single background thread so the main uvicorn
    event loop is never blocked.
    """
    global WAV2LIP_AVAILABLE, wav2lip_runner
    if _model_load_status["loading"] or _model_load_status["import_done"]:
        return
    with _wav2lip_lock:
        if _model_load_status["loading"] or _model_load_status["import_done"]:
            return
        _model_load_status["loading"] = True

        # ---- Phase 1: import wav2lip_runner ----
        print("[Server] Background wav2lip_runner import started...", flush=True)
        try:
            import wav2lip_runner as _wlr
            _wlr._check_wav2lip_available()
            wav2lip_runner = _wlr
            WAV2LIP_AVAILABLE = True
            print("[Server] wav2lip_runner imported successfully.", flush=True)
        except Exception as e:
            WAV2LIP_AVAILABLE = False
            _model_load_status["loading"] = False
            _model_load_status["import_done"] = True
            _model_load_status["error"] = f"import failed: {e}"
            print(f"[Server] WARNING: wav2lip_runner not available ({e}). /lip-sync disabled.", flush=True)
            return
        finally:
            # Mark import as done regardless of success/failure so /lip-sync
            # and /health can stop waiting.
            _model_load_status["import_done"] = True

        # ---- Phase 2: pre-load the model ----
        # v1.1.22: SKIP the model pre-load on low-RAM machines (<6GB).
        # Loading the 415MB checkpoint on top of torch (~700MB) + opencv +
        # mediapipe pushes total memory >2GB, which on a 4GB machine triggers
        # heavy paging and makes the entire startup take 3-5 minutes.
        #
        # Instead, on low-RAM we let /health respond as soon as the import
        # finishes (~5-15s), and load the model LAZILY on the first /lip-sync
        # call. The user can use image generation immediately, and the first
        # video generation will be slow (loads the model then) but subsequent
        # ones will be fast.
        if not WAV2LIP_AVAILABLE or wav2lip_runner is None:
            return
        try:
            total_ram = _get_total_ram_gb()
        except Exception:
            total_ram = 16.0  # safe default — assume plenty of RAM
        if total_ram < LOW_MEMORY_THRESHOLD_GB:
            print(
                f"[Server] Low-RAM mode ({total_ram:.1f}GB < {LOW_MEMORY_THRESHOLD_GB}GB): "
                "skipping model pre-load. Model will load on first /lip-sync call.",
                flush=True,
            )
            _model_load_status["loading"] = False
            # NOTE: _model_load_status["loaded"] stays False — /lip-sync will
            # call load_model() itself on first invocation.
            return
        print("[Server] Background model pre-load started...", flush=True)
        try:
            wav2lip_runner.load_model()
            _model_load_status["loaded"] = True
            _model_load_status["loading"] = False
            print("[Server] Background model pre-load complete.", flush=True)
        except Exception as e:
            _model_load_status["loading"] = False
            _model_load_status["error"] = str(e)
            print(f"[Server] Background model pre-load FAILED: {e}", flush=True)

# Background model pre-loading state.
# CRITICAL: We start uvicorn FIRST and pre-load the Wav2Lip model in a background
# thread. This way /health responds immediately (within ~2 seconds of launch),
# and the Electron main process's health check succeeds quickly. The previous
# approach called load_model() BEFORE uvicorn.run(), which blocked startup for
# 1-3 minutes on a regular CPU (loading a 415MB checkpoint) and caused the
# Electron launcher to time out at 60s.

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    """FastAPI lifespan: kicks off background wav2lip import + model pre-load."""
    # Startup: schedule background import + pre-load in a SINGLE thread.
    # The import (torch, mediapipe, opencv) takes 5-15s, and the model
    # pre-load takes 30s-3min. Running both in one thread avoids race
    # conditions and ensures /lip-sync can wait for both to finish.
    #
    # v1.1.23: On low-RAM (<6GB), DON'T start the background thread at all.
    # The import of wav2lip_runner triggers `import numpy` (~150MB) and
    # `import cv2` (~250MB) at module load time, plus `import torch` (~700MB)
    # shortly after. On 4GB RAM with heavy paging, these imports hold the
    # GIL for 2-4 minutes, blocking /health and making the backend appear
    # dead to the desktop launcher (which times out at 5 min).
    #
    # Instead, on low-RAM we defer the ENTIRE import to the first /lip-sync
    # call. uvicorn starts in ~3s, /health responds immediately, and the
    # user can use image generation right away. The first /lip-sync will
    # be slow (1-3 min for imports + 30-90s for model load) but subsequent
    # calls will be fast.
    try:
        total_ram = _get_total_ram_gb()
    except Exception:
        total_ram = 16.0  # safe default — assume plenty of RAM

    if total_ram >= LOW_MEMORY_THRESHOLD_GB:
        _model_load_status["thread_started"] = True
        t = threading.Thread(target=_import_and_preload_wav2lip_background, daemon=True)
        t.start()
        print("[Server] Scheduled background wav2lip import + model pre-load. uvicorn is ready to serve requests.", flush=True)
    else:
        print(
            f"[Server] Low-RAM mode ({total_ram:.1f}GB < {LOW_MEMORY_THRESHOLD_GB}GB): "
            "DEFERRING wav2lip import to first /lip-sync call. "
            "/health responds immediately, image generation works right away. "
            "First video generation will be slow (loading models).",
            flush=True,
        )
        # Mark deferred mode so _wait_for_wav2lip_import knows to start the
        # thread itself when /lip-sync is first called.
        _model_load_status["deferred"] = True

    yield
    # Shutdown
    print("[Server] Shutting down...", flush=True)

app = FastAPI(title="Wav2Lip Lip Sync API", version="1.0", lifespan=lifespan)

# CORS - allow Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directories
UPLOAD_DIR = os.path.join(BACKEND_DIR, "uploads")
OUTPUT_DIR = os.path.join(BACKEND_DIR, "outputs")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Track active jobs
jobs: dict[str, dict] = {}

class JobStatus(BaseModel):
    job_id: str
    status: str  # 'pending' | 'processing' | 'completed' | 'error'
    progress: int = 0
    message: str = ""
    video_path: str | None = None
    error: str | None = None


@app.get("/health")
async def health():
    # Preflight probes for media dependencies. The frontend can read these
    # to show a clear error instead of waiting 6 minutes for a timeout.
    ffmpeg_path = _resolve_ffmpeg()
    ffmpeg_available = (
        ffmpeg_path != "ffmpeg"
        or shutil.which("ffmpeg") is not None
    )
    node_bin = os.environ.get("TCS_NODE_BIN") or shutil.which("node") or "node"
    node_available = (
        node_bin != "node"
        or shutil.which("node") is not None
    )
    sdk_path = os.path.join(BACKEND_DIR, "node_modules", "z-ai-web-dev-sdk")
    sdk_available = os.path.isdir(sdk_path)
    zai_config_path = os.path.join(BACKEND_DIR, ".z-ai-config")
    zai_config_available = os.path.isfile(zai_config_path)

    # v1.1.21: expose RAM info so the frontend can show a Low-Memory Mode
    # warning and explain WHY video generation is slower than usual.
    total_ram_gb = _get_total_ram_gb()
    low_memory_auto = total_ram_gb < LOW_MEMORY_THRESHOLD_GB
    try:
        avail_ram_gb = psutil.virtual_memory().available / (1024 ** 3)
    except Exception:
        avail_ram_gb = 0.0

    return {
        "status": "ok",
        "device": (wav2lip_runner.DEVICE if WAV2LIP_AVAILABLE and wav2lip_runner else "cpu"),
        "model_loaded": (WAV2LIP_AVAILABLE and wav2lip_runner is not None and wav2lip_runner._model is not None),
        "model_loading": _model_load_status["loading"],
        "model_load_error": _model_load_status["error"],
        "wav2lip_importing": not _model_load_status["import_done"],
        "tts_available": TTS_AVAILABLE,
        "wav2lip_available": WAV2LIP_AVAILABLE,
        # Media preflight flags (added v1.1.6)
        "ffmpeg_available": ffmpeg_available,
        "ffmpeg_path": ffmpeg_path,
        "node_available": node_available,
        "node_path": node_bin,
        "image_gen_available": sdk_available and zai_config_available and node_available,
        "zai_sdk_available": sdk_available,
        "zai_config_available": zai_config_available,
        # v1.1.21: Low-Memory Mode info
        "total_ram_gb": round(total_ram_gb, 2),
        "available_ram_gb": round(avail_ram_gb, 2),
        "low_memory_threshold_gb": LOW_MEMORY_THRESHOLD_GB,
        "low_memory_auto_enabled": low_memory_auto,
    }


async def _wait_for_wav2lip_import(timeout_s: float = 30.0) -> bool:
    """
    Wait for the background wav2lip_runner import to finish.

    Called by /lip-sync and /detect-faces before they access wav2lip_runner.
    If the import is still running (server just started), this blocks until
    it's done or the timeout expires.

    v1.1.23: On low-RAM machines, the import is DEFERRED from startup to
    here (the first /lip-sync call). If we detect that the import thread
    hasn't started yet, we start it now. Callers on low-RAM should pass
    a longer timeout (e.g., 180s) to allow for the slow import.

    Returns True if wav2lip_runner is available, False otherwise.
    """
    if WAV2LIP_AVAILABLE and wav2lip_runner is not None:
        return True
    if _model_load_status.get("import_done") and not WAV2LIP_AVAILABLE:
        # Import already failed — don't wait
        return False

    # v1.1.23: If the import hasn't been started yet (low-RAM deferred mode),
    # start it now. This is the first /lip-sync call.
    if (not _model_load_status["loading"]
        and not _model_load_status["import_done"]
        and not _model_load_status.get("thread_started", False)):
        print("[Server] Starting deferred wav2lip import (triggered by /lip-sync)...", flush=True)
        _model_load_status["thread_started"] = True
        t = threading.Thread(target=_import_and_preload_wav2lip_background, daemon=True)
        t.start()

    # Wait for import to finish
    deadline = asyncio.get_event_loop().time() + timeout_s
    while not _model_load_status["import_done"]:
        if asyncio.get_event_loop().time() > deadline:
            return False
        await asyncio.sleep(0.5)
    return WAV2LIP_AVAILABLE and wav2lip_runner is not None



# ============================================================
# TTS endpoints
# ============================================================
@app.get("/voices")
async def list_voices():
    """يرجع قائمة الأصوات المقترحة."""
    if not TTS_AVAILABLE:
        # fallback hardcoded list
        return {"voices": [
            {"id": "ar-EG-SalmaNeural", "name": "سلمى", "gender": "Female", "lang": "ar-EG", "label_ar": "سلمى (مصر - أنثى)", "label_en": "Salma (Egypt - Female)"},
            {"id": "ar-EG-ShakirNeural", "name": "شاكر", "gender": "Male", "lang": "ar-EG", "label_ar": "شاكر (مصر - ذكر)", "label_en": "Shakir (Egypt - Male)"},
            {"id": "ar-SA-HamedNeural", "name": "حامد", "gender": "Male", "lang": "ar-SA", "label_ar": "حامد (السعودية - ذكر)", "label_en": "Hamed (Saudi - Male)"},
            {"id": "ar-SA-ZariyahNeural", "name": "زارية", "gender": "Female", "lang": "ar-SA", "label_ar": "زارية (السعودية - أنثى)", "label_en": "Zariyah (Saudi - Female)"},
        ], "default": "ar-EG-SalmaNeural"}
    return {"voices": tts_engine.get_voices(), "default": tts_engine.get_default_voice()}


@app.post("/tts")
async def text_to_speech(
    text: str = Form(...),
    voice: str = Form("ar-EG-SalmaNeural"),
    rate: str = Form("+0%"),
):
    """
    يحوّل نص إلى ملف صوتي MP3.
    Returns: MP3 file directly.
    """
    if not TTS_AVAILABLE:
        raise HTTPException(status_code=503, detail="TTS engine غير متوفر على السيرفر")

    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="النص فاضي")
    if len(text) > 5000:
        raise HTTPException(status_code=400, detail="النص طويل جداً (الحد الأقصى 5000 حرف)")

    job_id = str(uuid.uuid4())[:8]
    job_dir = os.path.join(UPLOAD_DIR, "tts_" + job_id)
    os.makedirs(job_dir, exist_ok=True)
    out_path = os.path.join(job_dir, "tts_output.mp3")

    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            tts_engine.synthesize_speech,
            text, voice, out_path, rate, "+0%", "+0Hz"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"فشل TTS: {e}")

    if not os.path.isfile(out_path):
        raise HTTPException(status_code=500, detail="ملف الصوت ما اتولّدش")

    return FileResponse(
        out_path,
        media_type="audio/mpeg",
        filename=f"tts_{voice}.mp3",
    )


# ============================================================
# Face Detection endpoint (for multi-face images)
# ============================================================
@app.post("/detect-faces")
async def detect_faces(file: UploadFile = File(...)):
    """
    كشف كل الوجوه في صورة. بيرجع list من الوجوه مع bbox و confidence و index.

    الاستخدام: قبل ما المستخدم يبدأ lip-sync على صورة فيها أكتر من وجه،
    الـ frontend بينادي على الـ endpoint ده ويعرض boxes عشان المستخدم يختار
    الوجه اللي هيتكلم.

    Returns:
        {
            "faces": [
                {"bbox": [x1, y1, x2, y2], "confidence": float, "index": int},
                ...
            ],
            "image_width": int,
            "image_height": int,
        }
    """
    # Wait for wav2lip_runner import to finish (server may have just started)
    # v1.1.23: On low-RAM, the import is deferred to here (first /lip-sync or
    # /detect-faces). Use a longer timeout (180s) to allow for the slow import
    # on 4GB RAM (torch ~700MB + cv2 ~250MB + mediapipe ~150MB with heavy paging).
    import_timeout = 180.0 if _get_total_ram_gb() < LOW_MEMORY_THRESHOLD_GB else 30.0
    ready = await _wait_for_wav2lip_import(timeout_s=import_timeout)
    if not ready:
        raise HTTPException(
            status_code=503,
            detail="جاري تحميل نموذج Wav2Lip... استنى دقيقة وحاول تاني."
        )

    # احفظ الصورة مؤقتاً
    job_id = str(uuid.uuid4())[:8]
    job_dir = os.path.join(UPLOAD_DIR, "faces_" + job_id)
    os.makedirs(job_dir, exist_ok=True)
    image_ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
    image_path = os.path.join(job_dir, f"input_image{image_ext}")
    try:
        with open(image_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save image: {e}")

    # كشف الوجوه
    try:
        loop = asyncio.get_event_loop()
        faces = await loop.run_in_executor(
            None,
            wav2lip_runner.detect_all_faces,
            image_path,
        )
    except Exception as e:
        # نظّف الملف المؤقت
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Face detection failed: {e}")

    # اقرأ أبعاد الصورة
    try:
        import cv2 as _cv2
        img = _cv2.imread(image_path)
        h, w = img.shape[:2] if img is not None else (0, 0)
    except Exception:
        h, w = 0, 0

    # نظّف الملف المؤقت
    shutil.rmtree(job_dir, ignore_errors=True)

    return {
        "faces": faces,
        "image_width": w,
        "image_height": h,
        "count": len(faces),
    }


@app.post("/lip-sync")
async def lip_sync(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),       # image (jpg/png)
    audio: UploadFile = File(None),     # optional audio file (لو المستخدم رفع صوت جاهز)
    text: str = Form(None),             # optional script text (لو المستخدم كتب سكربت)
    voice: str = Form("ar-EG-SalmaNeural"),  # voice id لو هنستخدم TTS
    rate: str = Form("+0%"),            # سرعة الكلام
    pads: str = Form("0,10,0,0"),
    resize_factor: int = Form(1),
    face_index: int = Form(-1),         # index الوجه اللي هيتكلم (-1 = تلقائي/أول وجه)
    low_memory: str = Form(None),       # v1.1.21: "true"/"false" override for Low-Memory Mode
):
    """
    Accept image + (script OR audio), run Wav2Lip, return the result video.

    - file: image (jpg/png) - the character face
    - audio: optional audio file (wav/mp3) - لو المستخدم رفع صوت جاهز
    - text: optional script - لو المستخدم كتب نص، هنولّد منه صوت بـ TTS
    - voice: voice id لـ TTS
    - rate: سرعة الكلام لـ TTS
    - pads: comma-separated padding "top,bottom,left,right"
    - resize_factor: 1 = full res

    لازم one of (audio, text) يكون موجود.
    """
    # Wait for wav2lip_runner import to finish (server may have just started)
    # v1.1.23: On low-RAM, the import is deferred to here (first /lip-sync or
    # /detect-faces). Use a longer timeout (180s) to allow for the slow import
    # on 4GB RAM (torch ~700MB + cv2 ~250MB + mediapipe ~150MB with heavy paging).
    import_timeout = 180.0 if _get_total_ram_gb() < LOW_MEMORY_THRESHOLD_GB else 30.0
    ready = await _wait_for_wav2lip_import(timeout_s=import_timeout)
    if not ready:
        raise HTTPException(
            status_code=503,
            detail="جاري تحميل نموذج Wav2Lip... استنى دقيقة وحاول تاني."
        )

    if not audio and not (text and text.strip()):
        raise HTTPException(
            status_code=400,
            detail="لازم ترفع ملف صوتي أو تكتب سكربت"
        )

    job_id = str(uuid.uuid4())[:8]
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    # Save image
    image_ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
    image_path = os.path.join(job_dir, f"input_image{image_ext}")
    try:
        with open(image_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save image: {e}")

    # Audio: لو رفع صوت جاهز نستخدمه، غير كده نولّد بـ TTS
    if audio and audio.filename:
        audio_ext = os.path.splitext(audio.filename)[1] or ".wav"
        audio_path = os.path.join(job_dir, f"input_audio{audio_ext}")
        try:
            with open(audio_path, "wb") as f:
                shutil.copyfileobj(audio.file, f)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to save audio: {e}")
        tts_used = False
    else:
        # TTS path
        audio_path = os.path.join(job_dir, "tts_audio.mp3")
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                tts_engine.synthesize_speech,
                text, voice, audio_path, rate, "+0%", "+0Hz"
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"فشل TTS: {e}")
        tts_used = True

    # Parse pads
    try:
        pads_list = [int(x.strip()) for x in pads.split(",")]
        if len(pads_list) != 4:
            raise ValueError("Need 4 pad values")
        pads_tuple = tuple(pads_list)
    except Exception:
        pads_tuple = (0, 10, 0, 0)

    output_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")

    # Update job status
    jobs[job_id] = {
        "status": "processing",
        "progress": 0,
        "message": "Starting Wav2Lip...",
        "video_path": None,
        "error": None,
    }

    def progress_callback(p: int):
        jobs[job_id]["progress"] = p
        if p < 80:
            jobs[job_id]["message"] = f"Generating lip sync frames... {p}%"
        elif p < 100:
            jobs[job_id]["message"] = "Merging audio with video..."
        else:
            jobs[job_id]["message"] = "Completed"

    # Run Wav2Lip in background
    async def run_job():
        try:
            # Run sync function in thread pool to not block event loop
            # لو face_index = -1 (default)، نمرر None عشان run_lip_sync يستخدم السلوك الأصلي
            face_idx_arg = face_index if face_index is not None and face_index >= 0 else None

            # v1.1.21: Low-Memory Mode decision — user override first, else
            # auto-detect based on total system RAM. When active, wav2lip_runner
            # skips pro_enhance + pro_lip_enhance, uses smaller frames (480px),
            # and reduces batch size from 8 → 4 to lower peak tensor memory.
            use_low_memory = _should_use_low_memory(low_memory)
            if use_low_memory:
                print(f"[Job {job_id}] Low-Memory Mode ENABLED (total RAM: {_get_total_ram_gb():.2f}GB)")
            else:
                print(f"[Job {job_id}] Full quality mode (total RAM: {_get_total_ram_gb():.2f}GB)")

            wav2lip_batch_sz = 4 if use_low_memory else 8

            loop = asyncio.get_event_loop()
            # نستخدم lambda عشان نمرر face_index + low_memory كـ keyword arguments
            await loop.run_in_executor(
                None,
                lambda: wav2lip_runner.run_lip_sync(
                    image_path,
                    audio_path,
                    output_path,
                    pads_tuple,
                    resize_factor,
                    4,                  # face_det_batch_size
                    wav2lip_batch_sz,   # wav2lip_batch_size — 4 في low-memory، 8 عادي
                    progress_callback,
                    face_idx_arg,
                    use_low_memory,     # low_memory flag
                ),
            )
            jobs[job_id]["status"] = "completed"
            jobs[job_id]["progress"] = 100
            jobs[job_id]["message"] = "Done"
            jobs[job_id]["video_path"] = output_path
            print(f"[Job {job_id}] Completed: {output_path}")
        except Exception as e:
            jobs[job_id]["status"] = "error"
            err_str = str(e)
            jobs[job_id]["error"] = err_str
            jobs[job_id]["message"] = f"Error: {err_str}"
            # Classify the error so the frontend can show a clean localized message
            err_lower = err_str.lower()
            if "wav2lip directory not found" in err_lower or "checkpoint not found" in err_lower or "wav2lip" in err_lower and "not found" in err_lower:
                jobs[job_id]["error_type"] = "wav2lip_unavailable"
            elif "torch" in err_lower or "no module named 'torch'" in err_lower:
                jobs[job_id]["error_type"] = "torch_missing"
            elif "tts" in err_lower or "edge_tts" in err_lower:
                jobs[job_id]["error_type"] = "tts_failed"
            else:
                jobs[job_id]["error_type"] = "unknown"
            print(f"[Job {job_id}] Error ({jobs[job_id]['error_type']}): {e}")
            import traceback
            traceback.print_exc()

    background_tasks.add_task(run_job)

    return JSONResponse({
        "job_id": job_id,
        "status": "processing",
        "message": "Lip sync started. Poll /status/{job_id} for progress.",
        "poll_interval_ms": 1500,
    })


# ============================================================
# Multi-speaker lip-sync endpoint
# ============================================================
# بينشئ فيديو واحد فيه حوار بين أكتر من شخصية في نفس الصورة.
# كل شخصية (face_index) بتقول سكربت مختلف بالصوت اللي المستخدم يحدده.
# العملية:
#   1. لكل script entry: ولّد TTS → شغّل Wav2Lip بـ face_index ده → segment.mp4
#   2. ادمج كل الـ segments بـ ffmpeg concat → final.mp4
# الـ progress بيتحدّث بـ: (segment_index / total_segments) * 100 + intra_segment_progress
@app.post("/lip-sync-multi")
async def lip_sync_multi(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    scripts: str = Form(...),  # JSON array of {face_index, text, voice, rate}
    low_memory: str = Form(None),  # v1.1.21: same override as /lip-sync
):
    """
    Multi-speaker lip sync.

    - file: image (jpg/png) - فيها أكتر من شخصية
    - scripts: JSON array, كل عنصر فيه:
        {
            "face_index": int,    # index الوجه اللي هيتكلم (من detect-faces)
            "text": str,          # السكربت اللي هيتقال
            "voice": str,         # voice id لـ TTS
            "rate": str           # سرعة الكلام "+0%"
        }
    """
    # Wait for wav2lip_runner import to finish (server may have just started)
    # v1.1.23: On low-RAM, the import is deferred to here (first /lip-sync or
    # /detect-faces). Use a longer timeout (180s) to allow for the slow import
    # on 4GB RAM (torch ~700MB + cv2 ~250MB + mediapipe ~150MB with heavy paging).
    import_timeout = 180.0 if _get_total_ram_gb() < LOW_MEMORY_THRESHOLD_GB else 30.0
    ready = await _wait_for_wav2lip_import(timeout_s=import_timeout)
    if not ready:
        raise HTTPException(
            status_code=503,
            detail="جاري تحميل نموذج Wav2Lip... استنى دقيقة وحاول تاني."
        )

    if not TTS_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="عذرًا، محرك TTS غير متاح — ميزة الحوار متعدد المتحدثين محتاجة TTS."
        )

    # Parse scripts JSON
    try:
        scripts_list = json.loads(scripts)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid scripts JSON: {e}")

    if not isinstance(scripts_list, list) or len(scripts_list) == 0:
        raise HTTPException(status_code=400, detail="scripts لازم يكون array غير فاضي")

    # Validate each entry
    for i, s in enumerate(scripts_list):
        if not isinstance(s, dict):
            raise HTTPException(status_code=400, detail=f"Entry {i} مش object")
        if "face_index" not in s or "text" not in s:
            raise HTTPException(status_code=400, detail=f"Entry {i} محتاج face_index و text")
        if not str(s["text"]).strip():
            raise HTTPException(status_code=400, detail=f"Entry {i} النص فاضي")
        if not isinstance(s["face_index"], int) or s["face_index"] < 0:
            raise HTTPException(status_code=400, detail=f"Entry {i} face_index لازم يكون رقم >= 0")
        # set defaults
        s.setdefault("voice", "ar-EG-SalmaNeural")
        s.setdefault("rate", "+0%")

    # Limit max entries to prevent abuse
    if len(scripts_list) > 6:
        raise HTTPException(
            status_code=400,
            detail="حد أقصى 6 فقرات حوار للفيديو الواحد (عشان الذاكرة والوقت)"
        )

    job_id = str(uuid.uuid4())[:8]
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    # Save image
    image_ext = os.path.splitext(file.filename or "image.png")[1] or ".png"
    image_path = os.path.join(job_dir, f"input_image{image_ext}")
    try:
        with open(image_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save image: {e}")

    output_path = os.path.join(OUTPUT_DIR, f"{job_id}.mp4")

    # Update job status
    jobs[job_id] = {
        "status": "processing",
        "progress": 0,
        "message": "بدء الحوار المتعدد...",
        "video_path": None,
        "error": None,
        "total_segments": len(scripts_list),
        "current_segment": 0,
    }

    def multi_progress_callback(seg_idx: int, total: int, p: int):
        """يحسب الـ progress الكلي بناءً على segment index + intra-segment progress."""
        # seg_idx 0-based, p من 0-100 داخل الـ segment
        # الكلي = (seg_idx / total) * 100 + (p / total)
        overall = int((seg_idx / total) * 100 + (p / total))
        jobs[job_id]["progress"] = overall
        jobs[job_id]["current_segment"] = seg_idx + 1
        if p < 80:
            jobs[job_id]["message"] = f"فقرة {seg_idx+1}/{total}: بتوليد الإطارات... {p}%"
        elif p < 100:
            jobs[job_id]["message"] = f"فقرة {seg_idx+1}/{total}: بدمج الصوت..."
        else:
            jobs[job_id]["message"] = f"فقرة {seg_idx+1}/{total} خلصت"

    async def run_multi_job():
        try:
            loop = asyncio.get_event_loop()

            # v1.1.21: Low-Memory Mode decision (same logic as /lip-sync).
            # Multi-speaker videos are even more memory-intensive because each
            # segment loads frames independently, so the auto-detection is
            # especially important here.
            use_low_memory = _should_use_low_memory(low_memory)
            if use_low_memory:
                print(f"[Multi {job_id}] Low-Memory Mode ENABLED (total RAM: {_get_total_ram_gb():.2f}GB)")
            wav2lip_batch_sz = 4 if use_low_memory else 8

            # إنشاء دالة sync بتشغّل كل segments بالترتيب
            def process_all():
                segment_paths = []
                total = len(scripts_list)
                for idx, script_entry in enumerate(scripts_list):
                    seg_output = os.path.join(job_dir, f"segment_{idx}.mp4")
                    face_idx = script_entry["face_index"]
                    text = script_entry["text"]
                    voice = script_entry["voice"]
                    rate = script_entry["rate"]

                    print(f"[Multi {job_id}] Segment {idx+1}/{total}: face={face_idx}, voice={voice}, text_len={len(text)}, low_memory={use_low_memory}")

                    # 1. TTS لهذا الـ segment
                    seg_audio = os.path.join(job_dir, f"tts_{idx}.mp3")
                    tts_engine.synthesize_speech(text, voice, seg_audio, rate, "+0%", "+0Hz")

                    # 2. Wav2Lip بـ face_index
                    def _seg_cb(p, _idx=idx, _total=total):
                        multi_progress_callback(_idx, _total, p)

                    wav2lip_runner.run_lip_sync(
                        image_path,
                        seg_audio,
                        seg_output,
                        (0, 10, 0, 0),    # pads
                        1,                # resize_factor
                        4,                # face_det_batch_size
                        wav2lip_batch_sz, # wav2lip_batch_size — 4 في low-memory، 8 عادي
                        _seg_cb,
                        face_idx,         # face_index
                        use_low_memory,   # low_memory flag
                    )
                    segment_paths.append(seg_output)
                    print(f"[Multi {job_id}] Segment {idx+1} done: {seg_output}")

                # 3. ادمج كل الـ segments
                if len(segment_paths) == 1:
                    # لو في segment واحد بس، انسخه للـ output مباشرة
                    import shutil as _sh
                    _sh.copy2(segment_paths[0], output_path)
                else:
                    # ffmpeg concat: استخدم concat demuxer (الأسرع والأفضل)
                    concat_list_path = os.path.join(job_dir, "concat_list.txt")
                    with open(concat_list_path, "w") as f:
                        for sp in segment_paths:
                            # ffmpeg concat بيتطلب file paths بـ escaping لو فيها مسافات
                            abs_path = os.path.abspath(sp)
                            f.write(f"file '{abs_path}'\n")

                    merge_cmd = [
                        _resolve_ffmpeg(), '-y',
                        '-f', 'concat',
                        '-safe', '0',
                        '-i', concat_list_path,
                        '-c', 'copy',  # copy بدون re-encode (كل segments بنفس الـ codec)
                        output_path
                    ]
                    try:
                        r = subprocess.run(merge_cmd, capture_output=True, text=True, timeout=180)
                        if r.returncode != 0 or not os.path.isfile(output_path):
                            # fallback: re-encode لو copy فشل (ممكن لو الـ segments ليهم نفس الـ codec)
                            print(f"[Multi {job_id}] concat copy failed, trying re-encode: {r.stderr[-500:]}")
                            merge_cmd2 = [
                                _resolve_ffmpeg(), '-y',
                                '-f', 'concat',
                                '-safe', '0',
                                '-i', concat_list_path,
                                '-c:v', 'libx264',
                                '-crf', '18',
                                '-preset', 'fast',
                                '-pix_fmt', 'yuv420p',
                                '-c:a', 'aac',
                                '-b:a', '128k',
                                '-movflags', '+faststart',
                                output_path
                            ]
                            r2 = subprocess.run(merge_cmd2, capture_output=True, text=True, timeout=300)
                            if r2.returncode != 0 or not os.path.isfile(output_path):
                                raise RuntimeError(
                                    f"FFmpeg concat failed (code {r2.returncode}):\n{r2.stderr[-1500:]}"
                                )
                    except subprocess.TimeoutExpired:
                        raise RuntimeError("FFmpeg concat timed out (180s)")

                # 4. نظّف الـ segments المؤقتة (الـ output النهائي محفوظ)
                for sp in segment_paths:
                    try:
                        os.remove(sp)
                    except:
                        pass

                return output_path

            await loop.run_in_executor(None, process_all)

            jobs[job_id]["status"] = "completed"
            jobs[job_id]["progress"] = 100
            jobs[job_id]["message"] = "Done"
            jobs[job_id]["video_path"] = output_path
            print(f"[Multi Job {job_id}] Completed: {output_path}")
        except Exception as e:
            jobs[job_id]["status"] = "error"
            err_str = str(e)
            jobs[job_id]["error"] = err_str
            jobs[job_id]["message"] = f"Error: {err_str}"
            err_lower = err_str.lower()
            if "wav2lip" in err_lower and "not found" in err_lower:
                jobs[job_id]["error_type"] = "wav2lip_unavailable"
            elif "torch" in err_lower:
                jobs[job_id]["error_type"] = "torch_missing"
            elif "tts" in err_lower or "edge_tts" in err_lower:
                jobs[job_id]["error_type"] = "tts_failed"
            elif "face_index" in err_lower and "out of range" in err_lower:
                jobs[job_id]["error_type"] = "face_index_out_of_range"
            else:
                jobs[job_id]["error_type"] = "unknown"
            print(f"[Multi Job {job_id}] Error ({jobs[job_id]['error_type']}): {e}")
            import traceback
            traceback.print_exc()

    background_tasks.add_task(run_multi_job)

    return JSONResponse({
        "job_id": job_id,
        "status": "processing",
        "message": f"Multi-speaker lip sync started ({len(scripts_list)} segments). Poll /status/{job_id}",
        "poll_interval_ms": 1500,
        "total_segments": len(scripts_list),
    })


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = jobs[job_id]
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "message": job["message"],
        "error": job["error"],
        "error_type": job.get("error_type", "unknown") if job["status"] == "error" else None,
        "has_video": job["video_path"] is not None and os.path.isfile(job["video_path"]),
    }


@app.get("/download/{job_id}")
async def download_video(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = jobs[job_id]
    if job["status"] != "completed" or not job["video_path"]:
        raise HTTPException(status_code=400, detail=f"Job not completed (status: {job['status']})")
    if not os.path.isfile(job["video_path"]):
        raise HTTPException(status_code=404, detail="Video file missing")

    return FileResponse(
        job["video_path"],
        media_type="video/mp4",
        filename=f"talking-character-{job_id}.mp4",
    )


@app.delete("/jobs/{job_id}")
async def cleanup_job(job_id: str):
    """Clean up job artifacts"""
    if job_id in jobs:
        # Remove upload dir
        job_dir = os.path.join(UPLOAD_DIR, job_id)
        if os.path.isdir(job_dir):
            shutil.rmtree(job_dir, ignore_errors=True)
        # Remove output
        video_path = jobs[job_id].get("video_path")
        if video_path and os.path.isfile(video_path):
            try:
                os.remove(video_path)
            except:
                pass
        del jobs[job_id]
    return {"status": "cleaned"}



# ============================================================
# Character Generation endpoints (using z-ai-web-dev-sdk via subprocess)
# ============================================================
# بما إن توليد الصور بالـ AI بياخد ~30 ثانية، وعشان نتجنب أي proxy timeout،
# بنستخدم job-based pattern:
#   POST /generate-character → يبدأ job ويرجع job_id فوراً
#   GET  /generate-character/{job_id} → polling للحالة
# الـ generation بيشتغل في thread مستقل عشان ما يعملش block للـ event loop.

import threading
import json as _json
import subprocess as _subprocess
import time as _time

gen_jobs: dict[str, dict] = {}

STYLE_PRESETS_PY = {
    "realistic": "photorealistic, ultra-detailed, 8k, professional photography, natural lighting, sharp focus, high resolution portrait",
    "anime": "anime style, cel-shaded, vibrant colors, detailed eyes, studio ghibli inspired, clean line art",
    "cartoon": "cartoon style, bold outlines, flat colors, exaggerated features, playful, pixar-inspired 3D cartoon",
    "3d": "3D render, octane render, cinema 4D, subsurface scattering, detailed textures, professional 3D character",
    "oil": "oil painting, thick brush strokes, classical art style, rich textures, rembrandt lighting",
    "watercolor": "watercolor painting, soft washes, delicate brushwork, artistic, hand-painted, flowing colors",
}
GENDER_HINT_PY = {
    "male": "male, man, masculine features",
    "female": "female, woman, feminine features",
    "any": "",
}

# Path to the Node script that does the actual generation
GEN_SCRIPT_PATH = os.path.join(BACKEND_DIR, "gen_character_worker.js")


def _run_gen_job(job_id: str, prompt: str, style: str, gender: str, language: str):
    """Background thread: calls the Node worker script to generate the character."""
    job = gen_jobs.get(job_id)
    if not job:
        return
    try:
        job["status"] = "processing"
        job["progress"] = 5
        job["message"] = "بدء التوليد..." if language == "ar" else "Starting..."

        # Call the Node worker script via Popen so we can drain stderr
        # progressively (avoids the ~64KB pipe-buffer deadlock that would
        # otherwise leave the child hanging until the 6-min client timeout)
        # AND we can push real-time progress messages to the polling client.
        #
        # On desktop, TCS_NODE_BIN points to Electron's executable running
        # in Node mode (ELECTRON_RUN_AS_NODE=1). On a dev machine with
        # Node.js installed, we fall back to "node".
        env = os.environ.copy()
        node_bin = env.get("TCS_NODE_BIN") or "node"
        # Make sure ELECTRON_RUN_AS_NODE is set if we're using Electron's
        # executable — otherwise it tries to launch a GUI window.
        if node_bin and node_bin != "node" and "ELECTRON_RUN_AS_NODE" not in env:
            env["ELECTRON_RUN_AS_NODE"] = "1"
        # Make sure the worker can `require('z-ai-web-dev-sdk')` by adding
        # backend/node_modules to NODE_PATH (Electron's Node doesn't read
        # the local node_modules by default when invoked as a subprocess).
        if "NODE_PATH" not in env:
            env["NODE_PATH"] = os.path.join(BACKEND_DIR, "node_modules")
        proc = _subprocess.Popen(
            [node_bin, GEN_SCRIPT_PATH, _json.dumps({
                "prompt": prompt,
                "style": style,
                "gender": gender,
                "language": language,
            })],
            stdout=_subprocess.PIPE, stderr=_subprocess.PIPE, text=True, env=env,
        )

        stderr_lines: list[str] = []
        def _pump_stderr():
            try:
                assert proc.stderr is not None
                for line in proc.stderr:
                    stderr_lines.append(line)
                    ln = line.strip()
                    # Surface worker milestones as user-visible progress
                    if "Fast-path" in ln:
                        # v1.1.20: simple English prompt — skipped LLM
                        job["progress"] = 20
                        job["message"] = "توليد مباشر بدون ترجمة..." if language == "ar" else "Direct generation (no translation)..."
                    elif "Translating" in ln:
                        job["progress"] = 15
                        job["message"] = "جاري ترجمة الوصف..." if language == "ar" else "Translating prompt..."
                    elif "Generation attempt" in ln:
                        m = re.search(r"attempt (\d+)/(\d+)", ln)
                        if m:
                            n, total = int(m.group(1)), int(m.group(2))
                            job["progress"] = min(90, 30 + int((n - 1) / total * 55))
                            if n == 1:
                                job["message"] = "جاري توليد الصورة..." if language == "ar" else "Generating image..."
                            else:
                                job["message"] = ("إعادة صياغة ومحاولة تانية..." if language == "ar" else "Rephrasing and retrying...")
                    elif "Done" in ln:
                        job["progress"] = 98
            except Exception:
                pass
        _t = threading.Thread(target=_pump_stderr, daemon=True)
        _t.start()

        try:
            # v1.1.20: Reduced from 360s → 200s (3 min 20s).
            # The worker now has tighter per-call timeouts (60s image, 20s LLM)
            # and only 2 total attempts (initial + 1 retry).
            # New worst case: 20+60+20+60 = 160s + subprocess overhead ~200s.
            # If it hasn't completed by 200s, something is genuinely stuck
            # and the user should retry with a different prompt.
            stdout, _ = proc.communicate(timeout=200)
        except _subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.communicate(timeout=5)
            except Exception:
                pass
            raise

        result_stderr = "".join(stderr_lines)
        class _R:
            pass
        result = _R()
        result.stdout = stdout or ""
        result.stderr = result_stderr
        result.returncode = proc.returncode

        # Try to parse stdout JSON FIRST, even if returncode != 0.
        # The worker writes a clean JSON error object to stdout before exiting,
        # so we should never rely on stderr for the user-facing error message.
        out = (result.stdout or "").strip()
        parsed = None
        first = out.find("{")
        last = out.rfind("}")
        if first != -1 and last != -1:
            try:
                parsed = _json.loads(out[first:last + 1])
            except Exception:
                parsed = None

        if parsed is not None and isinstance(parsed, dict):
            if parsed.get("success"):
                data = parsed
            else:
                err = parsed.get("error", "Generation failed")
                err_type = parsed.get("error_type", "unknown")
                print(f"[gen-job {job_id}] FAILED type={err_type} elapsed={result.stdout[:200]!r}", flush=True)
                job["status"] = "error"
                job["error"] = err
                job["error_type"] = err_type
                job["message"] = err
                return
        else:
            # No JSON in stdout — fall back to stderr
            err_tail = (result.stderr or "")[-400:]
            print(f"[gen-job {job_id}] FAILED rc={result.returncode} stderr={err_tail}", flush=True)
            job["status"] = "error"
            job["error"] = f"Worker failed: {err_tail[-200:]}" if result.stderr else "Worker failed"
            job["message"] = job["error"]
            return

        job["status"] = "completed"
        job["progress"] = 100
        job["message"] = "اكتمل" if language == "ar" else "Done"
        job["image_base64"] = data.get("image_base64", "")
        job["image_mime"] = data.get("image_mime", "image/png")
        job["prompt_used"] = data.get("prompt_used", "")
        job["description_ar"] = data.get("description_ar", "")
        job["description_en"] = data.get("description_en", "")
        job["style"] = style
        job["gender"] = gender

    except _subprocess.TimeoutExpired:
        job["status"] = "error"
        job["error"] = "انتهى الوقت" if language == "ar" else "Timed out"
        job["message"] = job["error"]
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        job["message"] = job["error"]


class GenCharRequest(BaseModel):
    prompt: str
    style: str = "realistic"
    gender: str = "any"
    language: str = "ar"


@app.post("/generate-character")
async def generate_character(req: GenCharRequest):
    """Start a character generation job. Returns job_id immediately."""
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="اكتب وصف للشخصية" if req.language == "ar" else "Describe a character")
    if len(prompt) > 1000:
        raise HTTPException(status_code=400, detail="الوصف طويل جداً" if req.language == "ar" else "Too long")

    style = req.style if req.style in STYLE_PRESETS_PY else "realistic"
    gender = req.gender if req.gender in GENDER_HINT_PY else "any"
    language = "en" if req.language == "en" else "ar"

    job_id = f"gen_{uuid.uuid4().hex[:12]}"
    gen_jobs[job_id] = {
        "status": "processing",
        "progress": 5,
        "message": "بدء التوليد..." if language == "ar" else "Starting...",
        "started_at": asyncio.get_event_loop().time(),
    }

    # Start background thread
    t = threading.Thread(
        target=_run_gen_job,
        args=(job_id, prompt, style, gender, language),
        daemon=True,
    )
    t.start()

    return {"success": True, "job_id": job_id}


@app.get("/generate-character/{job_id}")
async def get_gen_character_status(job_id: str):
    """Poll character generation job status."""
    job = gen_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Clean up old completed/error jobs (> 10 minutes)
    now = asyncio.get_event_loop().time()
    for jid in list(gen_jobs.keys()):
        j = gen_jobs.get(jid)
        if j and j.get("started_at") and now - j["started_at"] > 600:
            if jid != job_id:
                gen_jobs.pop(jid, None)

    return {
        "success": job.get("status") == "completed",
        "status": job.get("status", "processing"),
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "image_base64": job.get("image_base64", ""),
        "image_mime": job.get("image_mime", "image/png"),
        "prompt_used": job.get("prompt_used", ""),
        "description_ar": job.get("description_ar", ""),
        "description_en": job.get("description_en", ""),
        "style": job.get("style", ""),
        "gender": job.get("gender", ""),
        "error": job.get("error"),
    }


@app.get("/character-styles")
async def list_character_styles():
    """Return available character styles."""
    return {
        "styles": [
            {"id": "realistic", "label": "واقعي / Realistic"},
            {"id": "anime", "label": "أنمي / Anime"},
            {"id": "cartoon", "label": "كرتون / Cartoon"},
            {"id": "3d", "label": "3D"},
            {"id": "oil", "label": "زيت / Oil"},
            {"id": "watercolor", "label": "ألوان مائية / Watercolor"},
        ],
        "genders": [
            {"id": "any", "label_ar": "أي نوع", "label_en": "Any"},
            {"id": "male", "label_ar": "ذكر", "label_en": "Male"},
            {"id": "female", "label_ar": "أنثى", "label_en": "Female"},
        ],
    }


# ============================================================
# Character Editing endpoints (AI image-to-image editing)
# ============================================================
# POST /edit-character → يبدأ job تعديل صورة موجودة ويرجع job_id فوراً
# GET  /edit-character/{job_id} → polling للحالة

EDIT_SCRIPT_PATH = os.path.join(BACKEND_DIR, "edit_character_worker.js")
edit_jobs: dict[str, dict] = {}


def _run_edit_job(job_id: str, image_b64: str, edit_prompt: str, language: str):
    """Background thread: calls the Node worker to edit the image."""
    job = edit_jobs.get(job_id)
    if not job:
        return
    t0 = _time.time()
    try:
        job["status"] = "processing"
        job["progress"] = 10
        job["message"] = "بتعديل الصورة..." if language == "ar" else "Editing image..."
        print(f"[edit-job {job_id}] start prompt={edit_prompt[:60]!r} img_len={len(image_b64)}", flush=True)

        env = os.environ.copy()
        # Pass input via stdin to avoid "Argument list too long" for large images
        input_payload = _json.dumps({
            "image_base64": image_b64,
            "edit_prompt": edit_prompt,
            "language": language,
        })
        print(f"[edit-job {job_id}] payload size: {len(input_payload)} bytes", flush=True)
        result = _subprocess.run(
            ["node", EDIT_SCRIPT_PATH],
            input=input_payload,
            capture_output=True, text=True, timeout=180, env=env,
        )

        elapsed = _time.time() - t0
        out = result.stdout.strip()

        # Try to parse stdout JSON FIRST, even if returncode != 0.
        # The worker writes a clean JSON error object to stdout before exiting,
        # so we should never rely on stderr for the user-facing error message.
        parsed = None
        first = out.find("{")
        last = out.rfind("}")
        if first != -1 and last != -1:
            try:
                parsed = _json.loads(out[first:last + 1])
            except Exception:
                parsed = None

        if parsed is not None and isinstance(parsed, dict):
            if parsed.get("success"):
                job["status"] = "completed"
                job["progress"] = 100
                job["message"] = "اكتمل التعديل" if language == "ar" else "Edit done"
                job["image_base64"] = parsed.get("image_base64", "")
                job["image_mime"] = parsed.get("image_mime", "image/png")
                job["prompt_used"] = parsed.get("prompt_used", edit_prompt)
                print(f"[edit-job {job_id}] COMPLETED elapsed={elapsed:.1f}s img_len={len(job['image_base64'])}", flush=True)
                return
            else:
                err = parsed.get("error", "Edit failed")
                err_type = parsed.get("error_type", "unknown")
                print(f"[edit-job {job_id}] FAILED type={err_type} elapsed={elapsed:.1f}s err={err[:200]!r}", flush=True)
                job["status"] = "error"
                job["error"] = err
                job["error_type"] = err_type
                job["message"] = err
                return

        # Fallback: no JSON in stdout — use stderr
        if result.returncode != 0:
            err_tail = (result.stderr or "")[-400:]
            print(f"[edit-job {job_id}] FAILED rc={result.returncode} elapsed={elapsed:.1f}s stderr={err_tail}", flush=True)
            job["status"] = "error"
            job["error"] = f"Worker failed: {err_tail[-200:]}" if result.stderr else "Worker failed"
            job["error_type"] = "worker_crash"
            job["message"] = job["error"]
            return

        # No JSON, rc=0 — shouldn't happen, but handle it
        print(f"[edit-job {job_id}] FAILED invalid output elapsed={elapsed:.1f}s stdout_head={out[:200]!r}", flush=True)
        job["status"] = "error"
        job["error"] = "Invalid worker output"
        job["error_type"] = "invalid_output"
        job["message"] = job["error"]

    except _subprocess.TimeoutExpired:
        elapsed = _time.time() - t0
        print(f"[edit-job {job_id}] TIMEOUT after {elapsed:.1f}s", flush=True)
        job["status"] = "error"
        job["error"] = "انتهى الوقت" if language == "ar" else "Timed out"
        job["message"] = job["error"]
    except Exception as e:
        elapsed = _time.time() - t0
        print(f"[edit-job {job_id}] EXCEPTION after {elapsed:.1f}s: {e}", flush=True)
        job["status"] = "error"
        job["error"] = str(e)
        job["message"] = job["error"]


class EditCharRequest(BaseModel):
    image_base64: str
    edit_prompt: str
    language: str = "ar"


@app.post("/edit-character")
async def edit_character(req: EditCharRequest):
    """Start an image edit job. Returns job_id immediately."""
    image_b64 = (req.image_base64 or "").strip()
    edit_prompt = (req.edit_prompt or "").strip()
    language = "en" if req.language == "en" else "ar"

    if not image_b64 or len(image_b64) < 1000:
        raise HTTPException(status_code=400, detail="صورة غير صالحة" if language == "ar" else "Invalid image")
    if not edit_prompt:
        raise HTTPException(status_code=400, detail="اكتب التعديل المطلوب" if language == "ar" else "Describe the edit")
    if len(edit_prompt) > 1000:
        raise HTTPException(status_code=400, detail="التعديل طويل جداً" if language == "ar" else "Edit too long")

    job_id = f"edit_{uuid.uuid4().hex[:12]}"
    edit_jobs[job_id] = {
        "status": "processing",
        "progress": 10,
        "message": "بتعديل الصورة..." if language == "ar" else "Editing image...",
        "started_at": asyncio.get_event_loop().time(),
    }

    t = threading.Thread(
        target=_run_edit_job,
        args=(job_id, image_b64, edit_prompt, language),
        daemon=True,
    )
    t.start()

    return {"success": True, "job_id": job_id}


@app.get("/edit-character/{job_id}")
async def get_edit_character_status(job_id: str):
    """Poll image edit job status."""
    job = edit_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    now = asyncio.get_event_loop().time()
    for jid in list(edit_jobs.keys()):
        j = edit_jobs.get(jid)
        if j and j.get("started_at") and now - j["started_at"] > 600:
            if jid != job_id:
                edit_jobs.pop(jid, None)

    return {
        "success": job.get("status") == "completed",
        "status": job.get("status", "processing"),
        "progress": job.get("progress", 0),
        "message": job.get("message", ""),
        "image_base64": job.get("image_base64", ""),
        "image_mime": job.get("image_mime", "image/png"),
        "prompt_used": job.get("prompt_used", ""),
        "error": job.get("error"),
        "error_type": job.get("error_type"),
    }


if __name__ == "__main__":
    # NOTE: Model pre-loading is now handled by the FastAPI lifespan handler
    # (see `lifespan()` above). uvicorn starts immediately, and the model
    # loads in a background thread. This is critical because the previous
    # approach (blocking pre-load before uvicorn.run) caused the Electron
    # launcher's 60s health-check timeout to fire on slow CPUs.
    print("[Server] Starting server on port 8000...", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
