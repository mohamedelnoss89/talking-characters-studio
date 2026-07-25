"use client";

/**
 * UpdateBanner — shows an "Update available" banner at the top of the PWA
 * when the Electron desktop app detects a new version on GitHub Releases.
 *
 * Subscribes to window.updater events (set up by desktop/src/preload.js).
 * States:
 *   - idle (no update / not in desktop app) → renders nothing
 *   - available → "Update available vX.Y.Z [Download & Install] [🔄 إعادة الفحص]"
 *   - checking → "جاري إعادة الفحص..." (spinner, brief state during manual re-check)
 *   - downloading → "Downloading... NN% (X MB / Y MB, V MB/s, ETA M:SS)"
 *                    + progress bar + "Open in browser" link for slow networks
 *   - downloaded → "Ready to install [Restart & Install]"
 *   - error → "خطأ في التحديث" with friendly Arabic explanation + Retry
 *
 * Auto re-check (v1.1.15+):
 *   The backend updater now re-checks GitHub Releases every 30 minutes
 *   automatically. If a newer version was published while the app was
 *   open, the banner will refresh itself to show the newer version. This
 *   fixes the bug where the banner would show a stale version (e.g.
 *   "v1.1.11") for hours even after v1.1.14 had been released.
 *
 * Manual re-check (v1.1.15+):
 *   The "إعادة الفحص" button lets the user manually trigger a fresh
 *   check without restarting the app. Useful when the user knows a
 *   newer version is out but the 30-minute periodic check hasn't fired
 *   yet. Shows a brief "جاري إعادة الفحص..." state, then either:
 *     - Updates the banner to the newer version (if found)
 *     - Shows "أنت على أحدث إصدار — vX.Y.Z" toast (if no newer version)
 *     - Shows error toast (if the check failed)
 *
 * Slow-network handling (v1.1.13+):
 *   The 94MB Setup.exe download from GitHub can be very slow on flaky
 *   connections (common in Egypt). We now display:
 *     - Downloaded MB / Total MB
 *     - Download speed (MB/s)
 *     - ETA (minutes:seconds remaining)
 *
 * In a regular browser (not Electron), window.updater is undefined, so this
 * component renders nothing.
 */

import { useEffect, useState } from "react";
import { Download, RefreshCw, X, CheckCircle2, Loader2, AlertCircle, RotateCw } from "lucide-react";

type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "checking"; previousVersion?: string }
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
 * Brief toast notification shown after a manual re-check completes.
 * Used to confirm "you're already on the latest" or "newer version detected".
 */
