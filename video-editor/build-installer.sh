#!/bin/bash
# سكربت بناء المحرر العربي للفيديو
# Build script for Arabic Video Editor

cd "$(dirname "$0")"

echo "============================================"
echo "  بناء المحرر العربي للفيديو"
echo "  Building Arabic Video Editor"
echo "============================================"
echo ""

# فحص Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js غير مثبت"
    echo "من فضلك ثبت Node.js من: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js موجود: $(node --version)"

# تثبيت الحزم
echo ""
echo "[2/3] تثبيت الحزم..."
if [ ! -d "node_modules" ]; then
    npm install || { echo "❌ خطأ في تثبيت الحزم"; exit 1; }
else
    echo "✅ الحزم مثبتة بالفعل"
fi

# بناء
echo ""
echo "[3/3] بناء ملف التثبيت..."
echo "⏳ قد يستغرق هذا عدة دقائق..."
echo ""

npm run build || { echo "❌ فشل البناء"; exit 1; }

echo ""
echo "============================================"
echo "  ✅ تم بناء البرنامج بنجاح!"
echo "============================================"
echo ""
echo "📁 الملفات الناتجة في مجلد dist/:"
echo "   - ArabicVideoEditor-Setup-1.0.0.exe (للتثبيت الكامل)"
echo "   - ArabicVideoEditor-Portable-1.0.0.exe (نسخة محمولة)"
