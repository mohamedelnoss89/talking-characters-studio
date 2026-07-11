"""
Text-to-Speech engine using Microsoft Edge TTS (free, no API key).
يدعم لغات ولهجات كتير، بصفة خاصة اللهجات العربية المختلفة.
"""
import asyncio
import os
from typing import Optional

import edge_tts


# ============================================================
# قائمة الأصوات المقترحة للواجهة (عربي + إنجليزي + لغات إضافية)
# مرتبة بحيث الأصوات العربية تظهر أولاً
# ============================================================
RECOMMENDED_VOICES = [
    # ============================================================
    # أصوات البالغين (Adult voices) — pitch افتراضي +0Hz
    # ============================================================
    # --- مصر ---
    {"id": "ar-EG-SalmaNeural",  "name": "سلمى",  "gender": "Female", "lang": "ar-EG", "category": "adult", "pitch": "+0Hz",
     "label_ar": "سلمى (مصر - أنثى)",       "label_en": "Salma (Egypt - Female)"},
    {"id": "ar-EG-ShakirNeural", "name": "شاكر",  "gender": "Male",   "lang": "ar-EG", "category": "adult", "pitch": "+0Hz",
     "label_ar": "شاكر (مصر - ذكر)",         "label_en": "Shakir (Egypt - Male)"},
    # --- السعودية ---
    {"id": "ar-SA-ZariyahNeural","name": "زارية", "gender": "Female", "lang": "ar-SA", "category": "adult", "pitch": "+0Hz",
     "label_ar": "زارية (السعودية - أنثى)",   "label_en": "Zariyah (Saudi - Female)"},
    {"id": "ar-SA-HamedNeural",  "name": "حامد",  "gender": "Male",   "lang": "ar-SA", "category": "adult", "pitch": "+0Hz",
     "label_ar": "حامد (السعودية - ذكر)",     "label_en": "Hamed (Saudi - Male)"},
    # --- الإمارات ---
    {"id": "ar-AE-FatimaNeural", "name": "فاطمة", "gender": "Female", "lang": "ar-AE", "category": "adult", "pitch": "+0Hz",
     "label_ar": "فاطمة (الإمارات - أنثى)",   "label_en": "Fatima (UAE - Female)"},
    {"id": "ar-AE-HamdanNeural", "name": "حمدان", "gender": "Male",   "lang": "ar-AE", "category": "adult", "pitch": "+0Hz",
     "label_ar": "حمدان (الإمارات - ذكر)",   "label_en": "Hamdan (UAE - Male)"},
    # --- لبنان ---
    {"id": "ar-LB-LaylaNeural",  "name": "ليلى",  "gender": "Female", "lang": "ar-LB", "category": "adult", "pitch": "+0Hz",
     "label_ar": "ليلى (لبنان - أنثى)",       "label_en": "Layla (Lebanon - Female)"},
    {"id": "ar-LB-RamiNeural",   "name": "رامي",  "gender": "Male",   "lang": "ar-LB", "category": "adult", "pitch": "+0Hz",
     "label_ar": "رامي (لبنان - ذكر)",       "label_en": "Rami (Lebanon - Male)"},
    # --- الأردن ---
    {"id": "ar-JO-SanaNeural",   "name": "سنا",   "gender": "Female", "lang": "ar-JO", "category": "adult", "pitch": "+0Hz",
     "label_ar": "سنا (الأردن - أنثى)",        "label_en": "Sana (Jordan - Female)"},
    {"id": "ar-JO-TaimNeural",   "name": "تيم",   "gender": "Male",   "lang": "ar-JO", "category": "adult", "pitch": "+0Hz",
     "label_ar": "تيم (الأردن - ذكر)",        "label_en": "Taim (Jordan - Male)"},
    # --- العراق ---
    {"id": "ar-IQ-RanaNeural",   "name": "رنا",   "gender": "Female", "lang": "ar-IQ", "category": "adult", "pitch": "+0Hz",
     "label_ar": "رنا (العراق - أنثى)",        "label_en": "Rana (Iraq - Female)"},
    {"id": "ar-IQ-BasselNeural", "name": "باسل",  "gender": "Male",   "lang": "ar-IQ", "category": "adult", "pitch": "+0Hz",
     "label_ar": "باسل (العراق - ذكر)",       "label_en": "Bassel (Iraq - Male)"},
    # --- المغرب ---
    {"id": "ar-MA-MounaNeural",  "name": "منى",   "gender": "Female", "lang": "ar-MA", "category": "adult", "pitch": "+0Hz",
     "label_ar": "منى (المغرب - أنثى)",        "label_en": "Mouna (Morocco - Female)"},
    {"id": "ar-MA-JamalNeural",  "name": "جمال",  "gender": "Male",   "lang": "ar-MA", "category": "adult", "pitch": "+0Hz",
     "label_ar": "جمال (المغرب - ذكر)",       "label_en": "Jamal (Morocco - Male)"},
    # --- الكويت ---
    {"id": "ar-KW-NouraNeural",  "name": "نورة",  "gender": "Female", "lang": "ar-KW", "category": "adult", "pitch": "+0Hz",
     "label_ar": "نورة (الكويت - أنثى)",      "label_en": "Noura (Kuwait - Female)"},
    {"id": "ar-KW-FahedNeural",  "name": "فهد",   "gender": "Male",   "lang": "ar-KW", "category": "adult", "pitch": "+0Hz",
     "label_ar": "فهد (الكويت - ذكر)",        "label_en": "Fahed (Kuwait - Male)"},
    # --- قطر ---
    {"id": "ar-QA-AmalNeural",   "name": "أمل",   "gender": "Female", "lang": "ar-QA", "category": "adult", "pitch": "+0Hz",
     "label_ar": "أمل (قطر - أنثى)",           "label_en": "Amal (Qatar - Female)"},
    {"id": "ar-QA-MoazNeural",   "name": "معاذ",  "gender": "Male",   "lang": "ar-QA", "category": "adult", "pitch": "+0Hz",
     "label_ar": "معاذ (قطر - ذكر)",           "label_en": "Moaz (Qatar - Male)"},
    # --- سوريا ---
    {"id": "ar-SY-AmanyNeural",  "name": "أماني", "gender": "Female", "lang": "ar-SY", "category": "adult", "pitch": "+0Hz",
     "label_ar": "أماني (سوريا - أنثى)",       "label_en": "Amany (Syria - Female)"},
    {"id": "ar-SY-LaithNeural",  "name": "ليث",   "gender": "Male",   "lang": "ar-SY", "category": "adult", "pitch": "+0Hz",
     "label_ar": "ليث (سوريا - ذكر)",          "label_en": "Laith (Syria - Male)"},
    # --- إنجليزي ---
    {"id": "en-US-AriaNeural",   "name": "Aria",  "gender": "Female", "lang": "en-US", "category": "adult", "pitch": "+0Hz",
     "label_ar": "Aria (إنجليزي US - أنثى)",  "label_en": "Aria (English US - Female)"},
    {"id": "en-US-GuyNeural",    "name": "Guy",   "gender": "Male",   "lang": "en-US", "category": "adult", "pitch": "+0Hz",
     "label_ar": "Guy (إنجليزي US - ذكر)",    "label_en": "Guy (English US - Male)"},
    {"id": "en-GB-SoniaNeural",  "name": "Sonia", "gender": "Female", "lang": "en-GB", "category": "adult", "pitch": "+0Hz",
     "label_ar": "Sonia (إنجليزي UK - أنثى)", "label_en": "Sonia (English UK - Female)"},
    {"id": "en-GB-RyanNeural",   "name": "Ryan",  "gender": "Male",   "lang": "en-GB", "category": "adult", "pitch": "+0Hz",
     "label_ar": "Ryan (إنجليزي UK - ذكر)",   "label_en": "Ryan (English UK - Male)"},
    # --- فرنسي ---
    {"id": "fr-FR-DeniseNeural", "name": "Denise","gender": "Female", "lang": "fr-FR", "category": "adult", "pitch": "+0Hz",
     "label_ar": "Denise (فرنسي - أنثى)",     "label_en": "Denise (French - Female)"},
    {"id": "fr-FR-HenriNeural",  "name": "Henri", "gender": "Male",   "lang": "fr-FR", "category": "adult", "pitch": "+0Hz",
     "label_ar": "Henri (فرنسي - ذكر)",       "label_en": "Henri (French - Male)"},

    # ============================================================
    # أصوات الأطفال (Child voices) — محاكاة بـ pitch أعلى
    # edge-tts مفيهوش أصوات أطفال أصلية، فبنستخدم أصوات بالغة مع pitch
    # أعلى (بنات: +60Hz، ولاد: +35Hz) عشان نعطي إحساس صوت طفل
    # ============================================================
    # --- بنات (Girls) ---
    # ملاحظة: الـ id بياخد suffix "__child" عشان يكون فريد ومتميز عن صوت البالغين.
    # الـ edge-tts voice الفعلي موجود في حقل "tts_id".
    {"id": "ar-EG-SalmaNeural__child_girl",  "tts_id": "ar-EG-SalmaNeural",  "name": "سلمى - طفلة",  "gender": "Female", "lang": "ar-EG", "category": "child", "pitch": "+60Hz",
     "label_ar": "سلمى - طفلة (مصر - بنت)",       "label_en": "Salma - Child (Egypt - Girl)"},
    {"id": "ar-SA-ZariyahNeural__child_girl", "tts_id": "ar-SA-ZariyahNeural","name": "زارية - طفلة", "gender": "Female", "lang": "ar-SA", "category": "child", "pitch": "+60Hz",
     "label_ar": "زارية - طفلة (السعودية - بنت)",   "label_en": "Zariyah - Child (Saudi - Girl)"},
    {"id": "ar-AE-FatimaNeural__child_girl",  "tts_id": "ar-AE-FatimaNeural", "name": "فاطمة - طفلة", "gender": "Female", "lang": "ar-AE", "category": "child", "pitch": "+60Hz",
     "label_ar": "فاطمة - طفلة (الإمارات - بنت)",   "label_en": "Fatima - Child (UAE - Girl)"},
    {"id": "ar-LB-LaylaNeural__child_girl",   "tts_id": "ar-LB-LaylaNeural",  "name": "ليلى - طفلة",  "gender": "Female", "lang": "ar-LB", "category": "child", "pitch": "+60Hz",
     "label_ar": "ليلى - طفلة (لبنان - بنت)",       "label_en": "Layla - Child (Lebanon - Girl)"},
    {"id": "en-US-AriaNeural__child_girl",    "tts_id": "en-US-AriaNeural",   "name": "Aria - Child", "gender": "Female", "lang": "en-US", "category": "child", "pitch": "+60Hz",
     "label_ar": "Aria - طفلة (إنجليزي US - بنت)",  "label_en": "Aria - Child (English US - Girl)"},
    {"id": "en-GB-SoniaNeural__child_girl",   "tts_id": "en-GB-SoniaNeural",  "name": "Sonia - Child","gender": "Female", "lang": "en-GB", "category": "child", "pitch": "+60Hz",
     "label_ar": "Sonia - طفلة (إنجليزي UK - بنت)", "label_en": "Sonia - Child (English UK - Girl)"},

    # --- ولاد (Boys) ---
    {"id": "ar-EG-ShakirNeural__child_boy",  "tts_id": "ar-EG-ShakirNeural", "name": "شاكر - طفل",  "gender": "Male",   "lang": "ar-EG", "category": "child", "pitch": "+35Hz",
     "label_ar": "شاكر - طفل (مصر - ولد)",         "label_en": "Shakir - Child (Egypt - Boy)"},
    {"id": "ar-SA-HamedNeural__child_boy",   "tts_id": "ar-SA-HamedNeural",  "name": "حامد - طفل",  "gender": "Male",   "lang": "ar-SA", "category": "child", "pitch": "+35Hz",
     "label_ar": "حامد - طفل (السعودية - ولد)",     "label_en": "Hamed - Child (Saudi - Boy)"},
    {"id": "ar-AE-HamdanNeural__child_boy",  "tts_id": "ar-AE-HamdanNeural", "name": "حمدان - طفل", "gender": "Male",   "lang": "ar-AE", "category": "child", "pitch": "+35Hz",
     "label_ar": "حمدان - طفل (الإمارات - ولد)",   "label_en": "Hamdan - Child (UAE - Boy)"},
    {"id": "ar-LB-RamiNeural__child_boy",    "tts_id": "ar-LB-RamiNeural",   "name": "رامي - طفل",  "gender": "Male",   "lang": "ar-LB", "category": "child", "pitch": "+35Hz",
     "label_ar": "رامي - طفل (لبنان - ولد)",       "label_en": "Rami - Child (Lebanon - Boy)"},
    {"id": "en-US-GuyNeural__child_boy",     "tts_id": "en-US-GuyNeural",    "name": "Guy - Child", "gender": "Male",   "lang": "en-US", "category": "child", "pitch": "+35Hz",
     "label_ar": "Guy - طفل (إنجليزي US - ولد)",    "label_en": "Guy - Child (English US - Boy)"},
    {"id": "en-GB-RyanNeural__child_boy",    "tts_id": "en-GB-RyanNeural",   "name": "Ryan - Child","gender": "Male",   "lang": "en-GB", "category": "child", "pitch": "+35Hz",
     "label_ar": "Ryan - طفل (إنجليزي UK - ولد)",   "label_en": "Ryan - Child (English UK - Boy)"},
]

