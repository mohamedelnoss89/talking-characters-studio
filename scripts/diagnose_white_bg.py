"""
يستخرج إطارات من فيديو المستخدم الحقيقي ويفحص مشكلة الخلفية البيضاء على الفم.
"""
import cv2
import numpy as np
import os
import sys

VIDEO = '/home/z/my-project/backend/outputs/test_outputs/pro_lip_test.mp4'
OUT_DIR = '/home/z/my-project/backend/test_outputs/diagnose_white'
os.makedirs(OUT_DIR, exist_ok=True)

cap = cv2.VideoCapture(VIDEO)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"Total frames: {total}")

# Extract frames at various points
sample_indices = [0, total//4, total//2, 3*total//4, total-1]
frames = []
for idx in sample_indices:
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ret, f = cap.read()
    if ret:
        frames.append((idx, f))
        cv2.imwrite(f'{OUT_DIR}/frame_{idx:04d}.png', f)
        print(f"Saved frame {idx}: shape={f.shape}")
cap.release()

# Now analyze each frame for white areas around the mouth
import mediapipe as mp
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61]
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78]
ALL_LIPS = list(set(LIPS_OUTER + LIPS_INNER))

fm = mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1,
                                      refine_landmarks=True, min_detection_confidence=0.5)

for idx, frame in frames:
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    res = fm.process(rgb)
    if not res.multi_face_landmarks:
        print(f"Frame {idx}: no face")
        continue
    lm = res.multi_face_landmarks[0].landmark
    h, w = frame.shape[:2]
    
    # Get lip bbox with padding (same as our code)
    pts = np.array([(lm[i].x * w, lm[i].y * h) for i in ALL_LIPS])
    x_min = int(pts[:, 0].min())
    x_max = int(pts[:, 0].max())
    y_min = int(pts[:, 1].min())
    y_max = int(pts[:, 1].max())
    
    # Check pixel values around lip area
    # Extract larger region around mouth
    pad = 30
    rx1 = max(0, x_min - pad)
    rx2 = min(w, x_max + pad)
    ry1 = max(0, y_min - pad)
    ry2 = min(h, y_max + pad)
    
    region = frame[ry1:ry2, rx1:rx2]
    
    # Check for very white pixels (B > 230, G > 230, R > 230)
    b, g, r = cv2.split(region)
    white_mask = (b > 230) & (g > 230) & (r > 230)
    white_count = white_mask.sum()
    total_pixels = region.shape[0] * region.shape[1]
    white_pct = white_count / total_pixels * 100
    
    print(f"Frame {idx}: lip bbox=({x_min},{y_min})-({x_max},{y_max}), "
          f"region {region.shape}, white pixels: {white_count}/{total_pixels} ({white_pct:.1f}%)")
    
    # Save the mouth region with white pixels highlighted
    highlighted = region.copy()
    highlighted[white_mask] = [0, 0, 255]  # red for white pixels
    cv2.imwrite(f'{OUT_DIR}/frame_{idx:04d}_mouth_white_highlighted.png', highlighted)
    cv2.imwrite(f'{OUT_DIR}/frame_{idx:04d}_mouth_region.png', region)

fm.close()
print(f"\n✓ Diagnostic images saved to: {OUT_DIR}")
