#!/usr/bin/env python3
"""
setup-wav2lip.py — يجهّز محرك Wav2Lip (clone + checkpoint + patch librosa)

الـ checkpoint حجمه ~415MB فمش ممكن نرفعه على git، فالسكريبت ده بينزّله.
كمان بـ patch على audio.py عشان يتوافق مع librosa 0.10+.

الاستخدام:
    python scripts/setup-wav2lip.py

المتطلبات المسبقة (مثبتة في /home/z/.venv):
    pip install torch torchvision torchaudio opencv-python numpy librosa tqdm \
                huggingface_hub edge-tts fastapi uvicorn python-multipart
"""
import os
import sys
import shutil
import subprocess
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
WAV2LIP_DIR = BACKEND_DIR / "Wav2Lip"
CKPT_PATH = WAV2LIP_DIR / "checkpoints" / "wav2lip_gan.pth"

# Use the venv python if available, else fall back to system python
PYTHON = "/home/z/.venv/bin/python" if os.path.isfile("/home/z/.venv/bin/python") else sys.executable


def step(msg):
    print(f"\n[setup] {msg}")


def clone_wav2lip():
    """Clone the official Wav2Lip repo if not present."""
    if WAV2LIP_DIR.is_dir() and (WAV2LIP_DIR / "models" / "wav2lip.py").is_file():
        step(f"Wav2Lip directory already exists at {WAV2LIP_DIR}, skipping clone.")
        return
    step(f"Cloning Wav2Lip into {WAV2LIP_DIR} ...")
    subprocess.run(
        ["git", "clone", "https://github.com/Rudrabha/Wav2Lip.git", str(WAV2LIP_DIR)],
        check=True,
    )


def download_checkpoint():
    """Download wav2lip_gan.pth (~415MB) from HuggingFace mirror."""
    if CKPT_PATH.is_file() and CKPT_PATH.stat().st_size > 400_000_000:
        step(f"Checkpoint already exists ({CKPT_PATH.stat().st_size} bytes), skipping download.")
        return
    step("Downloading wav2lip_gan.pth from numz/wav2lip_studio on HuggingFace (~415MB) ...")
    CKPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Use huggingface_hub for reliable download (handles redirects & resumable)
    subprocess.run(
        [PYTHON, "-c", """
from huggingface_hub import hf_hub_download
import shutil
path = hf_hub_download(
    repo_id="numz/wav2lip_studio",
    filename="Wav2lip/wav2lip_gan.pth",
    repo_type="model",
    local_dir="/tmp/wav2lip_dl",
)
shutil.copy(path, "%s")
print("Downloaded:", "%s")
""" % str(CKPT_PATH)],
        check=True,
    )
    if not CKPT_PATH.is_file() or CKPT_PATH.stat().st_size < 400_000_000:
        print(f"[setup] FAILED: checkpoint file missing or too small at {CKPT_PATH}")
        sys.exit(1)
    print(f"[setup] Checkpoint size: {CKPT_PATH.stat().st_size} bytes")


def patch_librosa():
    """Patch Wav2Lip/audio.py to use keyword args for librosa.filters.mel (0.10+ compat)."""
    audio_py = WAV2LIP_DIR / "audio.py"
    if not audio_py.is_file():
        print(f"[setup] WARNING: {audio_py} not found, skipping librosa patch.")
        return
    text = audio_py.read_text()
    # Already patched?
    if "sr=hp.sample_rate, n_fft=hp.n_fft" in text:
        step("audio.py already patched for librosa 0.10+, skipping.")
        return
    old = "librosa.filters.mel(hp.sample_rate, hp.n_fft, n_mels=hp.num_mels,"
    new = "librosa.filters.mel(sr=hp.sample_rate, n_fft=hp.n_fft, n_mels=hp.num_mels,"
    if old in text:
        text = text.replace(old, new)
        audio_py.write_text(text)
        step("Patched audio.py for librosa 0.10+ compatibility.")
    else:
        print("[setup] WARNING: could not find expected librosa.filters.mel call to patch.")


def verify():
    """Quick import test to verify Wav2Lip can load."""
    step("Verifying Wav2Lip installation ...")
    env = os.environ.copy()
    env["PYTHONPATH"] = str(WAV2LIP_DIR) + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [PYTHON, "-c", """
import sys, os
sys.path.insert(0, os.path.join(os.path.abspath('.'), 'Wav2Lip'))
import wav2lip_runner
wav2lip_runner._check_wav2lip_available()
print('CHECK: Wav2Lip AVAILABLE')
m = wav2lip_runner.load_model()
print('MODEL LOADED:', type(m).__name__)
"""],
        cwd=str(BACKEND_DIR),
        capture_output=True,
        text=True,
        env=env,
    )
    print(result.stdout)
    if result.returncode != 0:
        print("[setup] STDERR:", result.stderr)
        print("[setup] FAILED: Wav2Lip verification failed.")
        sys.exit(1)
    print("[setup] Wav2Lip is fully operational.")


def main():
    print("=" * 60)
    print("Wav2Lip Setup Script")
    print(f"  Backend dir: {BACKEND_DIR}")
    print(f"  Python:      {PYTHON}")
    print("=" * 60)

    clone_wav2lip()
    download_checkpoint()
    patch_librosa()
    verify()

    print("\n[setup] All done. Start the backend with:")
    print(f"  cd {BACKEND_DIR.parent} && python backend/server.py")


if __name__ == "__main__":
    main()