# فهرس سريع للوصول لصوت بواسطة الـ id الفريد
_VOICE_BY_ID = {v["id"]: v for v in RECOMMENDED_VOICES}


def get_voices():
    """يرجع قائمة الأصوات المقترحة للواجهة."""
    return RECOMMENDED_VOICES


def get_default_voice():
    """الصوت الافتراضي (سلمى - مصر)."""
    return "ar-EG-SalmaNeural"


def get_voice_config(voice_id: str) -> dict:
    """
    بيرجع الـ config كامل للصوت بواسطة الـ id الفريد.
    لو الصوت مش في القائمة، بيرجع dict فيه tts_id = voice_id و pitch = "+0Hz".
    ده بيخلي الأصوات البالغة (اللي الـ id بتاعها = tts_id) تشتغل من غير تغيير.
    """
    v = _VOICE_BY_ID.get(voice_id)
    if v:
        return v
    # fallback: لو الـ voice_id هو نفسه الـ edge-tts voice ID (أصوات بالغة قديمة)
    for v in RECOMMENDED_VOICES:
        if v.get("tts_id") == voice_id or v["id"] == voice_id:
            return v
    # لو مش موجود خالص، ارجع default config
    return {"id": voice_id, "tts_id": voice_id, "name": voice_id,
            "gender": "Unknown", "lang": "", "category": "adult", "pitch": "+0Hz",
            "label_ar": voice_id, "label_en": voice_id}


