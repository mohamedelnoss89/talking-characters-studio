@echo off
chcp 65001 >nul
title بناء المحرر العربي للفيديو - Build Script

echo ============================================
echo   بناء المحرر العربي للفيديو
echo   Building Arabic Video Editor
echo ============================================
echo.

cd /d "%~dp0"

echo [1/3] فحص Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo ❌ Node.js غير مثبت
    echo.
    echo من فضلك ثبت Node.js من: https://nodejs.org/
    pause
    exit /b 1
)
echo ✅ Node.js موجود

echo.
echo [2/3] تثبيت الحزم...
if not exist "node_modules" (
    call npm install
    if errorlevel 1 (
        echo ❌ خطأ في تثبيت الحزم
        pause
        exit /b 1
    )
) else (
    echo ✅ الحزم مثبتة بالفعل
)

echo.
echo [3/3] بناء ملف التثبيت...
echo ⏳ قد يستغرق هذا عدة دقائق...
echo.

call npm run build

if errorlevel 1 (
    echo.
    echo ❌ فشل البناء
    pause
    exit /b 1
)

echo.
echo ============================================
echo   ✅ تم بناء البرنامج بنجاح!
echo ============================================
echo.
echo 📁 الملفات الناتجة في مجلد dist/:
echo    - ArabicVideoEditor-Setup-1.0.0.exe (للتثبيت الكامل)
echo    - ArabicVideoEditor-Portable-1.0.0.exe (نسخة محمولة)
echo.
echo يمكنك توزيع هذه الملفات للمستخدمين
echo.
pause
