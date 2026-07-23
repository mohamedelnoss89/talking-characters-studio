# Talking Characters Studio

AI-powered web app that makes characters in images **talk** with synchronized lip movement, natural eye blinking, and high-quality face restoration — all running on CPU.

Built with **Next.js 16** + **FastAPI** + **Wav2Lip** + **GFPGAN** + **MediaPipe**.

---

## Features

- **Wav2Lip lip-sync** — synchronized mouth movement from any audio file
- **GFPGAN v1.4 face restoration** — pre-enhances source image for sharper output
- **MediaPipe eye blink** — natural blink animation with horizontal compression, iris darkening, Gaussian feather
- **Lip enhancer** — CLAHE + unsharp mask on lip region only
- **11 preloaded characters** + upload your own
- **Multilingual UI** (Arabic / English)
- **Real-time progress** via polling
- **Auto-start backend** from Next.js instrumentation hook

---

## Project structure

```
.
├── src/                      # Next.js 16 frontend
│   ├── app/                  # App router (pages + API routes)
│   ├── components/ui/        # shadcn/ui components
│   ├── hooks/                # React hooks
│   └── lib/                  # wav2lip client + i18n + utils
├── backend/                  # FastAPI + Python AI pipeline
│   ├── server.py             # FastAPI server (port 8000)
│   ├── wav2lip_runner.py     # Main pipeline orchestrator
│   ├── face_enhancer.py      # GFPGAN wrapper (MediaPipe detection)
│   ├── lip_enhancer.py       # CLAHE + unsharp mask on lips
│   ├── eye_blink.py          # MediaPipe blink animation
│   ├── face_compositor.py    # (disabled) lip composite experiment
│   └── professional_enhancer.py
├── scripts/                  # Helper scripts
├── public/                   # Characters + MediaPipe models
└── video-editor/             # Optional Electron-based video editor
```

---

## Prerequisites

- **Node.js 18+** and npm
- **Python 3.10+**
- **ffmpeg** in PATH
- **CPU** with at least 8 GB RAM (GPU optional, not required)

---

## Setup

### 1. Frontend (Next.js)

```bash
npm install
npm run dev
# → http://localhost:3000
```

### 2. Backend (Python)

The backend auto-starts when the Next.js dev server boots (via `src/instrumentation.ts`
and `src/app/api/health/route.ts`). To start it manually:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate            # On Windows: venv\Scripts\activate
pip install -r requirements.txt     # All deps pinned — single source of truth
python3 server.py
# → http://localhost:8000
```

### 3. Model weights (NOT included in repo)

The repo **excludes** large model weights. Download them separately:

| File | Download from | Place at |
|------|----------------|----------|
| `wav2lip_gan.pth` | [Wav2Lip releases](https://github.com/Rudrabha/Wav2Lip#inference-on-a-single-audio-file) | `backend/Wav2Lip/checkpoints/wav2lip_gan.pth` |
| GFPGAN weights | [GFPGAN v1.4](https://github.com/TencentARC/GFPGAN-1.4) | `backend/gfpgan/` (per their layout) |
| `face_landmarker.task` | [MediaPipe models](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task) | already bundled at `public/models/` |

Clone Wav2Lip source next to `backend/`:

```bash
cd backend
git clone https://github.com/Rudrabha/Wav2Lip.git
```

---

## Pipeline

```
Source image
   │
   ▼
GFPGAN pre-enhance  ──►  sharper source face
   │
   ▼
Wav2Lip             ──►  lip-synced frames (96×96 internal)
   │
   ▼
Lip enhancer        ──►  CLAHE + unsharp mask on lip region
   │
   ▼
Eye blink           ──►  natural blink animation (MediaPipe)
   │
   ▼
ffmpeg write        ──►  final MP4
```

Progress is reported as: 0–10% pre-enhance · 10–70% Wav2Lip · 70–82% lip sharpen · 82–90% blink · 90–100% write.

---

## API

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/lip-sync` | Start a job — accepts `image` + `audio` + options |
| `GET`  | `/status/{job_id}` | Poll job progress (0–100) and state |
| `GET`  | `/jobs/{job_id}` | Get finished video download URL |
| `GET`  | `/health` | Backend healthcheck + auto-restart hook |

---

## Notes

- All processing runs on **CPU**. A 30-second clip typically takes 5–10 minutes depending on machine.
- Wav2Lip works at 96×96 internally; we mitigate softness with GFPGAN pre-enhance + lip-region sharpening. True per-frame GFPGAN post-enhance is too slow on CPU.
- The `face_compositor.py` experiment (composite Wav2Lip lips onto a static GFPGAN base) is **disabled** — it produced sharp but unnaturally static faces.

---

## License

MIT — see individual upstream licenses for Wav2Lip, GFPGAN, and MediaPipe.
