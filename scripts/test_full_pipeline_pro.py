"""
اختبار pipeline كامل مع ProLipEnhancer الجديد.
يشغّل Wav2Lip + ProLipEnhancer + EyeBlink على فيديو 2 ثانية.
"""
import sys
import os
import time
sys.path.insert(0, '/home/z/my-project/backend')

# Run the full pipeline
from wav2lip_runner import run_lip_sync

TEST_IMG = '/home/z/my-project/backend/uploads/08216505/input_image.png'
TEST_AUDIO = '/home/z/my-project/backend/uploads/08216505/input_audio.wav'
OUTPUT = '/home/z/my-project/backend/test_outputs/pro_lip_test.mp4'

os.makedirs('/home/z/my-project/backend/test_outputs', exist_ok=True)

print("=" * 60)
print("Running FULL pipeline with ProLipEnhancer v2")
print("=" * 60)
print(f"Image: {TEST_IMG}")
print(f"Audio: {TEST_AUDIO}")
print(f"Output: {OUTPUT}")
print()

start = time.time()

def progress_cb(p):
    print(f"\r  Progress: {p}%", end='', flush=True)

run_lip_sync(
    image_path=TEST_IMG,
    audio_path=TEST_AUDIO,
    output_path=OUTPUT,
    progress_callback=progress_cb,
)

elapsed = time.time() - start
print(f"\n\n✓ Pipeline completed in {elapsed:.1f}s")
print(f"Output: {OUTPUT}")

# Check output
import subprocess
result = subprocess.run(
    ['ffprobe', '-v', 'error', '-show_entries',
     'format=duration,size:stream=width,height,codec_name',
     '-of', 'csv=p=0', OUTPUT],
    capture_output=True, text=True
)
print(f"\nOutput info:\n{result.stdout}")
