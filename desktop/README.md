# Talking Characters Studio — Desktop (Electron)

هذا المجلد يحتوي على تطبيق Electron الذي يغلّف تطبيق الويب (PWA) المُستضاف على Vercel،
ويشغّل Python backend محليًا على جهاز المستخدم.

## البنية

```
desktop/
├── package.json          → إعدادات Electron + electron-builder
├── src/
│   ├── main.js           → العملية الرئيسية: تشغيل Python، فتح النافذة
│   ├── preload.js        → جسر IPC آمن بين النافذة و main
│   ├── installer.html    → واجهة شاشة التثبيت
│   └── installer-python.js  → منطق تثبيت Python + pip + Wav2Lip
├── build/
│   └── icon.png          → أيقونة التطبيق
└── dist/                 → مخرجات البناء (يتم إنشاؤها)
```

## كيف يعمل

1. **عند أول تشغيل**: Electron يفتح نافذة `installer.html`
2. **شاشة التثبيت** تقوم بـ:
   - تثبيت Python (إن لم يكن موجودًا)
   - إنشاء venv في `%LOCALAPPDATA%/Talking Characters Studio/venv`
   - تثبيت كل المكتبات (torch, opencv, fastapi, mediapipe, ...)
   - تحميل Wav2Lip + checkpoint (~415MB)
3. **بعد التثبيت**: Electron يشغّل `python backend/server.py` كـ child process
4. **ينتظر** حتى يستجيب `/health` على `http://localhost:8000`
5. **يفتح النافذة الرئيسية** التي تحمّل PWA من Vercel

## البناء (للمطورين فقط)

```bash
cd desktop/
npm install
npm run build          # ينتج NSIS installer لـ Windows
npm run build:mac      # ينتج DMG لـ macOS
npm run build:portable # نسخة portable بدون تثبيت
```

الناتج في `desktop/dist/`.

## ملاحظات

- التطبيق يحتاج إنترنت لأول تشغيل (تحميل Python + models)
- بعد ذلك، يمكنه العمل أوفلاين (ما عدا OAuth و character generation التي تحتاج ZAI API)
- حجم الـ installer النهائي: ~200MB (بدون models)
- أول تشغيل ينزل ~3GB إضافية من الـ models
