"use client";

/**
 * BackendRestartButton — small floating button shown when the local Python
 * backend (http://localhost:8000) is unreachable. Lets the user restart it
 * via Electron IPC without quitting the app.
 *
 * Behaviour:
 *   - Periodically polls isBackendReachable() every 10s.
 *   - If reachable → renders nothing.
 *   - If unreachable AND window.backend exists (we're in the desktop app) →
 *     shows a floating panel with "Restart Server" button.
 *   - If unreachable but no window.backend (regular browser) → renders nothing
 *     (the user opened the PWA in a browser, the desktop app isn't running).
 *
 * After clicking "Restart":
 *   1. Button shows "Restarting..." state WITH a live elapsed-seconds timer
 *      (timer starts IMMEDIATELY — does NOT wait for the IPC to return).
 *   2. Calls restartDesktopBackend() which IPCs to main.js. The IPC handler
 *      returns immediately after spawning the Python process (it does NOT
 *      wait for /health — see desktop/src/main.js for the rationale).
 *   3. Renderer polls /health every 2s for up to 5 minutes (model pre-load
 *      takes 1-3 min on CPU).
 *   4. While waiting, the latest Python log line is streamed to the UI so
 *      the user sees real progress (e.g. "Background model pre-load
 *      started...", "uvicorn is ready to serve requests", ...).
 *   5. On success → button disappears.
 *   6. On timeout → shows error with retry button.
 */

import { useEffect, useState, useRef } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import { isBackendReachable, restartDesktopBackend } from "@/lib/wav2lip-client";

type Phase = "checking" | "down" | "restarting" | "error" | "ok";

