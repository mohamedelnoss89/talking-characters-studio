"use client";

/**
 * UpdateBanner — shows an "Update available" banner at the top of the PWA
 * when the Electron desktop app detects a new version on GitHub Releases.
 *
 * Subscribes to window.updater events (set up by desktop/src/preload.js).
 * Has 3 states:
 *   - default (no update / not in desktop app) → renders nothing
 *   - available → "Update available vX.Y.Z [Download & Install]"
 *   - downloading → "Downloading... NN%" with progress bar
 *   - downloaded → "Ready to install [Restart & Install]"
 *
 * In a regular browser (not Electron), window.updater is undefined, so this
 * component renders nothing.
 */

import { useEffect, useState } from "react";
import { Download, RefreshCw, X, CheckCircle2, Loader2 } from "lucide-react";

type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

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
          setState({ kind: "downloading", percent: evt.percent || 0 });
          break;
        case "downloaded":
          setState({ kind: "downloaded", version: evt.version || "?" });
          setDismissed(false);
          break;
        case "error":
          setState({ kind: "error", message: evt.error || "Unknown error" });
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
        } else if (s?.updateInfo?.version) {
          setState({ kind: "available", version: s.updateInfo.version });
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

  const handleCheckNow = async () => {
    const updater = (window as any).updater;
    if (!updater) return;
    setWorking(true);
    try {
      await updater.check();
    } catch {}
    setWorking(false);
  };

  // Don't render the banner in a regular browser (no window.updater)
  if (typeof window !== "undefined" && !(window as any).updater) return null;

  return (
    <div className="fixed top-0 inset-x-0 z-50 px-4 pt-2 pointer-events-none">
      <div className="mx-auto max-w-4xl pointer-events-auto rounded-xl bg-gradient-to-r from-purple-600/95 to-pink-600/95 backdrop-blur border border-white/20 shadow-2xl px-4 py-3 flex items-center gap-3 text-white">
        <div className="flex-shrink-0">
          {state.kind === "downloading" ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : state.kind === "downloaded" ? (
            <CheckCircle2 className="w-5 h-5" />
          ) : state.kind === "error" ? (
            <X className="w-5 h-5" />
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
              </p>
              <div className="mt-1 h-1.5 bg-white/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white rounded-full transition-all"
                  style={{ width: `${state.percent}%` }}
                />
              </div>
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
          {state.kind === "error" && (
            <div>
              <p className="text-sm font-semibold">خطأ في التحديث</p>
              <p className="text-xs text-white/80 truncate">{state.message}</p>
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
              onClick={handleCheckNow}
              disabled={working}
              className="px-3 py-1.5 rounded-lg bg-white/20 text-white text-sm font-semibold hover:bg-white/30 transition disabled:opacity-50"
            >
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
