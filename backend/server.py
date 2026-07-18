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

# Import tts_engine (needed for /voices and /tts) — try gracefully
try:
    import tts_engine
    TTS_AVAILABLE = True
except Exception as e:
    print(f"[Server] WARNING: tts_engine not available ({e})")
    TTS_AVAILABLE = False

# Import wav2lip_runner — if missing (torch/checkpoints), run in degraded mode.
# /health and /voices and /tts still work; /lip-sync will return a clear error.
WAV2LIP_AVAILABLE = False
try:
    import wav2lip_runner
    # Verify that the actual model files are present too, not just the import
    try:
        wav2lip_runner._check_wav2lip_available()
        WAV2LIP_AVAILABLE = True
    except Exception as e:
        print(f"[Server] WARNING: wav2lip_runner imported but model files missing ({e}). /lip-sync will return 503.")
        WAV2LIP_AVAILABLE = False
except Exception as e:
    print(f"[Server] WARNING: wav2lip_runner not available ({e}). Running in degraded mode — /lip-sync disabled.")
    WAV2LIP_AVAILABLE = False

# Background model pre-loading state.
# CRITICAL: We start uvicorn FIRST and pre-load the Wav2Lip model in a background
# thread. This way /health responds immediately (within ~2 seconds of launch),
# and the Electron main process's health check succeeds quickly. The previous
# approach called load_model() BEFORE uvicorn.run(), which blocked startup for
# 1-3 minutes on a regular CPU (loading a 415MB checkpoint) and caused the
# Electron launcher to time out at 60s.
import threading
import re
_model_load_status = {"loaded": False, "loading": False, "error": None}

def _preload_model_background():
    """Pre-load the Wav2Lip model in a background thread. Sets _model_load_status."""
    if _model_load_status["loaded"] or _model_load_status["loading"]:
        return
    if not WAV2LIP_AVAILABLE:
        return
    _model_load_status["loading"] = True
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

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    """FastAPI lifespan: kicks off background model pre-load on startup."""
    # Startup: schedule background pre-load
    if WAV2LIP_AVAILABLE:
        t = threading.Thread(target=_preload_model_background, daemon=True)
        t.start()
        print("[Server] Scheduled background model pre-load. uvicorn is ready to serve requests.", flush=True)
    else:
        print("[Server] Running in degraded mode (Wav2Lip not installed). /health, /voices, /tts still work.", flush=True)
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
    return {
        "status": "ok",
        "device": (wav2lip_runner.DEVICE if WAV2LIP_AVAILABLE else "cpu"),
        "model_loaded": (WAV2LIP_AVAILABLE and wav2lip_runner._model is not None),
        "model_loading": _model_load_status["loading"],
        "model_load_error": _model_load_status["error"],
        "tts_available": TTS_AVAILABLE,
        "wav2lip_available": WAV2LIP_AVAILABLE,
    }


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
    if not WAV2LIP_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="عذرًا، نموذج Wav2Lip غير مثبت على السيرفر، لا يمكن كشف الوجوه."
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
    if not WAV2LIP_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="عذرًا، نموذج Wav2Lip غير مثبت على السيرفر. ميزة lip-sync معطّلة مؤقتًا — بس ميزة توليد الشخصيات وTTS شغّالة."
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
            loop = asyncio.get_event_loop()
            # نستخدم lambda عشان نمرر face_index كـ keyword argument
            await loop.run_in_executor(
                None,
                lambda: wav2lip_runner.run_lip_sync(
                    image_path,
                    audio_path,
                    output_path,
                    pads_tuple,
                    resize_factor,
                    4,    # face_det_batch_size
                    8,    # wav2lip_batch_size — 8 بدل 16 عشان نقلل ذروة الذاكرة
                    progress_callback,
                    face_idx_arg,
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
    if not WAV2LIP_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="عذرًا، نموذج Wav2Lip غير مثبت على السيرفر. ميزة lip-sync معطّلة مؤقتًا."
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

                    print(f"[Multi {job_id}] Segment {idx+1}/{total}: face={face_idx}, voice={voice}, text_len={len(text)}")

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
                        8,                # wav2lip_batch_size
                        _seg_cb,
                        face_idx,         # face_index
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
                        'ffmpeg', '-y',
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
                                'ffmpeg', '-y',
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
        env = os.environ.copy()
        proc = _subprocess.Popen(
            ["node", GEN_SCRIPT_PATH, _json.dumps({
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
                    if "Translating" in ln:
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
            stdout, _ = proc.communicate(timeout=300)
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