def _validate_voice(voice_id: str) -> str:
    """
    بيرجع الـ edge-tts voice ID الفعلي للصوت.
    - لو الصوت في القائمة، بيرجع الـ tts_id بتاعه.
    - لو لأ، بيقبل أي صوت يشبه الـ edge-tts format (xx-YY-NameNeural).
    - غير كده، بيرجع الافتراضي.
    """
    cfg = get_voice_config(voice_id)
    tts_id = cfg.get("tts_id") or cfg.get("id") or voice_id
    if tts_id in _VOICE_BY_ID or any(v["id"] == tts_id for v in RECOMMENDED_VOICES):
        return tts_id
    # اقبل أي صوت يشبه الـ edge-tts format
    if voice_id and len(voice_id) > 5 and "Neural" in voice_id:
        return voice_id
    return get_default_voice()


def _resolve_pitch(voice_id: str, requested_pitch: str = "+0Hz") -> str:
    """
    بيرجع الـ pitch المناسب للصوت:
    - لو المستخدم طلب pitch محدد (غير +0Hz)، نستخدمه.
    - غير كده، نستخدم الـ pitch من الـ config بتاع الصوت (مهم لأصوات الأطفال).
    """
    if requested_pitch and requested_pitch != "+0Hz":
        return requested_pitch
    cfg = get_voice_config(voice_id)
    return cfg.get("pitch", "+0Hz")


