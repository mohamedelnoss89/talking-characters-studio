"""
اختبار FaceCompositor
يجرّب الـ compositor على صورة + إطار من Wav2Lip ويعمل صور مقارنة.
"""
import sys
import os
sys.path.insert(0, '/home/z/my-project/backend')

import cv2
import numpy as np
from face_compositor import FaceCompositor

# 1. صورة الـ base (الصورة الأصلية - بدون GFPGAN للتجربة)
base_path = '/home/z/my-project/backend/uploads/08216505/input_image.png'
print(f"Loading base: {base_path}")
base = cv2.imread(base_path)
if base is None:
    print("ERROR: could not load base image")
    sys.exit(1)
print(f"Base shape: {base.shape}")

# 2. نعمل simulate لإطار Wav2Lip بنعمل blur بسيط على الوجه
# (محاكاة للتأثير اللي بيعمله Wav2Lip 96x96 upscale)
# نأخذ الصورة ونضيف Gaussian blur على منطقة الوجه بس
import mediapipe as mp
face_mesh = mp.solutions.face_mesh.FaceMesh(
    static_image_mode=True, max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5
)
rgb = cv2.cvtColor(base, cv2.COLOR_BGR2RGB)
res = face_mesh.process(rgb)
face_mesh.close()

if res.multi_face_landmarks is None:
    print("ERROR: no face detected")
    sys.exit(1)

lm = res.multi_face_landmarks[0].landmark
h, w = base.shape[:2]
all_pts = np.array([(l.x * w, l.y * h) for l in lm])
x1, y1 = int(all_pts[:, 0].min()), int(all_pts[:, 1].min())
x2, y2 = int(all_pts[:, 0].max()), int(all_pts[:, 1].max())
pad = int(max(x2-x1, y2-y1) * 0.05)
x1, y1 = max(0, x1-pad), max(0, y1-pad)
x2, y2 = min(w, x2+pad), min(h, y2+pad)

# محاكاة Wav2Lip: blur الوجه كله + تشويه بسيط
fake_wav2lip = base.copy()
face_region = fake_wav2lip[y1:y2, x1:x2].copy()
# blur قوي محاكاة للـ 96x96 upscale
blurred_face = cv2.GaussianBlur(face_region, (15, 15), 0)
# إضافة شفايف متحركة (نعدل لون الشفايف قليلاً)
# نأخذ lip landmarks
LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
lip_pts = np.array([(lm[i].x * w, lm[i].y * h) for i in LIPS], dtype=np.int32)
mask = np.zeros(face_region.shape[:2], dtype=np.uint8)
local_lip = lip_pts - np.array([x1, y1])
cv2.fillConvexPoly(mask, local_lip, 255)
# تغيير لون الشفايف (محاكاة حركة)
lip_overlay = blurred_face.copy()
# رفع قناة الحمراء شوية (محاكاة شفايف مفتوحة)
lip_overlay[:, :, 2] = np.clip(lip_overlay[:, :, 2].astype(int) + 30, 0, 255).astype(np.uint8)
blurred_face = cv2.bitwise_and(blurred_face, blurred_face, mask=cv2.bitwise_not(mask))
lip_part = cv2.bitwise_and(lip_overlay, lip_overlay, mask=mask)
blurred_face = cv2.add(blurred_face, lip_part)
fake_wav2lip[y1:y2, x1:x2] = blurred_face

print(f"Fake Wav2Lip frame created (face blurred, lips modified)")

# 3. اطبع الـ compositor
compositor = FaceCompositor(base_image=base, lip_expand=0.25)
if compositor.lip_bbox is None:
    print("ERROR: compositor could not detect lips")
    sys.exit(1)

# 4. اعمل composite
composited = compositor.composite(fake_wav2lip)

# 5. اعمل صور مقارنة
# مقارنة 1: base | fake_wav2lip | composited
cmp1 = np.hstack([base, fake_wav2lip, composited])
cmp1_path = '/home/z/my-project/download/v6_compositor_comparison.png'
cv2.imwrite(cmp1_path, cmp1)
print(f"Saved comparison: {cmp1_path}")

# مقارنة 2: zoom على منطقة الشفايف
lx1, ly1, lx2, ly2 = compositor.lip_bbox
zp = 30  # zoom padding
zx1, zy1 = max(0, lx1-zp), max(0, ly1-zp)
zx2, zy2 = min(w, lx2+zp), min(h, ly2+zp)
base_zoom = base[zy1:zy2, zx1:zx2]
w2l_zoom = fake_wav2lip[zy1:zy2, zx1:zx2]
comp_zoom = composited[zy1:zy2, zx1:zx2]
cmp2 = np.hstack([base_zoom, w2l_zoom, comp_zoom])
cmp2_path = '/home/z/my-project/download/v6_lips_zoom.png'
cv2.imwrite(cmp2_path, cmp2)
print(f"Saved lips zoom: {cmp2_path}")

# 6. إحصائيات
diff_w2l_base = np.abs(fake_wav2lip.astype(int) - base.astype(int)).mean()
diff_comp_base = np.abs(composited.astype(int) - base.astype(int)).mean()
diff_comp_w2l = np.abs(composited.astype(int) - fake_wav2lip.astype(int)).mean()
print(f"\n=== Statistics ===")
print(f"Diff fake_wav2lip vs base: {diff_w2l_base:.2f} (blur effect)")
print(f"Diff composited vs base: {diff_comp_base:.2f} (should be smaller - more like base)")
print(f"Diff composited vs fake_wav2lip: {diff_comp_w2l:.2f} (lips taken from w2l)")

# على منطقة الشفايف بس
lip_diff_w2l = np.abs(w2l_zoom.astype(int) - base_zoom.astype(int)).mean()
lip_diff_comp = np.abs(comp_zoom.astype(int) - base_zoom.astype(int)).mean()
print(f"\nLip region only:")
print(f"  fake_wav2lip vs base: {lip_diff_w2l:.2f}")
print(f"  composited vs base: {lip_diff_comp:.2f}")
print(f"  (composited should retain lip motion = closer to w2l on lips)")
