"""
اختبار مرئي للتأكد من عدم وجود double head.
يصنع صورة فيها وجه مميّز، يطبّق حركة قوية، ويحفظ النتائج للفحص.
"""
import sys
sys.path.insert(0, '/home/z/my-project/backend')

import cv2
import numpy as np

def make_test_image():
    """صورة اختبار: خلفية مميزة + وجه واضح."""
    img = np.full((500, 500, 3), 120, dtype=np.uint8)

    # خلفية بنمط شبكي
    for i in range(0, 500, 25):
        cv2.line(img, (i, 0), (i, 500), (90, 90, 90), 1)
        cv2.line(img, (0, i), (500, i), (90, 90, 90), 1)

    # علامات حمراء في الخلفية (للتحقق إنها ما تتحركش)
    cv2.circle(img, (50, 50), 8, (0, 0, 200), -1)
    cv2.circle(img, (450, 50), 8, (0, 0, 200), -1)
    cv2.circle(img, (50, 450), 8, (0, 0, 200), -1)
    cv2.circle(img, (450, 450), 8, (0, 0, 200), -1)

    # وجه دائري (لون بشري)
    cv2.circle(img, (250, 250), 110, (200, 170, 150), -1)

    # شعر (أعلى الوجه)
    cv2.ellipse(img, (250, 175), (95, 50), 0, 180, 360, (60, 40, 30), -1)

    # عيون (بياض + بؤبؤ أسود)
    cv2.circle(img, (215, 230), 18, (255, 255, 255), -1)
    cv2.circle(img, (285, 230), 18, (255, 255, 255), -1)
    cv2.circle(img, (215, 230), 7, (0, 0, 0), -1)
    cv2.circle(img, (285, 230), 7, (0, 0, 0), -1)

    # فم
    cv2.ellipse(img, (250, 290), (35, 12), 0, 0, 180, (50, 30, 30), -1)

    # أنف
    cv2.line(img, (250, 245), (245, 275), (150, 130, 110), 2)
    cv2.line(img, (245, 275), (255, 275), (150, 130, 110), 2)

    return img


def main():
    print("=" * 60)
    print("Test: Head movement without ghosting (double-head check)")
    print("=" * 60)

    img = make_test_image()
    print(f"Created test image: {img.shape}")

    from head_movement import HeadMover

    # intensity=2.0 (قوية) عشان الحركة تكون واضحة
    mover = HeadMover(static_image=img.copy(), intensity=2.0)
    if mover.static_face_bounds is None:
        print("FAIL: face not detected")
        return

    x1, y1, x2, y2 = mover.static_face_bounds
    print(f"Face bounds: ({x1}, {y1}) -> ({x2}, {y2}), size = {x2-x1}x{y2-y1}")

    # احفظ الـ clean plate
    cv2.imwrite('/tmp/ghost_clean_plate.png', mover.clean_plate)
    print("Saved: /tmp/ghost_clean_plate.png (clean background, no face)")

    # اختبار 1: حركة كبيرة لليمين (dx=+30)
    print("\n--- Test 1: Big move RIGHT (dx=+30, dy=+5, angle=2°) ---")
    moved_right = mover.apply_to_frame(img, 30.0, 5.0, 2.0)
    cv2.imwrite('/tmp/ghost_moved_right.png', moved_right)
    print("Saved: /tmp/ghost_moved_right.png")

    # اختبار 2: حركة كبيرة لليسار (dx=-30)
    print("\n--- Test 2: Big move LEFT (dx=-30, dy=-5, angle=-2°) ---")
    moved_left = mover.apply_to_frame(img, -30.0, -5.0, -2.0)
    cv2.imwrite('/tmp/ghost_moved_left.png', moved_left)
    print("Saved: /tmp/ghost_moved_left.png")

    # اختبار 3: دوران فقط (angle=5°)
    print("\n--- Test 3: Rotation only (angle=5°) ---")
    moved_rot = mover.apply_to_frame(img, 0.0, 0.0, 5.0)
    cv2.imwrite('/tmp/ghost_moved_rot.png', moved_rot)
    print("Saved: /tmp/ghost_moved_rot.png")

    # قارن الـ original مع الـ moved: لو فيه double head، الفرق هيكون كبير
    # في الموقع الأصلي للوجه (لأن الوجه القديم هيفضل ظاهر)
    diff_right = cv2.absdiff(img, moved_right)
    diff_left = cv2.absdiff(img, moved_left)

    cv2.imwrite('/tmp/ghost_diff_right.png', diff_right)
    cv2.imwrite('/tmp/ghost_diff_left.png', diff_left)
    print("\nSaved diff images: /tmp/ghost_diff_right.png, /tmp/ghost_diff_left.png")
    print("  (diff shows what changed - if no double-head, only the face area shows change)")

    # تحقق: في الموقع الأصلي للعين اليسرى (215, 230) - لازم يكون اتغير
    # لو فيه double head، الـ eye هيظهر مرتين: في الموقع الأصلي + الجديد
    print("\n=== Detailed pixel check ===")
    eye_left_orig = img[230, 215]
    eye_left_after_right_move = moved_right[230, 215]
    print(f"Original eye (215, 230): {eye_left_orig} (should be BLACK pupil)")
    print(f"After RIGHT move at (215, 230): {eye_left_after_right_move}")
    print(f"  (should be skin/background - NOT black, because face moved right)")

    if abs(int(eye_left_orig[0]) - int(eye_left_after_right_move[0])) > 40:
        print("  ✓ OK: Original eye position changed (no ghosting)")
    else:
        print("  ✗ WARNING: Original eye still there (possible ghosting)")

    # الموقع الجديد للعين (215+30, 230+5) = (245, 235) - لازم يكون أسود
    new_eye_pos = (245, 235)
    new_eye_pixel = moved_right[new_eye_pos[1], new_eye_pos[0]]
    print(f"\nNew eye position ({new_eye_pos}): {new_eye_pixel}")
    print(f"  (should be BLACK pupil or WHITE sclera - part of moved face)")

    mover.close()
    print("\n=== All test images saved to /tmp/ for visual inspection ===")
    print("Files:")
    print("  /tmp/ghost_clean_plate.png   - background without face")
    print("  /tmp/ghost_moved_right.png   - face moved 30px right")
    print("  /tmp/ghost_moved_left.png    - face moved 30px left")
    print("  /tmp/ghost_moved_rot.png     - face rotated 5°")
    print("  /tmp/ghost_diff_right.png    - diff (original vs right move)")
    print("  /tmp/ghost_diff_left.png     - diff (original vs left move)")


if __name__ == '__main__':
    main()
