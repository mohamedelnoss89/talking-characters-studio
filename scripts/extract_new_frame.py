"""Extract middle frame from the new test video for VLM analysis."""
import cv2
cap = cv2.VideoCapture('/home/z/my-project/backend/test_outputs/pro_lip_test.mp4')
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"Total frames: {total}")
cap.set(cv2.CAP_PROP_POS_FRAMES, total // 2)
ret, f = cap.read()
cap.release()
if ret:
    cv2.imwrite('/home/z/my-project/backend/test_outputs/new_output_midframe.png', f)
    print(f"Saved middle frame: shape={f.shape}")
