"use client";

/**
 * UpdateBanner — shows an "Update available" banner at the top of the PWA
 * when the Electron desktop app detects a new version on GitHub Releases.
 *
 * Subscribes to window.updater events (set up by desktop/src/preload.js).
 * States:
 *   - idle (no update / not in desktop app) → renders nothing
 *   - available → "Update available vX.Y.Z [Download & Install]"
 *   - downloading → "Downloading... NN% (attempt K/3)" with progress bar
 *   - downloaded → "Ready to install [Restart & Install]"
 *   - error → "خطأ في التحديث" with friendly Arabic explanation + Retry
 *
 * Retry behaviour (v1.1.12+):
 *   The Retry button calls window.updater.retry() which force-rechecks
 *   GitHub and re-attempts the download with auto-retry (up to 3 attempts
 *   with 5s backoff). The previous version called only check() which
 *   returned cached info and never retried the download — so the user
 *   was stuck on the error screen with no way to recover.
 *
 * In a regular browser (not Electron), window.updater is undefined, so this
 * component renders nothing.
 */

import { useEffect, useState } from "react";
import { Download, RefreshCw, X, CheckCircle2, Loader2, AlertCircle } from "lucide-react";

type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number; attempt?: number; maxAttempts?: number; retryingIn?: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string; attemptsExhausted?: boolean };

/**
 * Translate common electron-updater / Chromium network errors to friendly
 * Arabic messages so the user knows what's going on and what to do.
 *
 * Common errors we see:
 *   - "net::ERR_FAILED"           — connection dropped mid-download
 *   - "net::ERR_INTERNET_DISCONNECTED" — user's internet went out
 *   - "net::ERR_CONNECTION_RESET"  — server/GFW reset the connection
 *   - "net::ERR_CONNECTION_REFUSED" — firewall/AV blocking the connection
 *   - "HTTP 4xx"                   — GitHub returned an error (rare)
 *   - "HTTP 5xx"                   — GitHub server error (retry helps)
 *   - "ETIMEDOUT" / "ESOCKETTIMEDOUT" — connection hung
 *   - "ECONNRESET"                 — TCP reset
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
      hint: "التحميل بطيء جدًا. حاول على شِبكة أسرع أو وقّف الـ VPN.",
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
  // Generic fallback
  return {
    short: "فشل التحديث",
    hint: raw || "خطأ غير معروف. اضغط إعادة المحاولة.",
  };
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
          setState({
            kind: "downloading",
            percent: evt.percent || 0,
            attempt: evt.attempt,
            maxAttempts: evt.maxAttempts,
            retryingIn: evt.retryingIn,
          });
          break;
        case "retry":
          // Update the downloading state to show retry attempt
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
      // The app will quit + relaunch — this code may not run.
    } catch (e: any) {
      setState({ kind: "error", message: e?.message || String(e) });
      setWorking(false);
    }
  };

  /**
   * Retry button click — calls the new window.updater.retry() IPC which
   * force-rechecks GitHub + re-attempts the download with auto-retry.
   *
   * Previously this called updater.check() which returned cached info and
   * never retried the download — the user was stuck on the error screen.
   */
  const handleRetry = async () => {
    const updater = (window as any).updater;
    if (!updater) return;
    setWorking(true);
    // Optimistically switch to "downloading" so the user sees immediate feedback
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
        // No update available anymore (e.g. user already on latest)
        setState({ kind: "idle" });
      }
      // Otherwise the `downloaded` or `error` event from the IPC will
      // transition us to the correct state.
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

  // Don't render the banner in a regular browser (no window.updater)
  if (typeof window !== "undefined" && !(window as any).updater) return null;

  // Compute the friendly Arabic error translation for the error state
  const errorInfo =
    state.kind === "error" ? translateError(state.message) : null;

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
                Update available — click to download and install
              </p>
            </div>
          )}
          {state.kind === "downloading" && (
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
              <p className="text-[11px] text-white/60 mt-1">
                ~94MB من GitHub — سيكمّل من حيث ما وقف لو النت قطع
              </p>
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
                  اتجرّبت 3 مرات. لو المشكلة فضلت، حمّل التحديث يدويًا من GitHub Releases.
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
            <button
              onClick={handleDownload}
              disabled={working}
              className="px-3 py-1.5 rounded-lg bg-white text-purple-700 text-sm font-semibold hover:bg-white/90 transition disabled:opacity-50"
            >
              {working ? "..." : "تنزيل وتثبيت"}
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
            <button
              onClick={handleRetry}
              disabled={working}
              className="px-3 py-1.5 rounded-lg bg-white text-purple-700 text-sm font-semibold hover:bg-white/90 transition disabled:opacity-50 flex items-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${working ? "animate-spin" : ""}`} />
              {working ? "..." : "إعادة المحاولة"}
            </button>
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
