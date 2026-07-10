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
    WAV2LIP_AVAILABLE = True
except Exception as e:
    print(f"[Server] WARNING: wav2lip_runner not available ({e}). Running in degraded mode — /lip-sync disabled.")
    WAV2LIP_AVAILABLE = False

app = FastAPI(title="Wav2Lip Lip Sync API", version="1.0")

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
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                wav2lip_runner.run_lip_sync,
                image_path,
                audio_path,
                output_path,
                pads_tuple,
                resize_factor,
                4,    # face_det_batch_size
                16,   # wav2lip_batch_size
                progress_callback,
            )
            jobs[job_id]["status"] = "completed"
            jobs[job_id]["progress"] = 100
            jobs[job_id]["message"] = "Done"
            jobs[job_id]["video_path"] = output_path
            print(f"[Job {job_id}] Completed: {output_path}")
        except Exception as e:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(e)
            jobs[job_id]["message"] = f"Error: {e}"
            print(f"[Job {job_id}] Error: {e}")
            import traceback
            traceback.print_exc()

    background_tasks.add_task(run_job)

    return JSONResponse({
        "job_id": job_id,
        "status": "processing",
        "message": "Lip sync started. Poll /status/{job_id} for progress.",
        "poll_interval_ms": 1500,
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

        # Call the Node worker script
        env = os.environ.copy()
        result = _subprocess.run(
            ["node", GEN_SCRIPT_PATH, _json.dumps({
                "prompt": prompt,
                "style": style,
                "gender": gender,
                "language": language,
            })],
            capture_output=True, text=True, timeout=120, env=env,
        )

        if result.returncode != 0:
            job["status"] = "error"
            job["error"] = f"Worker failed: {result.stderr[:200]}" if result.stderr else "Worker failed"
            job["message"] = job["error"]
            return

        # Parse worker output (JSON on stdout)
        out = result.stdout.strip()
        # Find the JSON object (might have leading/trailing whitespace)
        first = out.find("{")
        last = out.rfind("}")
        if first == -1 or last == -1:
            job["status"] = "error"
            job["error"] = "Invalid worker output"
            job["message"] = job["error"]
            return

        data = _json.loads(out[first:last + 1])
        if not data.get("success"):
            job["status"] = "error"
            job["error"] = data.get("error", "Generation failed")
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
        if result.returncode != 0:
            err_tail = (result.stderr or "")[-400:]
            print(f"[edit-job {job_id}] FAILED rc={result.returncode} elapsed={elapsed:.1f}s stderr={err_tail}", flush=True)
            job["status"] = "error"
            job["error"] = f"Worker failed: {err_tail[-200:]}" if result.stderr else "Worker failed"
            job["message"] = job["error"]
            return

        out = result.stdout.strip()
        first = out.find("{")
        last = out.rfind("}")
        if first == -1 or last == -1:
            print(f"[edit-job {job_id}] FAILED invalid output elapsed={elapsed:.1f}s stdout_head={out[:200]!r}", flush=True)
            job["status"] = "error"
            job["error"] = "Invalid worker output"
            job["message"] = job["error"]
            return

        data = _json.loads(out[first:last + 1])
        if not data.get("success"):
            err = data.get("error", "Edit failed")
            print(f"[edit-job {job_id}] FAILED worker_error={err!r} elapsed={elapsed:.1f}s", flush=True)
            job["status"] = "error"
            job["error"] = err
            job["message"] = job["error"]
            return

        job["status"] = "completed"
        job["progress"] = 100
        job["message"] = "اكتمل التعديل" if language == "ar" else "Edit done"
        job["image_base64"] = data.get("image_base64", "")
        job["image_mime"] = data.get("image_mime", "image/png")
        job["prompt_used"] = data.get("prompt_used", edit_prompt)
        print(f"[edit-job {job_id}] COMPLETED elapsed={elapsed:.1f}s img_len={len(job['image_base64'])}", flush=True)

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
    }


if __name__ == "__main__":
    # Pre-load model so first request is fast (only if available)
    if WAV2LIP_AVAILABLE:
        print("[Server] Pre-loading Wav2Lip model...")
        try:
            wav2lip_runner.load_model()
            print("[Server] Model loaded.")
        except Exception as e:
            print(f"[Server] Model load failed ({e}) — /lip-sync will return 503.")
    else:
        print("[Server] Running in degraded mode (Wav2Lip not installed). /health, /voices, /tts still work.")

    print("[Server] Starting server on port 8000...")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
