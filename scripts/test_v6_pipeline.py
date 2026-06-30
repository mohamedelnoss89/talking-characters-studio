"""
اختبار الـ pipeline كامل مع الـ FaceCompositor الجديد
"""
import sys
import os
import time
sys.path.insert(0, '/home/z/my-project/backend')

from wav2lip_runner import run_lip_sync

image_path = '/home/z/my-project/backend/uploads/08216505/input_image.png'
audio_path = '/home/z/my-project/backend/test_speech.wav'  # 4s audio
output_path = '/home/z/my-project/download/v6_composited_test.mp4'

print(f"Image: {image_path}")
print(f"Audio: {audio_path} (4s)")
print(f"Output: {output_path}")
print("=" * 60)

start = time.time()
progress_log = [0]
def cb(p):
    if p - progress_log[0] >= 5 or p == 100:
        print(f"  progress: {p}%")
        progress_log[0] = p

run_lip_sync(
    image_path=image_path,
    audio_path=audio_path,
    output_path=output_path,
    progress_callback=cb,
)

elapsed = time.time() - start
print("=" * 60)
print(f"Done in {elapsed:.1f}s")
print(f"Output: {output_path}")

# Check output
import subprocess
result = subprocess.run(
    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=width,height',
     '-of', 'csv', output_path],
    capture_output=True, text=True
)
print(f"Output info: {result.stdout.strip()}")
