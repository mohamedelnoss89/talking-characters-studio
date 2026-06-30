"""
يستخرج إطارات من فيديو Wav2Lip الناتج ويقارنها مع/بدون ProLipEnhancer.
"""
import sys
import os
import cv2
import numpy as np
sys.path.insert(0, '/home/z/my-project/backend')

# Read the test output video
VIDEO = '/home/z/my-project/backend/test_outputs/pro_lip_test.mp4'
cap = cv2.VideoCapture(VIDEO)

frames = []
while True:
    ret, f = cap.read()
    if not ret:
        break
    frames.append(f)
cap.release()
print(f"Read {len(frames)} frames from video")

if not frames:
    print("ERROR: No frames!")
    sys.exit(1)

# Pick a frame in the middle (where lips are likely moving)
mid = len(frames) // 2
sample = frames[mid]

# Now apply ProLipEnhancer to show the enhancement difference
from pro_lip_enhancer import ProLipEnhancer

# Use original input image as GFPGAN reference (simulated)
ref = cv2.imread('/home/z/my-project/backend/uploads/08216505/input_image.png')
# Match size
if ref.shape[:2] != sample.shape[:2]:
    ref = cv2.resize(ref, (sample.shape[1], sample.shape[0]))

enhancer = ProLipEnhancer(
    gfpgan_reference=ref,
    sharpen_amount=0.65,
    detail_strength=0.45,
    edge_only=True,
)

enhanced = enhancer.enhance_frame(sample.copy())
enhancer.close()

# Side-by-side comparison
h, w = sample.shape[:2]
comparison = np.zeros((h, w * 2 + 20, 3), dtype=np.uint8)
comparison[:, :w] = sample
comparison[:, w+20:] = enhanced

# Add labels
cv2.putText(comparison, "Before (Wav2Lip)", (10, 25),
            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
cv2.putText(comparison, "After (ProLipEnhancer)", (w + 30, 25),
            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)

out_path = '/home/z/my-project/backend/test_outputs/comparison.png'
cv2.imwrite(out_path, comparison)
print(f"Comparison saved: {out_path}")

# Also zoom into lip region for clearer comparison
# Find lip bbox via MediaPipe
import mediapipe as mp
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78]
ALL_LIPS = list(set(LIPS_OUTER + LIPS_INNER))

fm = mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1,
                                      refine_landmarks=True, min_detection_confidence=0.5)
rgb = cv2.cvtColor(sample, cv2.COLOR_BGR2RGB)
res = fm.process(rgb)
if res.multi_face_landmarks:
    lm = res.multi_face_landmarks[0].landmark
    h2, w2 = sample.shape[:2]
    pts = np.array([(lm[i].x * w2, lm[i].y * h2) for i in ALL_LIPS])
    x1, y1 = int(pts[:, 0].min()) - 15, int(pts[:, 1].min()) - 15
    x2, y2 = int(pts[:, 0].max()) + 15, int(pts[:, 1].max()) + 15
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w2, x2), min(h2, y2)

    # Zoom 4x
    lip_before = sample[y1:y2, x1:x2]
    lip_after = enhanced[y1:y2, x1:x2]
    scale = 4
    lip_before_z = cv2.resize(lip_before, (lip_before.shape[1]*scale, lip_before.shape[0]*scale),
                               interpolation=cv2.INTER_LANCZOS4)
    lip_after_z = cv2.resize(lip_after, (lip_after.shape[1]*scale, lip_after.shape[0]*scale),
                              interpolation=cv2.INTER_LANCZOS4)

    lip_compare = np.zeros((lip_before_z.shape[0], lip_before_z.shape[1]*2 + 20, 3), dtype=np.uint8)
    lip_compare[:, :lip_before_z.shape[1]] = lip_before_z
    lip_compare[:, lip_before_z.shape[1]+20:] = lip_after_z

    cv2.putText(lip_compare, "Before", (10, 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
    cv2.putText(lip_compare, "After (sharp edges)",
                (lip_before_z.shape[1]+30, 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

    lip_path = '/home/z/my-project/backend/test_outputs/lip_comparison_zoom.png'
    cv2.imwrite(lip_path, lip_compare)
    print(f"Lip zoom comparison: {lip_path}")

fm.close()
print("\n✓ Done")
