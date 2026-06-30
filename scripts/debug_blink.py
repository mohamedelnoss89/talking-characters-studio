"""Debug: print eye landmark positions and blink warp details."""
import sys
sys.path.insert(0, '/home/z/my-project/backend')
sys.path.insert(0, '/home/z/my-project/backend/Wav2Lip')

import cv2
import numpy as np
import mediapipe as mp
from eye_blink import LEFT_EYE_INDICES, RIGHT_EYE_INDICES, get_eye_box, plan_blinks, get_blink_factor_at_frame

img_path = '/home/z/my-project/backend/uploads/08216505/input_image.png'
img = cv2.imread(img_path)
h, w = img.shape[:2]
print(f"Image: {w}x{h}")

# كشف المعالم
fm = mp.solutions.face_mesh.FaceMesh(
    static_image_mode=True, max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5
)
results = fm.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
landmarks = results.multi_face_landmarks[0].landmark
print(f"Landmarks: {len(landmarks)} points")

for name, idx in [('LEFT', LEFT_EYE_INDICES), ('RIGHT', RIGHT_EYE_INDICES)]:
    pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in idx])
    print(f"\n{name} EYE:")
    print(f"  X range: {pts[:,0].min():.1f} - {pts[:,0].max():.1f}  (width = {pts[:,0].max()-pts[:,0].min():.1f})")
    print(f"  Y range: {pts[:,1].min():.1f} - {pts[:,1].max():.1f}  (height = {pts[:,1].max()-pts[:,1].min():.1f})")
    bx_min, by_min, bx_max, by_max, eye_top_y, eye_bot_y, eye_cy = get_eye_box(landmarks, idx, w, h, pad_ratio=0.7)
    print(f"  Bounding box (with pad): ({bx_min},{by_min}) - ({bx_max},{by_max})  size = {bx_max-bx_min}x{by_max-by_min}")
    print(f"  Eye top Y (rel): {eye_top_y:.1f}")
    print(f"  Eye bot Y (rel): {eye_bot_y:.1f}")
    print(f"  Eye center Y:    {eye_cy:.1f}")
    print(f"  Eye height:      {eye_bot_y-eye_top_y:.1f} px")

# خطط رمشات للفيديو القصير
blinks = plan_blinks(47, fps=25)
print(f"\nPlanned blinks: {blinks}")
print(f"Blink factors per frame:")
for i in range(47):
    f = get_blink_factor_at_frame(i, blinks)
    if f > 0.01:
        print(f"  Frame {i} ({i/25:.2f}s): factor={f:.3f}")

fm.close()
