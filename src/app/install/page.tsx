"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Monitor,
  Globe,
  Loader2,
  Info,
  Shield,
  Zap,
  Lock,
  Apple,
} from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { useToast } from "@/hooks/use-toast";
import { isStandaloneMode, clearBypassFlag } from "@/lib/pwa";

/**
 * Install gate page.
 *
 * Behavior:
 *   - If the app is already running as Electron (standalone) → redirect to /login.
 *   - Otherwise show download buttons for the desktop installer:
 *       Windows: TalkingCharactersStudio-Setup-x.x.x.exe
 *       macOS:   TalkingCharactersStudio-x.x.x.dmg
 *   - The APK button shows "coming soon" (Android dropped per user request).
 */

// Detect if we're already running inside Electron (PWA standalone + electron flag)
function isElectron() {
  if (typeof window === "undefined") return false;
  return (
    (window as any).electronAPI !== undefined ||
    navigator.userAgent.toLowerCase().includes("electron")
  );
}

// GitHub Releases URLs — installers are hosted as release assets on GitHub
// (avoids Vercel's 100MB static file limit, and works for any file size).
// Release: https://github.com/mohamedelnoss89/talking-characters-studio/releases/tag/v1.0.0
const GITHUB_RELEASE_BASE =
  "https://github.com/mohamedelnoss89/talking-characters-studio/releases/latest/download";

const DOWNLOADS = {
  // RECOMMENDED for Windows: ZIP version. ZIP files don't trigger SmartScreen.
  // User extracts the ZIP, then runs the .exe inside (which may show SmartScreen
  // but at least they can see it's a real app folder with all DLLs).
  windowsZip: {
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio-1.0.0-windows.zip`,
    label: "Windows (ZIP)",
    size: "~103MB",
    icon: Monitor,
  },
  windows: {
    // Windows portable .exe (NSIS self-extracting) — smaller but triggers SmartScreen
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio-Portable-1.0.0.exe`,
    label: "Windows (.exe)",
    size: "~67MB",
    icon: Monitor,
  },
  linux: {
    // Linux AppImage — single file, no install required
    url: `${GITHUB_RELEASE_BASE}/TalkingCharactersStudio-1.0.0.AppImage`,
    label: "Linux",
    size: "~100MB",
    icon: Monitor,
  },
  mac: {
    // macOS .dmg not built yet (requires macOS for code signing)
    url: "",
    label: "macOS",
    size: "قريبًا",
    icon: Apple,
  },
};

