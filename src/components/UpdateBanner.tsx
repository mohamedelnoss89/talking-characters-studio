"use client";

/**
 * UpdateBanner — shows an "Update available" banner at the top of the PWA
 * when the Electron desktop app detects a new version on GitHub Releases.
 *
 * Subscribes to window.updater events (set up by desktop/src/preload.js).
 * States:
 *   - idle (no update / not in desktop app) → renders nothing
 *   - available → "Update available vX.Y.Z [Download & Install]"
 *   - downloading → "Downloading... NN% (X MB / Y MB, V MB/s, ETA M:SS)"
 *                    + progress bar + "Open in browser" link for slow networks
 *   - downloaded → "Ready to install [Restart & Install]"
 *   - error → "خطأ في التحديث" with friendly Arabic explanation + Retry
 *
 * Slow-network handling (v1.1.13+):
 *   The 94MB Setup.exe download from GitHub can be very slow on flaky
 *   connections (common in Egypt). We now display:
 *     - Downloaded MB / Total MB
 *     - Download speed (MB/s)
 *     - ETA (minutes:seconds remaining)
 *   Plus a "فتح في المتصفح" button that opens GitHub Releases in the
 *   user's default browser — browsers + download managers handle flaky
 *   networks better than electron-updater's single-stream download.
 *
 * In a regular browser (not Electron), window.updater is undefined, so this
 * component renders nothing.
 */

import { useEffect, useState } from "react";
import { Download, RefreshCw, X, CheckCircle2, Loader2, AlertCircle, ExternalLink } from "lucide-react";

type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | {
      kind: "downloading";
      percent: number;
      attempt?: number;
      maxAttempts?: number;
      retryingIn?: number;
      transferred?: number;   // bytes
      total?: number;         // bytes
      bytesPerSecond?: number; // bytes/sec
    }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string; attemptsExhausted?: boolean };

/**
 * Translate common electron-updater / Chromium network errors to friendly
 * Arabic messages so the user knows what's going on and what to do.
 */
function translateError(raw: string): { short: string; hint: string } {
  const m = (raw || "").toLowerCase();
  if (m.includes("err_internet_disconnected") || m.includes("enetunreach")) {
    return {
      short: "الإنترنت مقطوع",
      hint: "تأكد إن النت شغّال وحاول تاني.",
    };
  }
  if (m.includes("err_connection_refused") || m.includes("econnrefused")) {
    return {
      short: "الاتصال اترفض",
      hint: "غالباً AntiVirus أو Firewall بيحجب الاتصال بـ GitHub. وقّفه مؤقتاً وحاول تاني.",
    };
  }
  if (m.includes("err_connection_reset") || m.includes("econnreset")) {
    return {
      short: "الاتصال اتقطع",
      hint: "النت اتقطع أثناء تحميل التحديث (~94MB). هحاول تاني أوتوماتيك.",
    };
  }
  if (m.includes("err_failed")) {
    return {
      short: "فشل تحميل التحديث",
      hint: "النت اتقطع أثناء التحميل (~94MB من GitHub). اضغط إعادة المحاولة — هيكمّل من حيث ما وقف.",
    };
  }
  if (m.includes("timed out") || m.includes("etimedout") || m.includes("esockettimedout")) {
    return {
      short: "انتهت مهلة الاتصال",
      hint: "التحميل بطيء جدًا. حاول على شِبكة أسرع أو استخدم زرار 'فتح في المتصفح'.",
    };
  }
  if (m.includes("http 5") || m.includes("server error") || m.includes("service unavailable")) {
    return {
      short: "خطأ من GitHub",
      hint: "GitHub سيرفراتها مش متاحة دلوقتي. حاول بعد دقيقة.",
    };
  }
  if (m.includes("http 4") || m.includes("rate limit") || m.includes("403") || m.includes("429")) {
    return {
      short: "GitHub رفضت الطلب",
      hint: "غالباً Rate Limit. استنى دقيقة وحاول تاني.",
    };
  }
  return {
    short: "فشل التحديث",
    hint: raw || "خطأ غير معروف. اضغط إعادة المحاولة.",
  };
}

/** Format bytes as MB or GB with 1 decimal place. */
function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/** Format bytes/sec as MB/s or KB/s. */
function formatSpeed(bps?: number): string {
  if (!bps || bps <= 0) return "—";
  if (bps < 1024) return bps.toFixed(0) + " B/s";
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(0) + " KB/s";
  return (bps / 1024 / 1024).toFixed(2) + " MB/s";
}

