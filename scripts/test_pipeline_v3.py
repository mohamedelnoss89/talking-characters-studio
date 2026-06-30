"""
اختبار سريع للـ pipeline الجديد: Wav2Lip → GFPGAN → Blink v3
يستخدم الإطارات الموجودة في /tmp/FRAMES أو ينشئ إطارات اختبار
"""
import sys, os
sys.path.insert(0, '/home/z/my-project/backend')

import cv2
import numpy as np
import time

# Find a test image with a face
TEST_IMAGES = [
    '/home/z/my-project/backend/uploads/08216505/input_image.png',
    '/home/z/my-project/backend/uploads/197c3dfa/input_image.png',
    '/home/z/my-project/backend/uploads/fd749644/input_image.png',
    '/home/z/my-project/backend/Wav2Lip/filelists/test_img.png',
]
test_img = None
for p in TEST_IMAGES:
    if os.path.exists(p):
        test_img = p
        break

if test_img is None:
    print("No test image found")
    sys.exit(1)

print(f"[Test] Using image: {test_img}")
img = cv2.imread(test_img)
print(f"[Test] Image shape: {img.shape}")

# === 1. Test GFPGAN face enhancement ===
print("\n=== Testing GFPGAN face enhancement ===")
from face_enhancer import enhance_frame, FACE_ENHANCE_AVAILABLE
print(f"FACE_ENHANCE_AVAILABLE: {FACE_ENHANCE_AVAILABLE}")

if FACE_ENHANCE_AVAILABLE:
    t0 = time.time()
    enhanced = enhance_frame(img, weight=0.55)
    t1 = time.time()
    print(f"[GFPGAN] enhanced shape: {enhanced.shape}, took {t1-t0:.2f}s")

    # save before/after
    out_dir = '/home/z/my-project/download'
    os.makedirs(out_dir, exist_ok=True)
    cv2.imwrite(f'{out_dir}/gfpgan_before.png', img)
    cv2.imwrite(f'{out_dir}/gfpgan_after.png', enhanced)

    # Build a side-by-side comparison
    h, w = img.shape[:2]
    comparison = np.hstack([img, enhanced])
    cv2.imwrite(f'{out_dir}/gfpgan_comparison.png', comparison)

    # Compute diff
    diff = cv2.absdiff(img, enhanced)
    diff_mag = diff.mean()
    print(f"[GFPGAN] Mean pixel diff: {diff_mag:.2f}")

    print(f"[GFPGAN] Saved: gfpgan_before.png, gfpgan_after.png, gfpgan_comparison.png")

# === 2. Test Blink v3 on enhanced frame ===
print("\n=== Testing Blink v3 on enhanced image ===")
from eye_blink import BlinkProcessor

proc = BlinkProcessor(static_image=enhanced)
print(f"[Blink] Static geometries: {proc.static_geometries is not None}")

# Force a blink at full factor
blinked = proc.process_frame(enhanced, blink_factor=1.0)
cv2.imwrite(f'{out_dir}/blink_v3_peak.png', blinked)

# Build sequence: 0.0, 0.3, 0.6, 0.9, 1.0, 0.7, 0.3, 0.0
factors = [0.0, 0.3, 0.6, 0.9, 1.0, 0.7, 0.3, 0.0]
seq_frames = [proc.process_frame(enhanced, f) for f in factors]
seq = np.hstack(seq_frames)
cv2.imwrite(f'{out_dir}/blink_v3_sequence.png', seq)

# Diff at peak
diff_blink = cv2.absdiff(enhanced, blinked)
print(f"[Blink v3] Mean diff at peak: {diff_blink.mean():.2f}")
print(f"[Blink v3] Pixels changed (>10): {(diff_blink.sum(axis=2) > 10).sum()}")

proc.close()

print(f"\n[DONE] All outputs saved to: {out_dir}")
print("Files: gfpgan_before.png, gfpgan_after.png, gfpgan_comparison.png, blink_v3_peak.png, blink_v3_sequence.png")
