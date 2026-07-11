"""
FastAPI server for the Talking Characters Studio.

This server used to host a Wav2Lip lip-sync engine. That feature has been
removed. What remains:

  - GET  /health                → basic health check
  - GET  /voices                → list of TTS voices
  - POST /tts                   → text-to-speech synthesis (MP3)
  - POST /generate-character    → start an AI character generation job
  - GET  /generate-character/{job_id} → poll character generation status
  - GET  /character-styles      → list of art styles + genders
  - POST /edit-character        → start an AI image edit job
  - GET  /edit-character/{job_id} → poll image edit status
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

app = FastAPI(title="Talking Characters Studio API", version="2.0")

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


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "tts_available": TTS_AVAILABLE,
        "lip_sync_enabled": False,  # lip-sync feature removed
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
            capture_output=True, text=True, timeout=180, env=env,
        )

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
    print("[Server] Talking Characters Studio API starting on port 8000...")
    print("[Server] Features: TTS, AI character generation, AI image editing. (Lip-sync disabled.)")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
