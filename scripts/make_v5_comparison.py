"""
يولّد صور مقارنة شاملة بين النسخ القديمة والجديدة.
- pro_v4_long_audio.mp4: قبل lip enhancement (Wav2Lip + GFPGAN + blink)
- pro_v5_lip_enhanced.mp4: بعد lip enhancement (Wav2Lip + GFPGAN + lip + blink)
"""
import cv2
import numpy as np

OUT_DIR = '/home/z/my-project/download'

# Load both videos
videos = {
    'v4 (no lip enh)': f'{OUT_DIR}/pro_v4_long_audio.mp4',
    'v5 (lip enh v1)': f'{OUT_DIR}/pro_v5_lip_enhanced.mp4',
}

# Extract frames at different timestamps
timestamps = [1.0, 5.0, 10.0, 15.0, 20.0, 25.0]  # 6 frames each

frames_per_video = {}
for name, path in videos.items():
    cap = cv2.VideoCapture(path)
    frames = []
    for ts in timestamps:
        cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
        ret, f = cap.read()
        if ret:
            frames.append(f)
    cap.release()
    frames_per_video[name] = frames
    print(f"{name}: {len(frames)} frames")

# === Build comparison grid: 2 rows × 6 columns ===
# Each row = one video version, columns = different timestamps

def zoom_lips(img, zoom_factor=2.5):
    H, W = img.shape[:2]
    cx, cy = W // 2, int(H * 0.70)
    sz = min(W, H) // 4
    x1, x2 = max(0, cx - sz), min(W, cx + sz)
    y1, y2 = max(0, cy - sz // 2), min(H, cy + sz // 2)
    crop = img[y1:y2, x1:x2]
    return cv2.resize(crop, None, fx=zoom_factor, fy=zoom_factor,
                      interpolation=cv2.INTER_LANCZOS4)

# Build face comparison (full face, 2 rows × 6 cols)
rows = []
labels = list(videos.keys())
for name in labels:
    row_frames = frames_per_video[name]
    row = np.hstack(row_frames)
    rows.append(row)
face_grid = np.vstack(rows)
cv2.imwrite(f'{OUT_DIR}/v5_face_grid.png', face_grid)
print(f"Saved: v5_face_grid.png ({face_grid.shape})")

# Build lips zoom comparison (2 rows × 6 cols)
lip_rows = []
for name in labels:
    row_frames = [zoom_lips(f) for f in frames_per_video[name]]
    # pad to same height
    min_h = min(f.shape[0] for f in row_frames)
    row_frames = [f[:min_h] for f in row_frames]
    row = np.hstack(row_frames)
    lip_rows.append(row)
lips_grid = np.vstack(lip_rows)
cv2.imwrite(f'{OUT_DIR}/v5_lips_grid.png', lips_grid)
print(f"Saved: v5_lips_grid.png ({lips_grid.shape})")

# === Side-by-side at single timestamp (better detail) ===
ts_idx = 2  # 10s mark
side_by_side = []
for name in labels:
    f = frames_per_video[name][ts_idx]
    # Add label band on top
    h, w = f.shape[:2]
    band = np.zeros((30, w, 3), dtype=np.uint8)
    cv2.putText(band, name, (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
    labeled = np.vstack([band, f])
    side_by_side.append(labeled)

comparison = np.hstack(side_by_side)
cv2.imwrite(f'{OUT_DIR}/v5_side_by_side.png', comparison)
print(f"Saved: v5_side_by_side.png ({comparison.shape})")

# === Lips zoom side-by-side ===
lips_sbs = []
for name in labels:
    f = zoom_lips(frames_per_video[name][ts_idx], zoom_factor=3.5)
    h, w = f.shape[:2]
    band = np.zeros((30, w, 3), dtype=np.uint8)
    cv2.putText(band, name, (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
    labeled = np.vstack([band, f])
    lips_sbs.append(labeled)

lips_comparison = np.hstack(lips_sbs)
cv2.imwrite(f'{OUT_DIR}/v5_lips_side_by_side.png', lips_comparison)
print(f"Saved: v5_lips_side_by_side.png ({lips_comparison.shape})")

# === Compute pixel diff between v4 and v5 (shows where enhancement was applied) ===
v4_frame = frames_per_video['v4 (no lip enh)'][ts_idx]
v5_frame = frames_per_video['v5 (lip enh v1)'][ts_idx]
diff = cv2.absdiff(v4_frame, v5_frame)
# Amplify diff for visualization
diff_amp = np.clip(diff.astype(np.float32) * 3, 0, 255).astype(np.uint8)
cv2.imwrite(f'{OUT_DIR}/v5_diff.png', diff_amp)
print(f"Saved: v5_diff.png (mean diff: {diff.mean():.2f})")

print("\n[DONE] All comparison images saved")
