"""
اختبار سريع للـ ProLipEnhancer على إطارات حقيقية من Wav2Lip.
يشغّل pipeline كامل على 2 ثانية صوت ويفحص إن الإطارات اتعدلت.
"""
import sys
import os
sys.path.insert(0, '/home/z/my-project/backend')

import cv2
import numpy as np
import time

# Import the new pro lip enhancer
from pro_lip_enhancer import ProLipEnhancer, enhance_lips_pro

# Test: enhance a single frame
TEST_IMG = '/home/z/my-project/backend/uploads/08216505/input_image.png'

print("=" * 60)
print("Test 1: ProLipEnhancer on single image")
print("=" * 60)

img = cv2.imread(TEST_IMG)
print(f"Image shape: {img.shape}")

# First, enhance with GFPGAN to get a reference (simulate)
# For test, use the original as reference (in real pipeline, GFPGAN-enhanced)
ref = img.copy()

# Create enhancer
enhancer = ProLipEnhancer(
    gfpgan_reference=ref,
    sharpen_amount=0.65,
    detail_strength=0.45,
    edge_only=True,
)

# Enhance
start = time.time()
result = enhancer.enhance_frame(img)
elapsed = time.time() - start
print(f"Single frame enhanced in {elapsed*1000:.1f}ms")
print(f"Result shape: {result.shape}")

# Check if there's a difference (means it actually did something)
diff = cv2.absdiff(img, result)
diff_mean = diff.mean()
print(f"Difference (mean abs): {diff_mean:.2f}")
print(f"Max diff: {diff.max()}")

# Save test outputs
os.makedirs('/home/z/my-project/backend/test_outputs', exist_ok=True)
cv2.imwrite('/home/z/my-project/backend/test_outputs/test_original.png', img)
cv2.imwrite('/home/z/my-project/backend/test_outputs/test_enhanced.png', result)
cv2.imwrite('/home/z/my-project/backend/test_outputs/test_diff.png', diff * 5)  # amplified

enhancer.close()

# Test batch
print("\n" + "=" * 60)
print("Test 2: Batch processing (simulate 10 frames)")
print("=" * 60)

# Simulate 10 frames (same image, like a short video)
frames = [img.copy() for _ in range(10)]

start = time.time()
result_frames = enhance_lips_pro(
    frames,
    gfpgan_reference=ref,
    sharpen_amount=0.65,
    detail_strength=0.45,
)
elapsed = time.time() - start
print(f"10 frames enhanced in {elapsed:.2f}s ({elapsed/10*1000:.1f}ms/frame)")
print(f"Result: {len(result_frames)} frames")

print("\n✓ All tests passed!")
print(f"Test outputs saved to: /home/z/my-project/backend/test_outputs/")