async def _synthesize(text: str, voice: str, output_path: str,
                      rate: str = "+0%", volume: str = "+0%",
                      pitch: str = "+0Hz") -> str:
    """
    يشغّل الـ TTS ويحفظ الناتج في output_path.
    voice:  الـ id الفريد للصوت (ممكن يكون edge-tts voice ID مباشرة، أو id من القائمة)
    rate:    سرعة الكلام (مثلاً "+10%" أو "-10%")
    volume:  مستوى الصوت
    pitch:   طبقة الصوت (لو +0Hz، بيتستخدم pitch الصوت من الـ config — مهم لأصوات الأطفال)
    """
    # اجيب الـ config عشان نعرف الـ tts_id الفعلي + الـ pitch المناسب
    cfg = get_voice_config(voice)
    tts_voice = cfg.get("tts_id") or _validate_voice(voice)
    effective_pitch = _resolve_pitch(voice, pitch)

    text = (text or "").strip()
    if not text:
        raise ValueError("النص فاضي - لا يمكن توليد صوت بدون نص")

    communicate = edge_tts.Communicate(text, tts_voice, rate=rate, volume=volume, pitch=effective_pitch)
    await communicate.save(output_path)

    if not os.path.isfile(output_path) or os.path.getsize(output_path) < 100:
        raise RuntimeError("فشل توليد الصوت - الملف الناتج فاضي أو صغير جداً")
    return output_path