type Toast =
  | { kind: "already-latest"; version: string }
  | { kind: "newer-found"; oldVersion: string; newVersion: string }
  | { kind: "check-error"; message: string }
  | null;

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
      hint: "التحميل بطيء جدًا. حاول على شِبكة أسرع أو أعد المحاولة.",
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
  const [toast, setToast] = useState<Toast>(null);
  // Tracks whether the user manually clicked "re-check" — if so, when the
  // next `not-available` event arrives, we show an "already on latest" toast
  // instead of just collapsing the banner silently.
  const [manualRecheckPending, setManualRecheckPending] = useState(false);

  // Auto-dismiss toast after 4 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const updater = (typeof window !== "undefined" && (window as any).updater) || null;
    if (!updater) return; // not in Electron

    let mounted = true;

    // Subscribe to events
    const unsub = updater.subscribe((evt: any) => {
      if (!mounted) return;
      switch (evt.event) {
        case "checking":
          // If the banner is currently showing an available update, switch
          // to the "checking" state so the user sees feedback. If the banner
          // is idle (e.g. periodic check while no update is shown), do
          // nothing — don't pop the banner up just to show a spinner.
          setState((prev) =>
            prev.kind === "available"
              ? { kind: "checking", previousVersion: prev.version }
              : prev
          );
          break;
        case "available":
          setState((prev) => {
            const newVersion = evt.version || "?";
            // If this is a refresh (auto/manual re-check found a different
            // version than what was previously shown), show a toast.
            if (evt.isRefresh && evt.previousVersion && evt.previousVersion !== newVersion) {
              setToast({
                kind: "newer-found",
                oldVersion: evt.previousVersion,
                newVersion,
              });
            }
            // If we were in "checking" state (manual re-check), clear the
            // manualRecheckPending flag — we found an update.
            if (manualRecheckPending) setManualRecheckPending(false);
            return { kind: "available", version: newVersion };
          });
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
          // If the error happened during a manual re-check, show a toast
          // instead of replacing the whole banner (so the user can still
          // see the previously-detected version + download button).
          if (manualRecheckPending) {
            setManualRecheckPending(false);
            // Restore the previously-available version if we know it
            setState((prev) =>
              prev.kind === "checking" && prev.previousVersion
                ? { kind: "available", version: prev.previousVersion }
                : prev.kind === "error"
                  ? prev
                  : { kind: "error", message: evt.error || "Unknown error" }
            );
            setToast({ kind: "check-error", message: evt.error || "Unknown error" });
          } else {
            setState({
              kind: "error",
              message: evt.error || "Unknown error",
              attemptsExhausted: evt.attemptsExhausted,
            });
          }
          break;
        case "not-available":
          // Two cases:
          //  (a) User manually clicked "re-check" while in "available" state
          //      → show toast "you're on the latest" but keep the banner
          //      showing the existing version (it's still pending install).
          //  (b) Periodic auto-check found no update while banner is idle
          //      → do nothing.
          if (manualRecheckPending) {
            setManualRecheckPending(false);
            const currentVersion = evt.currentVersion || "?";
            setToast({ kind: "already-latest", version: currentVersion });
            // Restore to available state if we were checking
            setState((prev) =>
              prev.kind === "checking" && prev.previousVersion
                ? { kind: "available", version: prev.previousVersion }
                : { kind: "idle" }
            );
          } else {
            setState({ kind: "idle" });
          }
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
  }, [manualRecheckPending]);

  if (state.kind === "idle" || dismissed) {
    // Still render the toast if there is one (e.g. "already on latest")
    return toast ? <ToastView toast={toast} onDismiss={() => setToast(null)} /> : null;
  }

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

  /**
   * Manual re-check: force a fresh check against GitHub Releases.
   * Useful when a newer release was published while the app was open
   * (e.g. user sees "v1.1.11" but v1.1.14 has just been released).
   */
  const handleRecheck = async () => {
    const updater = (window as any).updater;
    if (!updater) return;
    setWorking(true);
    setManualRecheckPending(true);
    // Optimistically switch to "checking" state — the `checking` event
    // from the backend will also do this, but we want immediate feedback.
    setState((prev) =>
      prev.kind === "available"
        ? { kind: "checking", previousVersion: prev.version }
        : prev
    );
    try {
      const res = await updater.forceCheck();
      if (res?.skipped) {
        // Check was skipped (already-checking or too-recent) — restore
        // previous state and show a soft toast.
        setState((prev) =>
          prev.kind === "checking" && prev.previousVersion
            ? { kind: "available", version: prev.previousVersion }
            : prev
        );
        setManualRecheckPending(false);
        // If we already have update info, no toast needed — just restore.
        // If we don't, show a brief "already on latest" toast.
        if (!res?.updateInfo?.version) {
          setToast({ kind: "already-latest", version: res?.updateInfo?.version || "?" });
        }
      } else if (!res?.success) {
        // Error — restore previous state and show error toast.
        setState((prev) =>
          prev.kind === "checking" && prev.previousVersion
            ? { kind: "available", version: prev.previousVersion }
            : { kind: "error", message: res?.error || "Check failed" }
        );
        setToast({ kind: "check-error", message: res?.error || "Check failed" });
        setManualRecheckPending(false);
      }
      // Note: on success, the `available` or `not-available` event will fire
      // separately via the subscription handler — we don't need to do
      // anything here. The handler will clear manualRecheckPending.
    } catch (e: any) {
      setState((prev) =>
        prev.kind === "checking" && prev.previousVersion
          ? { kind: "available", version: prev.previousVersion }
          : { kind: "error", message: e?.message || String(e) }
      );
      setToast({ kind: "check-error", message: e?.message || String(e) });
      setManualRecheckPending(false);
    } finally {
      setWorking(false);
    }
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
          ) : state.kind === "checking" ? (
            <RotateCw className="w-5 h-5 animate-spin" />
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
          {state.kind === "checking" && (
            <div>
              <p className="text-sm font-semibold">
                جاري إعادة الفحص على GitHub...
              </p>
              <p className="text-xs text-white/80">
                {state.previousVersion
                  ? `النسخة الحالية المعروضة: v${state.previousVersion}`
                  : "Re-checking GitHub Releases for a newer version"}
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
                  لو التحميل بطيء جدًا، اضغط إعادة المحاولة بعد شوية.
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
                onClick={handleRecheck}
                disabled={working}
                title="إعادة الفحص على GitHub علشان نكتشف أحدث إصدار"
                className="px-2.5 py-1.5 rounded-lg bg-white/15 text-white text-sm font-semibold hover:bg-white/25 transition flex items-center gap-1 disabled:opacity-50"
              >
                <RotateCw className={`w-3.5 h-3.5 ${working ? "animate-spin" : ""}`} />
                إعادة الفحص
              </button>
            </>
          )}
          {state.kind === "downloading" && null}
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

      {/* Toast — small notification shown after a manual re-check completes */}
      {toast && (
        <div className="mt-2 mx-auto max-w-4xl pointer-events-auto">
          <ToastView toast={toast} onDismiss={() => setToast(null)} />
        </div>
      )}
    </div>
  );
}

