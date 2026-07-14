"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Sparkles,
  Download,
  Smartphone,
  Monitor,
  Globe,
  CheckCircle2,
  Apple,
  Loader2,
  Info,
  Shield,
  Zap,
} from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";

/**
 * Install page — lets users install the app as a PWA or download the APK.
 *
 * Two main buttons:
 *   1. "تثبيت التطبيق" — triggers the browser's native PWA install prompt
 *      (works on Chrome, Edge, Samsung Internet, etc.). On iOS Safari,
 *      shows instructions for "Add to Home Screen".
 *   2. "تحميل APK" — downloads the Android APK (placeholder for now; the
 *      actual APK will be generated in a later step).
 *
 * Bilingual (ar/en) — defaults to Arabic, RTL.
 */

// TypeScript: extend the BeforeInstallPromptEvent with the fields we use
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function InstallPage() {
  const { toast } = useToast();
  const [lang, setLang] = useState<"ar" | "en">("ar");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [platform, setPlatform] = useState<"android" | "ios" | "desktop" | "other">("other");

  const isRTL = lang === "ar";
  const t = {
    title: lang === "ar" ? "تثبيت التطبيق" : "Install the App",
    subtitle:
      lang === "ar"
        ? "حمّل تطبيق محرك الشخصيات المتكلمة على جهازك واستخدمه في أي وقت — حتى من غير إنترنت"
        : "Install Talking Characters Studio on your device and use it anytime — even offline",
    installBtn: lang === "ar" ? "تثبيت التطبيق" : "Install App",
    installing: lang === "ar" ? "جاري التثبيت..." : "Installing...",
    installed: lang === "ar" ? "التطبيق مثبت" : "App Installed",
    downloadApk: lang === "ar" ? "تحميل APK" : "Download APK",
    apkSize: lang === "ar" ? "للأندرويد" : "For Android",
    apkComingSoon:
      lang === "ar"
        ? "ملف APK هيتوفر قريبًا. احنا شغالين عليه."
        : "APK file will be available soon. We're working on it.",
    iosInstructions:
      lang === "ar"
        ? "اضغط زر المشاركة، وبعدين Add to Home Screen"
        : "Tap the Share button, then Add to Home Screen",
    desktopInstructions:
      lang === "ar"
        ? "اضغط على زر التثبيت في شريط العنوان"
        : "Click the install button in the address bar",
    alreadyInstalled:
      lang === "ar"
        ? "التطبيق مثبت بالفعل على جهازك"
        : "The app is already installed on your device",
    notSupported:
      lang === "ar"
        ? "المتصفح بتاعك مش بيدعم تثبيت PWA. جرّب Chrome أو Edge."
        : "Your browser doesn't support PWA installation. Try Chrome or Edge.",
    features: {
      title: lang === "ar" ? "ليه تحمل التطبيق؟" : "Why install?",
      offline: lang === "ar" ? "شغّال أوفلاين" : "Works offline",
      offlineDesc:
        lang === "ar"
          ? "استخدم التطبيق من غير إنترنت — الصفحة بتتحمل مرة واحدة"
          : "Use the app without internet — the page loads once",
      fast: lang === "ar" ? "أسرع" : "Faster",
      fastDesc:
        lang === "ar"
          ? "بيفتح في ثانية — من غير ما تكتب الرابط"
          : "Opens in a second — no need to type the URL",
      native: lang === "ar" ? "زى التطبيق الأصلي" : "Native feel",
      nativeDesc:
        lang === "ar"
          ? "بيظهر كتطبيق مستقل، مش tab في المتصفح"
          : "Appears as a standalone app, not a browser tab",
    },
    steps: {
      title: lang === "ar" ? "إزاي تثبت التطبيق" : "How to install",
      android: lang === "ar" ? "على الأندرويد" : "On Android",
      ios: lang === "ar" ? "على الايفون" : "On iOS",
      desktop: lang === "ar" ? "على الكمبيوتر" : "On Desktop",
    },
    backHome: lang === "ar" ? "ارجع للصفحة الرئيسية" : "Back to home",
  };

  // Detect platform
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (/android/.test(ua)) setPlatform("android");
    else if (/iphone|ipad|ipod/.test(ua) || (ua.includes("mac") && "ontouchend" in document)) setPlatform("ios");
    else if (/windows|macintosh|linux/.test(ua)) setPlatform("desktop");
  }, []);

  // Check if already installed (running in standalone mode)
  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari
      (window.navigator as any).standalone === true;
    if (standalone) setIsInstalled(true);
  }, []);

  // Capture the beforeinstallprompt event so we can trigger it later
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    // iOS doesn't support beforeinstallprompt — show instructions instead
    if (platform === "ios") {
      toast({
        title: lang === "ar" ? "تثبيت على الايفون" : "Install on iOS",
        description: t.iosInstructions,
      });
      return;
    }

    if (!installPrompt) {
      toast({
        title: lang === "ar" ? "التثبيت مش متاح" : "Installation not available",
        description:
          platform === "desktop" ? t.desktopInstructions : t.notSupported,
      });
      return;
    }

    setIsInstalling(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setIsInstalled(true);
        toast({
          title: lang === "ar" ? "تم التثبيت" : "Installed",
          description: lang === "ar" ? "التطبيق اتثبت على جهازك" : "The app has been installed",
        });
      }
      setInstallPrompt(null);
    } catch (e) {
      toast({
        title: lang === "ar" ? "فشل التثبيت" : "Install failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setIsInstalling(false);
    }
  };

  const handleDownloadApk = () => {
    // APK isn't generated yet — show a "coming soon" message
    toast({
      title: lang === "ar" ? "قريبًا" : "Coming soon",
      description: t.apkComingSoon,
    });
  };

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          "linear-gradient(135deg, #0a0b10 0%, #161820 50%, #1a1c25 100%)",
        direction: isRTL ? "rtl" : "ltr",
      }}
    >
      <Toaster />
      {/* Language toggle */}
      <button
        type="button"
        onClick={() => setLang(lang === "ar" ? "en" : "ar")}
        className="absolute top-4 end-4 px-3 py-1.5 rounded-md bg-white/5 border border-purple-500/20 text-gray-300 hover:bg-white/10 transition-colors text-sm flex items-center gap-1.5 z-10"
      >
        <Globe className="w-4 h-4" />
        <span>{lang === "ar" ? "English" : "عربي"}</span>
      </button>

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-2xl">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-purple-500 to-pink-500 shadow-2xl shadow-purple-500/40 mb-6">
              <Sparkles className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold bg-gradient-to-r from-purple-300 to-pink-300 bg-clip-text text-transparent mb-3">
              {t.title}
            </h1>
            <p className="text-gray-400 text-sm sm:text-base px-4">{t.subtitle}</p>
          </div>

          {/* Already installed banner */}
          {isInstalled && (
            <div className="mb-6 p-4 rounded-xl bg-green-500/10 border border-green-500/30 text-green-300 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <span className="text-sm">{t.alreadyInstalled}</span>
            </div>
          )}

          {/* Main install buttons */}
          <div className="grid sm:grid-cols-2 gap-4 mb-8">
            {/* PWA Install button */}
            <button
              type="button"
              onClick={handleInstall}
              disabled={isInstalling || isInstalled}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 p-6 text-white shadow-xl shadow-purple-500/30 transition-all hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100 text-center"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center">
                  {isInstalling ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : isInstalled ? (
                    <CheckCircle2 className="w-7 h-7" />
                  ) : platform === "ios" ? (
                    <Apple className="w-7 h-7" />
                  ) : platform === "android" ? (
                    <Smartphone className="w-7 h-7" />
                  ) : (
                    <Monitor className="w-7 h-7" />
                  )}
                </div>
                <div>
                  <p className="font-bold text-lg">
                    {isInstalled ? t.installed : isInstalling ? t.installing : t.installBtn}
                  </p>
                  <p className="text-xs text-white/70 mt-1">
                    {platform === "ios"
                      ? "iOS · Safari"
                      : platform === "android"
                      ? "Android · Chrome"
                      : platform === "desktop"
                      ? "Chrome · Edge"
                      : "PWA"}
                  </p>
                </div>
              </div>
            </button>

            {/* APK Download button */}
            <button
              type="button"
              onClick={handleDownloadApk}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 p-6 text-white shadow-xl shadow-emerald-500/30 transition-all hover:scale-[1.02] text-center"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center">
                  <Download className="w-7 h-7" />
                </div>
                <div>
                  <p className="font-bold text-lg">{t.downloadApk}</p>
                  <p className="text-xs text-white/70 mt-1">{t.apkSize}</p>
                </div>
              </div>
            </button>
          </div>

          {/* Features section */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-gray-200 mb-4 text-center">
              {t.features.title}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-center">
                <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center mx-auto mb-2">
                  <Zap className="w-5 h-5 text-purple-300" />
                </div>
                <p className="font-medium text-gray-200 text-sm">{t.features.fast}</p>
                <p className="text-xs text-gray-500 mt-1">{t.features.fastDesc}</p>
              </div>
              <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-center">
                <div className="w-10 h-10 rounded-xl bg-pink-500/20 flex items-center justify-center mx-auto mb-2">
                  <Shield className="w-5 h-5 text-pink-300" />
                </div>
                <p className="font-medium text-gray-200 text-sm">{t.features.offline}</p>
                <p className="text-xs text-gray-500 mt-1">{t.features.offlineDesc}</p>
              </div>
              <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-center">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center mx-auto mb-2">
                  <Smartphone className="w-5 h-5 text-emerald-300" />
                </div>
                <p className="font-medium text-gray-200 text-sm">{t.features.native}</p>
                <p className="text-xs text-gray-500 mt-1">{t.features.nativeDesc}</p>
              </div>
            </div>
          </div>

          {/* Step-by-step instructions */}
          <div className="mb-8 p-5 rounded-xl bg-black/30 border border-purple-500/20">
            <h2 className="text-base font-semibold text-gray-200 mb-4 flex items-center gap-2">
              <Info className="w-4 h-4 text-purple-400" />
              {t.steps.title}
            </h2>
            <div className="space-y-4 text-sm">
              {/* Android */}
              <div>
                <p className="font-medium text-purple-300 mb-1">{t.steps.android}</p>
                <p className="text-gray-400">
                  {lang === "ar"
                    ? "اضغط زر «تثبيت التطبيق»، وبعدها نافذة من Chrome تطلب منك تأكيد التثبيت."
                    : "Tap «Install App», then a Chrome dialog will ask you to confirm installation."}
                </p>
              </div>
              {/* iOS */}
              <div>
                <p className="font-medium text-purple-300 mb-1">{t.steps.ios}</p>
                <p className="text-gray-400">
                  {lang === "ar"
                    ? "اضغط زر المشاركة في Safari، اسحب لتحت واختر «Add to Home Screen»."
                    : "Tap the Share button in Safari, scroll down and select «Add to Home Screen»."}
                </p>
              </div>
              {/* Desktop */}
              <div>
                <p className="font-medium text-purple-300 mb-1">{t.steps.desktop}</p>
                <p className="text-gray-400">
                  {lang === "ar"
                    ? "في Chrome أو Edge، هتلاقي أيقونة تثبيت على يمين شريط العنوان. اضغط عليها."
                    : "In Chrome or Edge, find the install icon on the right of the address bar. Click it."}
                </p>
              </div>
            </div>
          </div>

          {/* Back home link */}
          <div className="text-center">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm text-purple-300 hover:text-purple-200 transition-colors"
            >
              {t.backHome}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
