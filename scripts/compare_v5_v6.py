"""
مقارنة بصرية بين v5 (lip_enhancer فقط) و v6 (compositor + lip_enhancer)
"""
import cv2
import numpy as np
import os
import sys
sys.path.insert(0, '/home/z/my-project/backend')

v5_path = '/home/z/my-project/download/pro_v5_lip_enhanced.mp4'
v6_path = '/home/z/my-project/download/v6_composited_test.mp4'

# Both should have same dimensions and frame count
cap5 = cv2.VideoCapture(v5_path)
cap6 = cv2.VideoCapture(v6_path)
n5 = int(cap5.get(cv2.CAP_PROP_FRAME_COUNT))
n6 = int(cap6.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"v5: {n5} frames, v6: {n6} frames")

# Take 4 frames from middle of video (where lips are moving)
n = min(n5, n6)
sample_indices = [n//5, 2*n//5, 3*n//5, 4*n//5]

v5_frames = []
v6_frames = []
for idx in sample_indices:
    cap5.set(cv2.CAP_PROP_POS_FRAMES, idx)
    cap6.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ret5, f5 = cap5.read()
    ret6, f6 = cap6.read()
    if ret5 and ret6:
        v5_frames.append(f5)
        v6_frames.append(f6)
cap5.release()
cap6.release()

# Load base image for reference
base = cv2.imread('/home/z/my-project/backend/uploads/08216505/input_image.png')
# upscale to match
h0, w0 = base.shape[:2]
scale = 480 / min(h0, w0)
base = cv2.resize(base, (int(w0*scale), int(h0*scale)), interpolation=cv2.INTER_LANCZOS4)

# Detect lip region
from face_compositor import FaceCompositor
comp = FaceCompositor(base)
lx1, ly1, lx2, ly2 = comp.lip_bbox
print(f"Lip bbox: ({lx1},{ly1})-({lx2},{ly2})")

# Create zoom comparison: 4 rows, each row = [base_zoom | v5_zoom | v6_zoom]
zp = 30
zx1 = max(0, lx1 - zp)
zy1 = max(0, ly1 - zp)
zx2 = min(base.shape[1], lx2 + zp)
zy2 = min(base.shape[0], ly2 + zp)

rows = []
for i in range(len(v5_frames)):
    base_zoom = base[zy1:zy2, zx1:zx2]
    v5_zoom = v5_frames[i][zy1:zy2, zx1:zx2]
    v6_zoom = v6_frames[i][zy1:zy2, zx1:zx2]
    row = np.hstack([base_zoom, v5_zoom, v6_zoom])
    rows.append(row)

grid = np.vstack(rows)
grid_path = '/home/z/my-project/download/v6_vs_v5_lips_grid.png'
cv2.imwrite(grid_path, grid)
print(f"Saved: {grid_path} ({grid.shape})")
print("Layout: [Base | v5 (old) | v6 (composited)] x 4 frames")

# Sharpness comparison
print("\n=== Sharpness (Laplacian variance) ===")
print(f"{'Frame':<8} {'Base':<10} {'v5':<10} {'v6':<10} {'v6/v5':<10}")
for i in range(len(v5_frames)):
    g_base = cv2.cvtColor(base[zy1:zy2, zx1:zx2], cv2.COLOR_BGR2GRAY)
    g_v5 = cv2.cvtColor(v5_frames[i][zy1:zy2, zx1:zx2], cv2.COLOR_BGR2GRAY)
    g_v6 = cv2.cvtColor(v6_frames[i][zy1:zy2, zx1:zx2], cv2.COLOR_BGR2GRAY)
    l_base = cv2.Laplacian(g_base, cv2.CV_64F).var()
    l_v5 = cv2.Laplacian(g_v5, cv2.CV_64F).var()
    l_v6 = cv2.Laplacian(g_v6, cv2.CV_64F).var()
    ratio = l_v6 / l_v5 if l_v5 > 0 else 0
    print(f"{i:<8} {l_base:<10.1f} {l_v5:<10.1f} {l_v6:<10.1f} {ratio:<10.2f}")

# Full frame comparison: v5 | v6 side by side (resize to match)
full_rows = []
target_h = min(v5_frames[0].shape[0], v6_frames[0].shape[0])
for i in range(len(v5_frames)):
    f5 = cv2.resize(v5_frames[i], (480, target_h))
    f6 = cv2.resize(v6_frames[i], (480, target_h))
    row = np.hstack([f5, f6])
    full_rows.append(row)
full_grid = np.vstack(full_rows)
full_path = '/home/z/my-project/download/v6_vs_v5_full.png'
cv2.imwrite(full_path, full_grid)
print(f"\nSaved full comparison: {full_path} ({full_grid.shape})")
print("Layout: [v5 | v6] x 4 frames")
