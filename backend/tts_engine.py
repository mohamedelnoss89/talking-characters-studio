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
    # --- مصر ---
    {"id": "ar-EG-SalmaNeural",  "name": "سلمى",  "gender": "Female", "lang": "ar-EG", "label_ar": "سلمى (مصر - أنثى)",       "label_en": "Salma (Egypt - Female)"},
    {"id": "ar-EG-ShakirNeural", "name": "شاكر",  "gender": "Male",   "lang": "ar-EG", "label_ar": "شاكر (مصر - ذكر)",         "label_en": "Shakir (Egypt - Male)"},
    # --- السعودية ---
    {"id": "ar-SA-ZariyahNeural","name": "زارية", "gender": "Female", "lang": "ar-SA", "label_ar": "زارية (السعودية - أنثى)",   "label_en": "Zariyah (Saudi - Female)"},
    {"id": "ar-SA-HamedNeural",  "name": "حامد",  "gender": "Male",   "lang": "ar-SA", "label_ar": "حامد (السعودية - ذكر)",     "label_en": "Hamed (Saudi - Male)"},
    # --- الإمارات ---
    {"id": "ar-AE-FatimaNeural", "name": "فاطمة", "gender": "Female", "lang": "ar-AE", "label_ar": "فاطمة (الإمارات - أنثى)",   "label_en": "Fatima (UAE - Female)"},
    {"id": "ar-AE-HamdanNeural", "name": "حمدان", "gender": "Male",   "lang": "ar-AE", "label_ar": "حمدان (الإمارات - ذكر)",   "label_en": "Hamdan (UAE - Male)"},
    # --- لبنان ---
    {"id": "ar-LB-LaylaNeural",  "name": "ليلى",  "gender": "Female", "lang": "ar-LB", "label_ar": "ليلى (لبنان - أنثى)",       "label_en": "Layla (Lebanon - Female)"},
    {"id": "ar-LB-RamiNeural",   "name": "رامي",  "gender": "Male",   "lang": "ar-LB", "label_ar": "رامي (لبنان - ذكر)",       "label_en": "Rami (Lebanon - Male)"},
    # --- الأردن ---
    {"id": "ar-JO-SanaNeural",   "name": "سنا",   "gender": "Female", "lang": "ar-JO", "label_ar": "سنا (الأردن - أنثى)",        "label_en": "Sana (Jordan - Female)"},
    {"id": "ar-JO-TaimNeural",   "name": "تيم",   "gender": "Male",   "lang": "ar-JO", "label_ar": "تيم (الأردن - ذكر)",        "label_en": "Taim (Jordan - Male)"},
    # --- العراق ---
    {"id": "ar-IQ-RanaNeural",   "name": "رنا",   "gender": "Female", "lang": "ar-IQ", "label_ar": "رنا (العراق - أنثى)",        "label_en": "Rana (Iraq - Female)"},
    {"id": "ar-IQ-BasselNeural", "name": "باسل",  "gender": "Male",   "lang": "ar-IQ", "label_ar": "باسل (العراق - ذكر)",       "label_en": "Bassel (Iraq - Male)"},
    # --- المغرب ---
    {"id": "ar-MA-MounaNeural",  "name": "منى",   "gender": "Female", "lang": "ar-MA", "label_ar": "منى (المغرب - أنثى)",        "label_en": "Mouna (Morocco - Female)"},
    {"id": "ar-MA-JamalNeural",  "name": "جمال",  "gender": "Male",   "lang": "ar-MA", "label_ar": "جمال (المغرب - ذكر)",       "label_en": "Jamal (Morocco - Male)"},
    # --- الكويت ---
    {"id": "ar-KW-NouraNeural",  "name": "نورة",  "gender": "Female", "lang": "ar-KW", "label_ar": "نورة (الكويت - أنثى)",      "label_en": "Noura (Kuwait - Female)"},
    {"id": "ar-KW-FahedNeural",  "name": "فهد",   "gender": "Male",   "lang": "ar-KW", "label_ar": "فهد (الكويت - ذكر)",        "label_en": "Fahed (Kuwait - Male)"},
    # --- قطر ---
    {"id": "ar-QA-AmalNeural",   "name": "أمل",   "gender": "Female", "lang": "ar-QA", "label_ar": "أمل (قطر - أنثى)",           "label_en": "Amal (Qatar - Female)"},
    {"id": "ar-QA-MoazNeural",   "name": "معاذ",  "gender": "Male",   "lang": "ar-QA", "label_ar": "معاذ (قطر - ذكر)",           "label_en": "Moaz (Qatar - Male)"},
    # --- سوريا ---
    {"id": "ar-SY-AmanyNeural",  "name": "أماني", "gender": "Female", "lang": "ar-SY", "label_ar": "أماني (سوريا - أنثى)",       "label_en": "Amany (Syria - Female)"},
    {"id": "ar-SY-LaithNeural",  "name": "ليث",   "gender": "Male",   "lang": "ar-SY", "label_ar": "ليث (سوريا - ذكر)",          "label_en": "Laith (Syria - Male)"},
    # --- إنجليزي ---
    {"id": "en-US-AriaNeural",   "name": "Aria",  "gender": "Female", "lang": "en-US", "label_ar": "Aria (إنجليزي US - أنثى)",  "label_en": "Aria (English US - Female)"},
    {"id": "en-US-GuyNeural",    "name": "Guy",   "gender": "Male",   "lang": "en-US", "label_ar": "Guy (إنجليزي US - ذكر)",    "label_en": "Guy (English US - Male)"},
    {"id": "en-GB-SoniaNeural",  "name": "Sonia", "gender": "Female", "lang": "en-GB", "label_ar": "Sonia (إنجليزي UK - أنثى)", "label_en": "Sonia (English UK - Female)"},
    {"id": "en-GB-RyanNeural",   "name": "Ryan",  "gender": "Male",   "lang": "en-GB", "label_ar": "Ryan (إنجليزي UK - ذكر)",   "label_en": "Ryan (English UK - Male)"},
    # --- فرنسي ---
    {"id": "fr-FR-DeniseNeural", "name": "Denise","gender": "Female", "lang": "fr-FR", "label_ar": "Denise (فرنسي - أنثى)",     "label_en": "Denise (French - Female)"},
    {"id": "fr-FR-HenriNeural",  "name": "Henri", "gender": "Male",   "lang": "fr-FR", "label_ar": "Henri (فرنسي - ذكر)",       "label_en": "Henri (French - Male)"},
]


