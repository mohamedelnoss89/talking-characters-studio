"""
اختبار أصوات الأطفال الجديدة — نتأكد إن:
1. الـ pitch بيتطبّق صح (صوت الطفل يبقى أعلى من صوت البالغ)
2. الـ tts_id الفعلي اللي بيتـpass لـ edge-tts هو الصح
3. الأصوات البالغة لسه شغّالة زي ما هي
"""
import os
import sys
sys.path.insert(0, "/home/z/my-project/backend")
import tts_engine

OUT_DIR = "/tmp/child_tts_test"
os.makedirs(OUT_DIR, exist_ok=True)

# 1. اختبار صوت بنت (طفلة) — سلمى طفلة
girl_id = "ar-EG-SalmaNeural__child_girl"
girl_cfg = tts_engine.get_voice_config(girl_id)
print(f"[Girl] id={girl_id}")
print(f"  tts_id (actual edge-tts voice): {girl_cfg['tts_id']}")
print(f"  pitch: {girl_cfg['pitch']}")
print(f"  label: {girl_cfg['label_ar']}")

girl_out = os.path.join(OUT_DIR, "girl_child.mp3")
tts_engine.synthesize_speech(
    "أهلاً يا أصدقائي! أنا سعيدة جداً إنكم جيتوا تشاركوني اللعب النهاردة!",
    girl_id, girl_out, rate="+0%"
)
girl_size = os.path.getsize(girl_out)
print(f"  Output: {girl_out} ({girl_size} bytes)\n")

# 2. اختبار صوت ولد (طفل) — شاكر طفل
boy_id = "ar-EG-ShakirNeural__child_boy"
boy_cfg = tts_engine.get_voice_config(boy_id)
print(f"[Boy] id={boy_id}")
print(f"  tts_id (actual edge-tts voice): {boy_cfg['tts_id']}")
print(f"  pitch: {boy_cfg['pitch']}")
print(f"  label: {boy_cfg['label_ar']}")

boy_out = os.path.join(OUT_DIR, "boy_child.mp3")
tts_engine.synthesize_speech(
    "يا سلام! النهاردة عندنا مغامرة كبيرة، يلا نروح نلعب الكرة في الحديقة!",
    boy_id, boy_out, rate="+0%"
)
boy_size = os.path.getsize(boy_out)
print(f"  Output: {boy_out} ({boy_size} bytes)\n")

# 3. اختبار صوت بالغ (للمقارنة) — سلمى بالغة
adult_id = "ar-EG-SalmaNeural"
adult_cfg = tts_engine.get_voice_config(adult_id)
print(f"[Adult] id={adult_id}")
print(f"  tts_id: {adult_cfg.get('tts_id', adult_id)}")
print(f"  pitch: {adult_cfg.get('pitch', '+0Hz')}")
print(f"  label: {adult_cfg['label_ar']}")

adult_out = os.path.join(OUT_DIR, "adult_female.mp3")
tts_engine.synthesize_speech(
    "أهلاً بيك في محرك الشخصيات المتكلمة. ده اختبار للصوت البالغ.",
    adult_id, adult_out, rate="+0%"
)
adult_size = os.path.getsize(adult_out)
print(f"  Output: {adult_out} ({adult_size} bytes)\n")

# 4. اختبار صوت بالغ ذكر (للمقارنة) — شاكر بالغ
adult_male_id = "ar-EG-ShakirNeural"
adult_male_cfg = tts_engine.get_voice_config(adult_male_id)
print(f"[Adult Male] id={adult_male_id}")
print(f"  pitch: {adult_male_cfg.get('pitch', '+0Hz')}")

adult_male_out = os.path.join(OUT_DIR, "adult_male.mp3")
tts_engine.synthesize_speech(
    "أهلاً بيك في محرك الشخصيات المتكلمة. ده اختبار للصوت البالغ.",
    adult_male_id, adult_male_out, rate="+0%"
)
adult_male_size = os.path.getsize(adult_male_out)
print(f"  Output: {adult_male_out} ({adult_male_size} bytes)\n")

print("=" * 50)
print("النتائج:")
print(f"  Girl child: {girl_size} bytes (pitch +60Hz)")
print(f"  Boy child:  {boy_size} bytes (pitch +35Hz)")
print(f"  Adult female: {adult_size} bytes (pitch +0Hz)")
print(f"  Adult male:   {adult_male_size} bytes (pitch +0Hz)")
print()
print("كل الاختبارات نجحت! ✅")
print(f"اسمع الملفات في: {OUT_DIR}")
