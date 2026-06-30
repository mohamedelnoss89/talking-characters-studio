"""
يستخرج إطارات من الفيديو الجديد ويعمل مقارنة بصرية
"""
import cv2
import numpy as np
import subprocess
import os

# استخرج 5 إطارات من الفيديو الجديد
video_path = '/home/z/my-project/download/v6_composited_test.mp4'
out_dir = '/home/z/my-project/download/v6_frames'
os.makedirs(out_dir, exist_ok=True)

cap = cv2.VideoCapture(video_path)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"Total frames: {total}")

frames = []
for i in [0, 25, 50, 75, 90]:  # 5 frames spread across video
    if i >= total:
        continue
    cap.set(cv2.CAP_PROP_POS_FRAMES, i)
    ret, frame = cap.read()
    if ret:
        frames.append((i, frame))
        cv2.imwrite(f'{out_dir}/v6_frame_{i:03d}.png', frame)
        print(f"  saved frame {i}")
cap.release()

# اعمل grid بكل الإطارات
if frames:
    imgs = [f[1] for f in frames]
    # resize to same size
    h = min(im.shape[0] for im in imgs)
    w = min(im.shape[1] for im in imgs)
    imgs = [cv2.resize(im, (w, h)) for im in imgs]
    grid = np.hstack(imgs)
    cv2.imwrite('/home/z/my-project/download/v6_frames_grid.png', grid)
    print(f"Saved grid: /home/z/my-project/download/v6_frames_grid.png ({grid.shape})")

# استخرج منطقة الشفايف من إطار واحد وزوّد عليها
if frames:
    import sys
    sys.path.insert(0, '/home/z/my-project/backend')
    from face_compositor import FaceCompositor
    import mediapipe as mp
    
    # استخدم أول إطار
    idx, frame = frames[1]  # middle frame
    base = cv2.imread('/home/z/my-project/backend/uploads/08216505/input_image.png')
    
    # Make sure same size
    if base.shape != frame.shape:
        # find scale used in pipeline
        # The pipeline upscales to MIN_SIDE=480
        h0, w0 = base.shape[:2]
        scale = 480 / min(h0, w0)
        new_w = int(w0 * scale)
        new_h = int(h0 * scale)
        base = cv2.resize(base, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
    
    # Get lip bbox
    comp = FaceCompositor(base)
    if comp.lip_bbox:
        x1, y1, x2, y2 = comp.lip_bbox
        zp = 40
        zx1 = max(0, x1-zp)
        zy1 = max(0, y1-zp)
        zx2 = min(frame.shape[1], x2+zp)
        zy2 = min(frame.shape[0], y2+zp)
        
        # Zoom comparison: base | composited frame | (just the lip area)
        base_zoom = base[zy1:zy2, zx1:zx2]
        frame_zoom = frame[zy1:zy2, zx1:zx2]
        
        # Also load v5 video for comparison
        v5_path = '/home/z/my-project/download/pro_v5_lip_enhanced.mp4'
        if os.path.exists(v5_path):
            cap5 = cv2.VideoCapture(v5_path)
            cap5.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ret5, v5_frame = cap5.read()
            cap5.release()
            if ret5 and v5_frame.shape == frame.shape:
                v5_zoom = v5_frame[zy1:zy2, zx1:zx2]
                cmp = np.hstack([base_zoom, v5_zoom, frame_zoom])
                labels = ['Base (GFPGAN)', 'v5 (old)', 'v6 (composited)']
            else:
                cmp = np.hstack([base_zoom, frame_zoom])
                labels = ['Base (GFPGAN)', 'v6 (composited)']
        else:
            cmp = np.hstack([base_zoom, frame_zoom])
            labels = ['Base (GFPGAN)', 'v6 (composited)']
        
        cv2.imwrite('/home/z/my-project/download/v6_lips_comparison.png', cmp)
        print(f"Saved lips comparison: /home/z/my-project/download/v6_lips_comparison.png ({cmp.shape})")
        print(f"Labels: {labels}")
        
        # Sharpness metric
        gray_base = cv2.cvtColor(base_zoom, cv2.COLOR_BGR2GRAY)
        gray_frame = cv2.cvtColor(frame_zoom, cv2.COLOR_BGR2GRAY)
        lap_base = cv2.Laplacian(gray_base, cv2.CV_64F).var()
        lap_frame = cv2.Laplacian(gray_frame, cv2.CV_64F).var()
        print(f"\nSharpness (Laplacian variance):")
        print(f"  Base (GFPGAN enhanced): {lap_base:.1f}")
        print(f"  v6 composited frame: {lap_frame:.1f}")
        print(f"  Ratio: {lap_frame/lap_base:.2f} (1.0 = same as base)")