def get_voices():
    """يرجع قائمة الأصوات المقترحة للواجهة."""
    return RECOMMENDED_VOICES


def get_default_voice():
    """الصوت الافتراضي (سلمى - مصر)."""
    return "ar-EG-SalmaNeural"


def _validate_voice(voice_id: str) -> str:
    """يتأكد إن الصوت موجود في القائمة، لو لأ يرجع الافتراضي."""
    for v in RECOMMENDED_VOICES:
        if v["id"] == voice_id:
            return voice_id
    # لو مفيش، اقبل أي صوت يشبه الـ edge-tts format (xx-YY-NameNeural)
    if voice_id and len(voice_id) > 5 and "Neural" in voice_id:
        return voice_id
    return get_default_voice()


async def _synthesize(text: str, voice: str, output_path: str,
                      rate: str = "+0%", volume: str = "+0%",
                      pitch: str = "+0Hz") -> str:
    """
    يشغّل الـ TTS ويحفظ الناتج في output_path.
    rate:    سرعة الكلام (مثلاً "+10%" أو "-10%")
    volume:  مستوى الصوت
    pitch:   طبقة الصوت
    """
    voice = _validate_voice(voice)
    text = (text or "").strip()
    if not text:
        raise ValueError("النص فاضي - لا يمكن توليد صوت بدون نص")

    communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
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
