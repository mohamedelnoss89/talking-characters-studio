"""
توليد أيقونة احترافية للمحرر العربي للفيديو
تنشئ: icon.png + icon.ico بأحجام متعددة
"""
from PIL import Image, ImageDraw, ImageFont
import os

# إعدادات الأيقونة
SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]

def create_icon(size):
    """إنشاء أيقونة بحجم معين"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # خلفية دائرية متدرجة (بنفسجي غامق)
    margin = size // 16
    radius = size // 6

    # مستطيل مدور بثيم داكن
    bg_color = (13, 14, 18, 255)  # #0d0e12
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=bg_color
    )

    # مستطيل داخلي أصغر بإطار بنفسجي
    inner_margin = size // 6
    inner_radius = size // 10
    border_color = (99, 102, 241, 255)  # #6366f1

    # رسم الإطار الخارجي
    draw.rounded_rectangle(
        [inner_margin, inner_margin, size - inner_margin, size - inner_margin],
        radius=inner_radius,
        outline=border_color,
        width=max(2, size // 64)
    )

    # رسم "شاشة فيديو" في الوسط
    screen_margin_x = size // 4
    screen_margin_y = size // 4
    screen_radius = size // 16

    # خلفية الشاشة (أسود)
    draw.rounded_rectangle(
        [screen_margin_x, screen_margin_y, size - screen_margin_x, size - screen_margin_y],
        radius=screen_radius,
        fill=(20, 22, 30, 255)
    )

    # مثلث التشغيل (Play) في المنتصف
    cx, cy = size // 2, size // 2
    triangle_size = size // 5

    play_color = (129, 140, 248, 255)  # #818cf8
    triangle = [
        (cx - triangle_size // 3, cy - triangle_size),
        (cx - triangle_size // 3, cy + triangle_size),
        (cx + triangle_size, cy)
    ]
    draw.polygon(triangle, fill=play_color)

    # إضافة خط زمني (Timeline) في الأسفل
    timeline_y = size - (size // 5)
    timeline_margin = size // 4
    timeline_height = max(2, size // 40)

    # خط زمني أساسي
    draw.rounded_rectangle(
        [timeline_margin, timeline_y, size - timeline_margin, timeline_y + timeline_height],
        radius=timeline_height // 2,
        fill=(60, 65, 90, 255)
    )

    # مقاطع صغيرة على الخط الزمني
    clips = [
        (timeline_margin + size // 12, 59, 130, 246, 255),
        (timeline_margin + size // 5, 16, 185, 129, 255),
        (timeline_margin + size // 3, 245, 158, 11, 255),
    ]

    for clip_x, *color in clips:
        clip_width = size // 8
        draw.rounded_rectangle(
            [clip_x, timeline_y - 2, clip_x + clip_width, timeline_y + timeline_height + 2],
            radius=2,
            fill=tuple(color)
        )

    return img

def main():
    output_dir = '/home/z/my-project/video-editor/build'
    os.makedirs(output_dir, exist_ok=True)

    print("🎨 جاري إنشاء أيقونات البرنامج...")

    # إنشاء كل الأحجام
    for size in SIZES:
        img = create_icon(size)
        print(f"  ✅ تم إنشاء أيقونة {size}x{size}")

    # حفظ PNG كبير (1024x1024)
    large_png = create_icon(1024)
    png_path = os.path.join(output_dir, 'icon.png')
    large_png.save(png_path, 'PNG')
    print(f"  ✅ تم حفظ {png_path}")

    # حفظ ICO (يحتوي على عدة أحجام - 256 لازم تكون موجودة)
    ico_sizes = [256, 128, 64, 48, 32, 16]
    ico_path = os.path.join(output_dir, 'icon.ico')

    # الطريقة الصحيحة: حفظ كل صورة على حدة كـ append
    images_for_ico = [create_icon(s) for s in ico_sizes]
    images_for_ico[0].save(
        ico_path,
        format='ICO',
        sizes=[(s, s) for s in ico_sizes]
    )
    print(f"  ✅ تم حفظ {ico_path}")

    # حفظ PNG 256x256 (إضافي للـ electron-builder)
    png_256 = create_icon(256)
    png_256_path = os.path.join(output_dir, 'icon-256.png')
    png_256.save(png_256_path, 'PNG')
    print(f"  ✅ تم حفظ {png_256_path}")

    print("\n🎉 تم إنشاء جميع الأيقونات بنجاح!")
    print(f"📁 المسار: {output_dir}")
    return True

if __name__ == '__main__':
    main()