/**
 * Small toast notification shown after a manual re-check completes.
 * Three variants:
 *   - already-latest  → "أنت على أحدث إصدار — vX.Y.Z" (green)
 *   - newer-found     → "تم اكتشاف إصدار أحدث — vX → vY" (blue/green)
 *   - check-error     → "فشل إعادة الفحص" (red)
 */
function ToastView({ toast, onDismiss }: { toast: NonNullable<Toast>; onDismiss: () => void }) {
  let bg = "bg-green-600/95 border-green-400/30";
  let icon = <CheckCircle2 className="w-4 h-4 text-white" />;
  let title = "";
  let subtitle = "";

  if (toast.kind === "already-latest") {
    bg = "bg-green-600/95 border-green-400/30";
    icon = <CheckCircle2 className="w-4 h-4" />;
    title = "أنت على أحدث إصدار";
    subtitle = `الإصدار الحالي v${toast.version} هو الأحدث على GitHub`;
  } else if (toast.kind === "newer-found") {
    bg = "bg-blue-600/95 border-blue-400/30";
    icon = <RotateCw className="w-4 h-4" />;
    title = `تم اكتشاف إصدار أحدث — v${toast.newVersion}`;
    subtitle = `كان المعروض v${toast.oldVersion}، تم تحديث الـ banner`;
  } else if (toast.kind === "check-error") {
    bg = "bg-red-600/95 border-red-400/30";
    icon = <AlertCircle className="w-4 h-4" />;
    title = "فشل إعادة الفحص";
    subtitle = toast.message;
  }

  return (
    <div className={`pointer-events-auto rounded-lg ${bg} backdrop-blur border px-3 py-2 flex items-center gap-2 text-white shadow-lg`}>
      <div className="flex-shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold">{title}</p>
        {subtitle && (
          <p className="text-[11px] text-white/80 truncate" dir={toast.kind === "check-error" ? "ltr" : "rtl"}>
            {subtitle}
          </p>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="p-1 rounded hover:bg-white/20 transition text-white/80 flex-shrink-0"
        aria-label="Dismiss"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