def synthesize_speech(text: str, voice: str, output_path: str,
                      rate: str = "+0%", volume: str = "+0%",
                      pitch: str = "+0Hz") -> str:
    """
    Sync wrapper لـ _synthesize - يستخدمها الـ FastAPI.
    يرجع مسار ملف الـ audio.
    """
    # edge-tts بيعتمد على asyncio، فلازم نعمل/نمسك loop
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # لو الـ loop شغال، نعمل loop جديد في thread
            import threading
            result = {}
            def _run():
                try:
                    new_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(new_loop)
                    result["path"] = new_loop.run_until_complete(
                        _synthesize(text, voice, output_path, rate, volume, pitch)
                    )
                    new_loop.close()
                except Exception as e:
                    result["error"] = e
            t = threading.Thread(target=_run)
            t.start()
            t.join()
            if "error" in result:
                raise result["error"]
            return result["path"]
    except RuntimeError:
        pass

    # الحالة العادية: اعمل loop جديد
    return asyncio.run(_synthesize(text, voice, output_path, rate, volume, pitch))


if __name__ == "__main__":
    # اختبار سريع
    out = "/tmp/tts_test.mp3"
    print("Testing TTS with ar-EG-SalmaNeural...")
    synthesize_speech("أهلاً بيك في محرك الشخصيات المتكلمة. ده اختبار للصوت.",
                      "ar-EG-SalmaNeural", out)
    size = os.path.getsize(out)
    print(f"OK - {out} ({size} bytes)")
