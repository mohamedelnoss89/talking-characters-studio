"""
Analyze head movement in test video - measures face displacement per frame.
"""
import cv2
import numpy as np
import sys

# Use MediaPipe to track face center per frame
import os
sys.path.insert(0, '/home/z/my-project/backend')
os.environ['LD_LIBRARY_PATH'] = '/home/z/my-project/.libs:' + os.environ.get('LD_LIBRARY_PATH', '')

import mediapipe as mp
from mediapipe.tasks.python import vision as mp_vision
from mediapipe.tasks.python.core.base_options import BaseOptions

MODEL = '/home/z/my-project/public/models/face_landmarker.task'

options = mp_vision.FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=MODEL),
    running_mode=mp_vision.RunningMode.IMAGE,
    num_faces=1,
)
detector = mp_vision.FaceLandmarker.create_from_options(options)

def face_center(img):
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    res = detector.detect(mp_image)
    if not res.face_landmarks:
        return None
    lms = res.face_landmarks[0]
    # Use nose tip (landmark 1) as a stable center
    nose = lms[1]
    return (nose.x * img.shape[1], nose.y * img.shape[0])

def analyze(path, label):
    cap = cv2.VideoCapture(path)
    centers = []
    while True:
        ret, f = cap.read()
        if not ret:
            break
        c = face_center(f)
        centers.append(c)
    cap.release()
    
    # Filter None
    valid = [c for c in centers if c is not None]
    if not valid:
        print(f"[{label}] No face detected!")
        return
    
    xs = np.array([c[0] for c in valid])
    ys = np.array([c[1] for c in valid])
    
    print(f"[{label}] {len(valid)}/{len(centers)} frames with face")
    print(f"  Nose X: mean={xs.mean():.2f}, std={xs.std():.2f}, range=[{xs.min():.2f}, {xs.max():.2f}], drift={xs.max()-xs.min():.2f}px")
    print(f"  Nose Y: mean={ys.mean():.2f}, std={ys.std():.2f}, range=[{ys.min():.2f}, {ys.max():.2f}], drift={ys.max()-ys.min():.2f}px")

print("=== Original ===")
analyze('/home/z/my-project/backend/outputs/f106bd03.mp4', 'original')
print()
print("=== With Head Movement ===")
analyze('/tmp/head_test.mp4', 'with_movement')

detector.close()
