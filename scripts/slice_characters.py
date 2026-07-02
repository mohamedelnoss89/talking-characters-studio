"""
تقطيع صورة الـ 18 شخصية إلى صور منفصلة
الصورة الأصلية: 1380x752 (3 صفوف × 6 أعمدة)
"""
from PIL import Image
import os

SRC = "/home/z/my-project/upload/Gemini_Generated_Image_2juuai2juuai2juu.png"
OUT = "/home/z/my-project/public/characters"
os.makedirs(OUT, exist_ok=True)

img = Image.open(SRC).convert("RGBA")
W, H = img.size
print(f"Source: {W}x{H}")

COLS, ROWS = 6, 3
cell_w = W // COLS   # 230
cell_h = H // ROWS   # 250

idx = 1
for r in range(ROWS):
    for c in range(COLS):
        left = c * cell_w
        top = r * cell_h
        right = left + cell_w
        bottom = top + cell_h
        crop = img.crop((left, top, right, bottom))
        out_path = os.path.join(OUT, f"char_{idx:02d}.png")
        crop.save(out_path, "PNG")
        print(f"  {out_path}  ({cell_w}x{cell_h})")
        idx += 1

print(f"\nDone: {idx-1} characters saved to {OUT}")
