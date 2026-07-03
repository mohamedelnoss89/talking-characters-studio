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

# Import the runner
import wav2lip_runner
import tts_engine

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
    # Don't crash if torch / Wav2Lip model isn't available — just report it.
    try:
        device = wav2lip_runner.DEVICE
        model_loaded = wav2lip_runner._model is not None
    except Exception:
        device = "unavailable"
        model_loaded = False
    return {
        "status": "ok",
        "device": device,
        "model_loaded": model_loaded,
        "tts_available": True,
    }


# ============================================================
# TTS endpoints
# ============================================================
@app.get("/voices")
async def list_voices():
    """يرجع قائمة الأصوات المقترحة."""
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


if __name__ == "__main__":
    # Try to pre-load the Wav2Lip model so first request is fast.
    # If torch / Wav2Lip isn't installed, skip pre-loading — /voices and /tts
    # will still work, only /lip-sync will fail with a clear error.
    try:
        print("[Server] Pre-loading Wav2Lip model...")
        wav2lip_runner.load_model()
        print("[Server] Model loaded.")
    except Exception as e:
        print(f"[Server] Wav2Lip model NOT loaded (video generation disabled): {e}")
        print("[Server] /voices and /tts endpoints will still work.")
    print("[Server] Starting server on port 8000...")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