export default function InstallPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [lang, setLang] = useState<"ar" | "en">("ar");
  const [downloading, setDownloading] = useState<null | "windows" | "windowsZip" | "mac" | "linux">(null);
  const [ready, setReady] = useState(false);

  const isRTL = lang === "ar";
  const t = {
    title: lang === "ar" ? "تثبيت التطبيق" : "Install the App",
    subtitle:
      lang === "ar"
        ? "لازم تنزّل التطبيق على كمبيوترك الأول علشان تقدر تستخدمه. التطبيق بيحمّل Python وكل مكتبات الـ AI أوتوماتيك."
        : "You need to download the app to your computer first. The installer will automatically download Python and all AI libraries.",
    downloadWindows: lang === "ar" ? "تحميل لـ Windows" : "Download for Windows",
    downloadWindowsZip: lang === "ar" ? "Windows (ZIP) — موصى به" : "Windows (ZIP) — Recommended",
    downloadWindowsExe: lang === "ar" ? "Windows (.exe) — أصغر" : "Windows (.exe) — Smaller",
    downloadLinux: lang === "ar" ? "تحميل لـ Linux" : "Download for Linux",
    downloadMac: lang === "ar" ? "تحميل لـ macOS" : "Download for macOS",
    macComingSoon: lang === "ar" ? "قريبًا" : "Coming soon",
    smartScreen: {
      title: lang === "ar" ? "⚠️ تنبيه: Windows SmartScreen" : "⚠️ Windows SmartScreen warning",
      body:
        lang === "ar"
          ? "لما تشغّل الـ .exe لأول مرة، Windows هيظهر رسالة «protected your PC». ده طبيعي لأن التطبيق مش موقّع رقميًا (مش معروف لـ Microsoft لسه)."
          : "When you run the .exe for the first time, Windows shows a 'protected your PC' message. This is normal because the app is not digitally signed (unknown to Microsoft yet).",
      steps:
        lang === "ar"
          ? [
              "اضغط على «More info» (معلومات إضافية)",
              "هيظهر زرار «Run anyway» (تشغيل على أي حال)",
              "اضغط عليه — التطبيق هيشتغل عادي",
            ]
          : [
              "Click on 'More info'",
              "A 'Run anyway' button will appear",
              "Click it — the app will start normally",
            ],
      safe:
        lang === "ar"
          ? "التطبيق آمن — مفيش فيه فيروسات. المصدر: github.com/mohamedelnoss89/talking-characters-studio"
          : "The app is safe — no viruses. Source: github.com/mohamedelnoss89/talking-characters-studio",
    },
    apkComingSoon:
      lang === "ar"
        ? "نسخة أندرويد مش متاحة حاليًا."
        : "Android version is not available yet.",
    features: {
      title: lang === "ar" ? "ليه تنزّل التطبيق؟" : "Why download?",
      offline: lang === "ar" ? "شغّال أوفلاين" : "Works offline",
      offlineDesc:
        lang === "ar"
          ? "كل المعالجة بتحصل على جهازك — مفيش بيانات بتطلع بره"
          : "All processing happens on your machine — no data leaves your computer",
      fast: lang === "ar" ? "أسرع" : "Faster",
      fastDesc:
        lang === "ar"
          ? "بيستخدم GPU بتاعك مباشرة — أسرع من أي سيرفر سحابي"
          : "Uses your GPU directly — faster than any cloud server",
      native: lang === "ar" ? "تطبيق أصلي" : "Native app",
      nativeDesc:
        lang === "ar"
          ? "بيظهر كتطبيق مستقل، مش tab في المتصفح"
          : "Appears as a standalone app, not a browser tab",
    },
    steps: {
      title: lang === "ar" ? "إزاي تثبّت التطبيق" : "How to install",
      windows: lang === "ar" ? "على Windows" : "On Windows",
      mac: lang === "ar" ? "على macOS" : "On macOS",
    },
    required: lang === "ar" ? "التثبيت مطلوب" : "Installation required",
    requiredDesc:
      lang === "ar"
        ? "التطبيق محتاج يتثبّت على كمبيوترك علشان تشتغل عليه"
        : "The app must be installed on your computer to use it",
    systemReq:
      lang === "ar"
        ? "الحد الأدنى: Windows 10 / macOS 11، 8GB RAM، 5GB مساحة فاضية"
        : "Minimum: Windows 10 / macOS 11, 8GB RAM, 5GB free space",
    firstRunNote:
      lang === "ar"
        ? "أول تشغيل هيحمّل ~3GB من مكتبات الـ AI (Python + PyTorch + Wav2Lip)"
        : "First launch will download ~3GB of AI libraries (Python + PyTorch + Wav2Lip)",
  };

  // ---- EFFECT: detect if already installed (Electron = standalone + electronAPI) ----
  useEffect(() => {
    if (isStandaloneMode() && isElectron()) {
      router.replace("/login");
      return;
    }
    clearBypassFlag();
    setReady(true);
  }, [router]);

  const handleDownload = (platform: "windows" | "windowsZip" | "mac" | "linux") => {
    const info = DOWNLOADS[platform];
    if (!info.url) {
      toast({
        title: lang === "ar" ? "قريبًا" : "Coming soon",
        description:
          lang === "ar"
            ? "نسخة macOS لسه بتجهّز. استخدم Windows أو Linux حاليًا."
            : "macOS version is coming. Please use Windows or Linux for now.",
      });
      return;
    }
    setDownloading(platform);
    // Use a hidden <a download> so the browser treats it as a file download,
    // not a navigation. This avoids the GitHub 404 problem entirely.
    const a = document.createElement("a");
    a.href = info.url;
    a.download = info.url.split("/").pop() || "installer";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => setDownloading(null), 2000);
    toast({
      title: lang === "ar" ? "بدأ التحميل" : "Download started",
      description: `${info.label} • ${info.size}`,
    });
  };

  if (!ready) return null;

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

      <main className="flex-1 flex items-center justify-center p-4 py-8">
        <div className="w-full max-w-2xl">
          {/* Required banner */}
          <div className="mb-6 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 flex items-center gap-3 justify-center">
            <Lock className="w-4 h-4 shrink-0" />
            <span className="text-sm font-medium text-center">{t.requiredDesc}</span>
          </div>

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

          {/* Main download buttons */}
          <div className="grid sm:grid-cols-2 gap-4 mb-6">
            {/* Windows ZIP — RECOMMENDED (doesn't trigger SmartScreen on download) */}
            <button
              type="button"
              onClick={() => handleDownload("windowsZip")}
              disabled={downloading !== null}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 p-6 text-white shadow-xl shadow-purple-500/30 transition-all hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100 text-center ring-2 ring-purple-400/50"
            >
              <div className="absolute top-2 end-2 px-2 py-0.5 rounded-full bg-emerald-500/90 text-white text-[10px] font-bold uppercase tracking-wide">
                {lang === "ar" ? "موصى به" : "Recommended"}
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center">
                  {downloading === "windowsZip" ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <Monitor className="w-7 h-7" />
                  )}
                </div>
                <div>
                  <p className="font-bold text-lg">{t.downloadWindowsZip}</p>
                  <p className="text-xs text-white/70 mt-1">
                    {DOWNLOADS.windowsZip.size} · .zip
                  </p>
                </div>
              </div>
            </button>

            {/* Linux */}
            <button
              type="button"
              onClick={() => handleDownload("linux")}
              disabled={downloading !== null}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 p-6 text-white shadow-xl shadow-amber-500/30 transition-all hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100 text-center"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center">
                  {downloading === "linux" ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <Monitor className="w-7 h-7" />
                  )}
                </div>
                <div>
                  <p className="font-bold text-lg">{t.downloadLinux}</p>
                  <p className="text-xs text-white/70 mt-1">
                    {DOWNLOADS.linux.size} · AppImage
                  </p>
                </div>
              </div>
            </button>

            {/* Windows .exe — smaller but triggers SmartScreen */}
            <button
              type="button"
              onClick={() => handleDownload("windows")}
              disabled={downloading !== null}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-700 to-slate-800 hover:from-slate-600 hover:to-slate-700 p-6 text-white shadow-xl shadow-slate-500/20 transition-all hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100 text-center"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center">
                  {downloading === "windows" ? (
                    <Loader2 className="w-7 h-7 animate-spin" />
                  ) : (
                    <Monitor className="w-7 h-7" />
                  )}
                </div>
                <div>
                  <p className="font-bold text-lg">{t.downloadWindowsExe}</p>
                  <p className="text-xs text-white/70 mt-1">
                    {DOWNLOADS.windows.size} · .exe
                  </p>
                </div>
              </div>
            </button>

            {/* macOS — disabled, coming soon */}
            <button
              type="button"
              onClick={() => handleDownload("mac")}
              disabled={true}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-700/50 to-teal-700/50 hover:from-emerald-700 hover:to-teal-700 p-6 text-white/70 shadow-xl shadow-emerald-500/10 transition-all hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed text-center"
            >
              <div className="flex flex-col items-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center">
                  <Apple className="w-7 h-7" />
                </div>
                <div>
                  <p className="font-bold text-lg">{t.downloadMac}</p>
                  <p className="text-xs text-white/40 mt-1">
                    {t.macComingSoon}
                  </p>
                </div>
              </div>
            </button>
          </div>

          {/* SmartScreen warning — prominent yellow box */}
          <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500/50">
            <div className="flex items-start gap-3 mb-3">
              <Shield className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-amber-200 text-sm mb-1">{t.smartScreen.title}</p>
                <p className="text-xs text-amber-100/80 leading-relaxed">{t.smartScreen.body}</p>
              </div>
            </div>
            <ol className="text-xs text-amber-100/90 space-y-1 mt-3 ms-8 list-decimal">
              {t.smartScreen.steps.map((step, i) => (
                <li key={i} className="leading-relaxed">{step}</li>
              ))}
            </ol>
            <div className="mt-3 pt-3 border-t border-amber-500/20">
              <p className="text-[11px] text-amber-200/60 text-center">{t.smartScreen.safe}</p>
            </div>
          </div>

          {/* System requirements */}
          <div className="mb-6 p-3 rounded-lg bg-black/30 border border-white/5 text-center">
            <p className="text-xs text-gray-400">{t.systemReq}</p>
            <p className="text-xs text-amber-300/80 mt-1">{t.firstRunNote}</p>
          </div>

          {/* Features section */}
          <div className="mb-6">
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
                  <Monitor className="w-5 h-5 text-emerald-300" />
                </div>
                <p className="font-medium text-gray-200 text-sm">{t.features.native}</p>
                <p className="text-xs text-gray-500 mt-1">{t.features.nativeDesc}</p>
              </div>
            </div>
          </div>

          {/* Step-by-step instructions */}
          <div className="mb-6 p-5 rounded-xl bg-black/30 border border-purple-500/20">
            <h2 className="text-base font-semibold text-gray-200 mb-4 flex items-center gap-2">
              <Info className="w-4 h-4 text-purple-400" />
              {t.steps.title}
            </h2>
            <div className="space-y-4 text-sm">
              <div>
                <p className="font-medium text-purple-300 mb-1">{t.steps.windows}</p>
                <p className="text-gray-400">
                  {lang === "ar"
                    ? "1. حمّل ملف ZIP وفك ضغطه. 2. ادخل على المجلد اللي طلع وافتح ملف «محرك الشخصيات المتكلمة.exe». 3. لو ظهر رسالة SmartScreen → اضغط «More info» → «Run anyway» (شوف التنبيه فوق). 4. أول تشغيل هيفتح شاشة تثبيت Python والمكتبات أوتوماتيك — استنى 10-15 دقيقة."
                    : "1. Download the ZIP and extract it. 2. Open the extracted folder and run 'محرك الشخصيات المتكلمة.exe'. 3. If SmartScreen appears → click 'More info' → 'Run anyway' (see warning above). 4. First launch opens an installer screen that downloads Python + libraries automatically — wait 10-15 minutes."}
                </p>
              </div>
              <div>
                <p className="font-medium text-purple-300 mb-1">{lang === "ar" ? "على Linux" : "On Linux"}</p>
                <p className="text-gray-400">
                  {lang === "ar"
                    ? "1. حمّل ملف .AppImage. 2. اضغط عليه كليك يمين → Properties → Permissions → فعّل «السماح بالتنفيذ كبرنامج». 3. افتحه — شاشة التثبيت هتفتح أوتوماتيك."
                    : "1. Download the .AppImage. 2. Right-click → Properties → Permissions → enable 'Allow executing as program'. 3. Open it — the installer screen starts automatically."}
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