/** Format ETA in seconds as "M:SS" or "—". */
function formatETA(transferred?: number, total?: number, bps?: number): string {
  if (!transferred || !total || !bps || bps <= 0) return "—";
  const remainingBytes = total - transferred;
  if (remainingBytes <= 0) return "0:00";
  const remainingSec = Math.ceil(remainingBytes / bps);
  const m = Math.floor(remainingSec / 60);
  const s = remainingSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const updater = (typeof window !== "undefined" && (window as any).updater) || null;
    if (!updater) return; // not in Electron

    let mounted = true;

    // Subscribe to events
    const unsub = updater.subscribe((evt: any) => {
      if (!mounted) return;
      switch (evt.event) {
        case "available":
          setState({ kind: "available", version: evt.version || "?" });
          setDismissed(false);
          break;
        case "progress":
          setState((prev) => ({
            kind: "downloading",
            percent: evt.percent || 0,
            attempt: evt.attempt ?? (prev.kind === "downloading" ? prev.attempt : undefined),
            maxAttempts: evt.maxAttempts ?? (prev.kind === "downloading" ? prev.maxAttempts : undefined),
            retryingIn: evt.retryingIn,
            transferred: evt.transferred,
            total: evt.total,
            bytesPerSecond: evt.bytesPerSecond,
          }));
          break;
        case "retry":
          setState((prev) =>
            prev.kind === "downloading"
              ? { ...prev, attempt: evt.attempt, maxAttempts: evt.maxAttempts }
              : {
                  kind: "downloading",
                  percent: 0,
                  attempt: evt.attempt,
                  maxAttempts: evt.maxAttempts,
                }
          );
          break;
        case "downloaded":
          setState({ kind: "downloaded", version: evt.version || "?" });
          setDismissed(false);
          break;
        case "error":
          setState({
            kind: "error",
            message: evt.error || "Unknown error",
            attemptsExhausted: evt.attemptsExhausted,
          });
          break;
        case "not-available":
          setState({ kind: "idle" });
          break;
      }
    });

    // On mount, also poll once for any cached update info (covers the case
    // where the user opened the app and the background check already fired).
    updater
      .status()
      .then((s: any) => {
        if (!mounted) return;
        if (s?.downloadedVersion) {
          setState({ kind: "downloaded", version: s.downloadedVersion });
        } else if (s?.isDownloading) {
          setState({
            kind: "downloading",
            percent: s.downloadPercent || 0,
            attempt: s.downloadAttempts,
            maxAttempts: 3,
          });
        } else if (s?.updateInfo?.version) {
          setState({ kind: "available", version: s.updateInfo.version });
        } else if (s?.lastError) {
          setState({ kind: "error", message: s.lastError });
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
      try { unsub && unsub(); } catch {}
    };
  }, []);

  if (state.kind === "idle" || dismissed) return null;

  const handleDownload = async () => {
    const updater = (window as any).updater;
    if (!updater) return;
    setWorking(true);
    try {
      const res = await updater.download();
      if (!res?.success) {
        setState({ kind: "error", message: res?.error || "Download failed" });
      }
    } catch (e: any) {
      setState({ kind: "error", message: e?.message || String(e) });
    } finally {
      setWorking(false);
    }
  };

  const handleInstall = async () => {
    const updater = (window as any).updater;
    if (!updater) return;
    setWorking(true);
    try {
      await updater.install();
    } catch (e: any) {
      setState({ kind: "error", message: e?.message || String(e) });
      setWorking(false);
    }
  };

  const handleRetry = async () => {
    const updater = (window as any).updater;
    if (!updater) return;
    setWorking(true);
    setState({ kind: "downloading", percent: 0, attempt: 1, maxAttempts: 3 });
    try {
      const res = await updater.retry();
      if (!res?.success) {
        setState({
          kind: "error",
          message: res?.error || "Retry failed",
          attemptsExhausted: true,
        });
      } else if (res?.noUpdate) {
        setState({ kind: "idle" });
      }
    } catch (e: any) {
      setState({
        kind: "error",
        message: e?.message || String(e),
        attemptsExhausted: true,
      });
    } finally {
      setWorking(false);
    }
  };

  /** Open GitHub Releases in the user's default browser. */
  const handleOpenInBrowser = async () => {
    const updater = (window as any).updater;
    if (!updater) {
      // Fallback: open directly if no Electron bridge
      if (typeof window !== "undefined") {
        window.open("https://github.com/mohamedelnoss89/talking-characters-studio/releases/latest", "_blank");
      }
      return;
    }
    try {
      await updater.openInBrowser();
    } catch {}
  };

  if (typeof window !== "undefined" && !(window as any).updater) return null;

  const errorInfo =
    state.kind === "error" ? translateError(state.message) : null;

  // Compute download info strings
  const dlInfo =
    state.kind === "downloading"
      ? {
          downloaded: formatBytes(state.transferred),
          total: formatBytes(state.total),
          speed: formatSpeed(state.bytesPerSecond),
          eta: formatETA(state.transferred, state.total, state.bytesPerSecond),
        }
      : null;

  return (
    <div className="fixed top-0 inset-x-0 z-50 px-4 pt-2 pointer-events-none">
      <div className="mx-auto max-w-4xl pointer-events-auto rounded-xl bg-gradient-to-r from-purple-600/95 to-pink-600/95 backdrop-blur border border-white/20 shadow-2xl px-4 py-3 flex items-center gap-3 text-white">
        <div className="flex-shrink-0">
          {state.kind === "downloading" ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : state.kind === "downloaded" ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : state.kind === "error" ? (
            <AlertCircle className="w-5 h-5" />
          ) : (
            <Download className="w-5 h-5" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          {state.kind === "available" && (
            <div>
              <p className="text-sm font-semibold">
                تحديث متاح — v{state.version}
              </p>
              <p className="text-xs text-white/80">
                Update available — click to download (~94MB)
              </p>
            </div>
          )}
          {state.kind === "downloading" && dlInfo && (
            <div>
              <p className="text-sm font-semibold">
                تحميل التحديث... {state.percent}%
                {state.attempt && state.maxAttempts && state.attempt > 1 && (
                  <span className="text-xs text-white/70 ml-2">
                    (محاولة {state.attempt}/{state.maxAttempts})
                  </span>
                )}
                {state.retryingIn && (
                  <span className="text-xs text-white/70 ml-2">
                    — إعادة المحاولة بعد {state.retryingIn}s
                  </span>
                )}
              </p>
              <div className="mt-1 h-1.5 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white rounded-full transition-all"
                  style={{ width: `${state.percent}%` }}
                />
              </div>
              <p className="text-[11px] text-white/70 mt-1" dir="ltr">
                {dlInfo.downloaded} / {dlInfo.total}
                {"  ·  "}
                {dlInfo.speed}
                {"  ·  "}
                ETA: {dlInfo.eta}
              </p>
              {state.percent > 0 && state.percent < 100 && (
                <p className="text-[11px] text-white/60 mt-0.5">
                  لو التحميل بطيء جدًا، استخدم زرار "فتح في المتصفح" على اليمين
                </p>
              )}
            </div>
          )}
          {state.kind === "downloaded" && (
            <div>
              <p className="text-sm font-semibold">
                التحديث جاهز — v{state.version}
              </p>
              <p className="text-xs text-white/80">
                Update ready — restart to install
              </p>
            </div>
          )}
          {state.kind === "error" && errorInfo && (
            <div>
              <p className="text-sm font-semibold">خطأ في التحديث — {errorInfo.short}</p>
              <p className="text-xs text-white/80">{errorInfo.hint}</p>
              {state.attemptsExhausted && (
                <p className="text-[11px] text-white/60 mt-1">
                  اتجرّبت 3 مرات. حمّل التحديث يدويًا من GitHub Releases.
                </p>
              )}
              {state.message && !state.attemptsExhausted && (
                <p className="text-[11px] text-white/50 mt-1 truncate font-mono" dir="ltr">
                  {state.message}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {state.kind === "available" && (
            <>
              <button
                onClick={handleDownload}
                disabled={working}
                className="px-3 py-1.5 rounded-lg bg-white text-purple-700 text-sm font-semibold hover:bg-white/90 transition disabled:opacity-50"
              >
                {working ? "..." : "تنزيل وتثبيت"}
              </button>
              <button
                onClick={handleOpenInBrowser}
                title="فتح GitHub Releases في المتصفح"
                className="px-2.5 py-1.5 rounded-lg bg-white/15 text-white text-sm font-semibold hover:bg-white/25 transition flex items-center gap-1"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                المتصفح
              </button>
            </>
          )}
          {state.kind === "downloading" && (
            <button
              onClick={handleOpenInBrowser}
              title="فتح GitHub Releases في المتصفح علشان تحميل أسرع"
              className="px-2.5 py-1.5 rounded-lg bg-white/15 text-white text-sm font-semibold hover:bg-white/25 transition flex items-center gap-1"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              فتح في المتصفح
            </button>
          )}
          {state.kind === "downloaded" && (
            <button
              onClick={handleInstall}
              disabled={working}
              className="px-3 py-1.5 rounded-lg bg-white text-purple-700 text-sm font-semibold hover:bg-white/90 transition disabled:opacity-50 flex items-center gap-1"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {working ? "..." : "إعادة التشغيل والتثبيت"}
            </button>
          )}
          {state.kind === "error" && (
            <>
              <button
                onClick={handleRetry}
                disabled={working}
                className="px-3 py-1.5 rounded-lg bg-white text-purple-700 text-sm font-semibold hover:bg-white/90 transition disabled:opacity-50 flex items-center gap-1"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${working ? "animate-spin" : ""}`} />
                {working ? "..." : "إعادة المحاولة"}
              </button>
              <button
                onClick={handleOpenInBrowser}
                title="فتح GitHub Releases في المتصفح"
                className="px-2.5 py-1.5 rounded-lg bg-white/15 text-white text-sm font-semibold hover:bg-white/25 transition flex items-center gap-1"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                المتصفح
              </button>
            </>
          )}
          <button
            onClick={() => setDismissed(true)}
            className="p-1.5 rounded-lg hover:bg-white/20 transition text-white/80"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
