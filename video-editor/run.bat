@echo off
chcp 65001 >nul
title المحرر العربي للفيديو - Studio Pro

echo ============================================
echo   المحرر العربي للفيديو - Studio Pro
echo ============================================
echo.

cd /d "%~dp0"

if not exist "node_modules" (
    echo [1/2] جاري تثبيت الحزم...
    call npm install
    if errorlevel 1 (
        echo.
        echo ❌ خطأ في تثبيت الحزم
        pause
        exit /b 1
    )
)

echo [2/2] جاري تشغيل البرنامج...
echo.

call npm start

if errorlevel 1 (
    echo.
    echo ❌ حدث خطأ أثناء التشغيل
    pause
)