export function BackendRestartButton({ language = "ar" }: { language?: "ar" | "en" }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [restartSeconds, setRestartSeconds] = useState<number>(0);
  const [lastLogLine, setLastLogLine] = useState<string>("");
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const restartTimerRef = useRef<NodeJS.Timeout | null>(null);
  const elapsedIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const unsubLogsRef = useRef<(() => void) | null>(null);

  const t = (ar: string, en: string) => (language === "ar" ? ar : en);

  // Periodic backend reachability poll
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      // Only render in the desktop app context
      if (typeof window === "undefined" || !(window as any).backend) {
        return;
      }
      const ok = await isBackendReachable(1500);
      if (!mounted) return;
      if (ok && phase !== "restarting") {
        setPhase("ok");
      } else if (!ok && phase !== "restarting" && phase !== "error") {
        setPhase("down");
      }
    };
    check();
    pollRef.current = setInterval(check, 10000);
    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase]);

  // Subscribe to backend log lines so we can show what Python is doing
  // during restart (e.g. "Loading model...", "uvicorn ready", ...).
  const subscribeToBackendLogs = () => {
    if (unsubLogsRef.current) return; // already subscribed
    const backendApi = (typeof window !== "undefined" && (window as any).backend) || null;
    if (!backendApi || typeof backendApi.onLog !== "function") return;
    try {
      unsubLogsRef.current = backendApi.onLog((payload: any) => {
        const line = typeof payload === "string" ? payload : payload?.line;
        if (line) setLastLogLine(line);
      });
    } catch {}
  };
  const unsubscribeFromBackendLogs = () => {
    if (unsubLogsRef.current) {
      try { unsubLogsRef.current(); } catch {}
      unsubLogsRef.current = null;
    }
  };

  // Wait for backend to come back online after restart (poll /health).
  // `startedAt` is captured by closure; the elapsed-seconds counter is
  // also maintained separately by `elapsedIntervalRef` so the UI updates
  // every second even between /health polls.
  const waitForBackend = (startedAt: number, maxSeconds = 300) => {
    return new Promise<void>((resolve, reject) => {
      const tick = async () => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        if (elapsed > maxSeconds) {
          setPhase("error");
          setErrorMsg(t(
            `انتهت المهلة بعد ${maxSeconds} ثانية. شغّل التطبيق من جديد.`,
            `Timed out after ${maxSeconds}s. Please relaunch the app.`
          ));
          reject(new Error("timeout"));
          return;
        }
        const ok = await isBackendReachable(2000);
        if (ok) {
          setPhase("ok");
          resolve();
        } else {
          restartTimerRef.current = setTimeout(tick, 2000);
        }
      };
      tick();
    });
  };

  const handleRestart = async () => {
    setPhase("restarting");
    setErrorMsg("");
    setRestartSeconds(0);
    setLastLogLine("");

    // Start the elapsed-seconds timer IMMEDIATELY. Previously the timer was
    // started inside waitForBackend(), which only ran AFTER the IPC returned
    // — and the IPC used to wait for /health, so the timer was stuck at 0
    // for the entire 1-3 minute wait. Now the IPC returns instantly (after
    // spawning Python) and the renderer polls /health itself.
    const startedAt = Date.now();
    elapsedIntervalRef.current = setInterval(() => {
      setRestartSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    // Stream Python log lines to the UI so the user sees real progress.
    subscribeToBackendLogs();

    try {
      // Fire the IPC — it returns immediately after spawning the process.
      // We still await it so we can catch immediate failures (e.g. Python
      // missing), but it no longer blocks until /health responds.
      const result = await restartDesktopBackend();
      if (!result.success) {
        setPhase("error");
        setErrorMsg(result.error || t("فشل إعادة التشغيل", "Restart failed"));
        return;
      }
      // Now poll /health in the renderer until backend is up.
      await waitForBackend(startedAt, 300);
    } catch (e: any) {
      setPhase("error");
      setErrorMsg(e?.message || String(e));
    } finally {
      if (elapsedIntervalRef.current) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
      // Keep the log subscription alive for a few more seconds in case the
      // user wants to see the final "✓ Backend is healthy!" line, then
      // clean up.
      setTimeout(() => unsubscribeFromBackendLogs(), 3000);
    }
  };

  useEffect(() => {
    return () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current);
      unsubscribeFromBackendLogs();
    };
  }, []);

  // Don't render in a regular browser (no Electron bridge)
  if (typeof window !== "undefined" && !(window as any).backend) return null;

  if (phase === "checking" || phase === "ok") return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-sm pointer-events-auto">
      <div className="rounded-xl bg-red-950/90 backdrop-blur border border-red-500/40 shadow-2xl px-4 py-3 text-red-100">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-300" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-50">
              {phase === "restarting"
                ? t("إعادة تشغيل السيرفر...", "Restarting server...")
                : phase === "error"
                ? t("فشل إعادة التشغيل", "Restart failed")
                : t("السيرفر مش شغال", "Backend is down")}
            </p>
            <p className="text-xs mt-1 text-red-200/80">
              {phase === "restarting"
                ? t(
                    `بيحمّل نماذج الـ AI... ${restartSeconds}s`,
                    `Loading AI models... ${restartSeconds}s`
                  )
                : phase === "error"
                ? errorMsg
                : t(
                    "الـ Python backend وقع. اضغط لإعادة تشغيله.",
                    "The Python backend crashed. Click to restart it."
                  )}
            </p>

            {/* Live Python log line — shows the user what's actually happening
                instead of a stuck 0s timer. */}
            {phase === "restarting" && lastLogLine && (
              <p className="text-[11px] mt-1.5 text-red-200/60 font-mono truncate" dir="ltr">
                {lastLogLine}
              </p>
            )}

            {phase === "down" && (
              <button
                onClick={handleRestart}
                className="mt-2 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold flex items-center gap-1.5 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {t("إعادة تشغيل السيرفر", "Restart Server")}
              </button>
            )}

            {phase === "restarting" && (
              <div className="mt-2 flex items-center gap-2 text-xs text-red-200">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>{t("استنى، ممكن ياخد لـ 3 دقايق", "Please wait, can take up to 3 min")}</span>
              </div>
            )}

            {phase === "error" && (
              <button
                onClick={handleRestart}
                className="mt-2 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold flex items-center gap-1.5 transition"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {t("حاول تاني", "Try again")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
