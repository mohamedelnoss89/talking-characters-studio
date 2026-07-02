"""
يولّد صورة مقارنة شاملة قبل/بعد لكل التحسينات:
  1. الأصل (Wav2Lip فقط)
  2. Wav2Lip + GFPGAN (تفاصيل شفايف)
  3. Wav2Lip + GFPGAN + Blink v3
"""
import sys, os
sys.path.insert(0, '/home/z/my-project/backend')

import cv2
import numpy as np
import subprocess
import tempfile

# === Setup ===
IMG_PATH = '/home/z/my-project/backend/uploads/08216505/input_image.png'
AUDIO_PATH = '/home/z/my-project/backend/test_audio.wav'
OUT_DIR = '/home/z/my-project/download'

# === Extract a frame from the v3 video ===
VIDEO_V3 = f'{OUT_DIR}/pro_v3_final.mp4'
# Get frame at 0.5s (during a blink)
cap = cv2.VideoCapture(VIDEO_V3)
cap.set(cv2.CAP_PROP_POS_MSEC, 500)
ret, frame_v3 = cap.read()
cap.release()
print(f"v3 frame: {frame_v3.shape if ret else 'FAIL'}")

# Get original uploaded image as the "before"
img_orig = cv2.imread(IMG_PATH)
# upscale to match
h, w = frame_v3.shape[:2]
img_orig_up = cv2.resize(img_orig, (w, h), interpolation=cv2.INTER_LANCZOS4)

# === Generate a "Wav2Lip-only" frame for comparison ===
# We can simulate by running Wav2Lip without enhancement, but let's extract
# frame from the OLD test video if exists, or generate one quickly
# Use the previously created test video without enhancement (api_test_blink.mp4)
OLD_VIDEO = f'{OUT_DIR}/api_test_blink.mp4'
if os.path.exists(OLD_VIDEO):
    cap = cv2.VideoCapture(OLD_VIDEO)
    cap.set(cv2.CAP_PROP_POS_MSEC, 500)
    ret, frame_old = cap.read()
    cap.release()
    if frame_old is not None and frame_old.shape[:2] != (h, w):
        frame_old = cv2.resize(frame_old, (w, h), interpolation=cv2.INTER_LANCZOS4)
else:
    frame_old = img_orig_up.copy()

# === Zoom on lips area for detail comparison ===
# Lips are roughly at center-bottom of face
def zoom_lips(img, zoom_factor=3.5):
    H, W = img.shape[:2]
    cx, cy = W // 2, int(H * 0.68)  # lips approx at 68% down
    sz = min(W, H) // 5
    x1, x2 = max(0, cx - sz), min(W, cx + sz)
    y1, y2 = max(0, cy - sz // 2), min(H, cy + sz // 2)
    crop = img[y1:y2, x1:x2]
    return cv2.resize(crop, None, fx=zoom_factor, fy=zoom_factor,
                      interpolation=cv2.INTER_LANCZOS4)

# === Zoom on eyes area for blink comparison ===
def zoom_eyes(img, zoom_factor=3.0):
    H, W = img.shape[:2]
    cx, cy = W // 2, int(H * 0.38)  # eyes approx at 38% down
    sz = min(W, H) // 3
    x1, x2 = max(0, cx - sz), min(W, cx + sz)
    y1, y2 = max(0, cy - sz // 3), min(H, cy + sz // 3)
    crop = img[y1:y2, x1:x2]
    return cv2.resize(crop, None, fx=zoom_factor, fy=zoom_factor,
                      interpolation=cv2.INTER_LANCZOS4)

# === Build comparison: 3 panels for face ===
panels = [img_orig_up, frame_old, frame_v3]
labels = ['Original', 'Wav2Lip only\n(old)', 'Wav2Lip + GFPGAN\n+ Blink v3']

# Add label band on top
def add_label(img, text):
    h, w = img.shape[:2]
    band = np.zeros((30, w, 3), dtype=np.uint8)
    cv2.putText(band, text, (10, 22), cv2.FONT_HERSHEY_SIMPLEX,
                0.7, (255, 255, 255), 2, cv2.LINE_AA)
    return np.vstack([band, img])

labeled_panels = [add_label(p, l.replace('\n', ' ')) for p, l in zip(panels, labels)]
face_comparison = np.hstack(labeled_panels)
cv2.imwrite(f'{OUT_DIR}/v3_face_comparison.png', face_comparison)
print(f"Saved: v3_face_comparison.png ({face_comparison.shape})")

# === Build comparison: lips zoom (3 panels) ===
lips_panels = [zoom_lips(p) for p in panels]
lips_labeled = [add_label(p, l.replace('\n', ' ')) for p, l in zip(lips_panels, labels)]
lips_comparison = np.hstack(lips_labeled)
cv2.imwrite(f'{OUT_DIR}/v3_lips_comparison.png', lips_comparison)
print(f"Saved: v3_lips_comparison.png ({lips_comparison.shape})")

# === Build comparison: eyes zoom (3 panels) ===
eyes_panels = [zoom_eyes(p) for p in panels]
eyes_labeled = [add_label(p, l.replace('\n', ' ')) for p, l in zip(eyes_panels, labels)]
eyes_comparison = np.hstack(eyes_labeled)
cv2.imwrite(f'{OUT_DIR}/v3_eyes_comparison.png', eyes_comparison)
print(f"Saved: v3_eyes_comparison.png ({eyes_comparison.shape})")

# === Build a sequence showing the blink in v3 ===
# Extract 8 frames from v3 video showing a full blink
cap = cv2.VideoCapture(VIDEO_V3)
seq_frames = []
for ms in [400, 600, 800, 1000, 1200, 1400, 1600, 1800]:
    cap.set(cv2.CAP_PROP_POS_MSEC, ms)
    ret, f = cap.read()
    if ret:
        seq_frames.append(f)
cap.release()

if seq_frames:
    # zoom on eyes for each
    zoomed = [zoom_eyes(f, zoom_factor=2.0) for f in seq_frames]
    # Resize all to same height
    min_h = min(z.shape[0] for z in zoomed)
    zoomed = [z[:min_h] for z in zoomed]
    blink_seq = np.hstack(zoomed)
    cv2.imwrite(f'{OUT_DIR}/v3_blink_sequence.png', blink_seq)
    print(f"Saved: v3_blink_sequence.png ({blink_seq.shape})")

print("\n[DONE] All comparison images saved to:", OUT_DIR)
