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
 *     shows a floating panel.
 *
 * Phase machine:
 *   "checking"   → initial state, first poll not done yet (renders nothing)
 *   "starting"   → backend unreachable BUT we're within the 90-second grace
 *                  period after the PWA loaded. The backend was healthy when
 *                  the PWA loaded (main.js awaited /health before opening
 *                  the PWA), so the most likely cause is the background
 *                  Wav2Lip model pre-load is still running, or the backend
 *                  just restarted. Show "جاري تشغيل السيرفر..." with a
 *                  live timer — NOT "السيرفر مش شغال".
 *   "down"       → grace period expired, backend still unreachable. Show
 *                  "السيرفر مش شغال" + Restart button.
 *   "restarting" → user clicked Restart, timer is ticking, polling /health.
 *   "error"      → restart failed or timed out. Show retry button.
 *   "ok"         → backend is healthy (renders nothing).
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
 *      the user sees real progress.
 *   5. On success → button disappears.
 *   6. On timeout → shows error with retry button.
 */

import { useEffect, useState, useRef } from "react";
import { RefreshCw, AlertCircle, Loader2 } from "lucide-react";
import { isBackendReachable, restartDesktopBackend } from "@/lib/wav2lip-client";

type Phase = "checking" | "starting" | "down" | "restarting" | "error" | "ok";

/**
 * How long to wait after the PWA loads before declaring the backend "down".
 *
 * main.js awaits /health before opening the PWA, so the backend was DEFINITELY
 * up when this component mounted. If the first poll fails, the most likely
 * causes are:
 *   - Backend is busy (model pre-load is hammering CPU, /health is slow)
 *   - Backend crashed during background pre-load (OOM, segfault)
 *   - The user is on a fresh install and the first model load is taking 1-3 min
 *   - v1.1.22+: On a low-RAM machine (<6GB), the OS pages heavily during
 *     torch + opencv + mediapipe imports, so /health can be unresponsive
 *     for 2-3 minutes even though the backend is still alive.
 *
 * During this grace period we show a "starting" message instead of "down".
 *
 * v1.1.22: Bumped from 90s → 240s. The old 90s threshold was too aggressive
 * on 4GB-RAM machines — the auto-restart would kill the Python process
 * mid-import, then start over, then kill again, creating a vicious cycle
 * where the user never got a working backend. 240s is enough for the slowest
 * real-world case (4GB RAM + 5400RPM HDD + Windows Defender scanning) while
 * still surfacing genuine crashes within ~4 minutes.
 */
const STARTING_GRACE_MS = 240_000;

/**
 * Whether to auto-restart the backend when the grace period expires.
 *
 * v1.1.22: DISABLED on low-RAM machines (<6GB, detected via navigator.deviceMemory).
 *
 * Why: On a 4GB machine, the most common cause of /health timeouts is NOT a
 * crash — it's the OS paging during heavy imports. Auto-restarting kills the
 * Python process mid-import, which:
 *   1. Loses all the import progress (next start has to redo it from scratch)
 *   2. May corrupt temp files
 *   3. Triggers another 2-3 minute import cycle
 *
 * On high-RAM machines (≥6GB), keep auto-restart enabled — if /health is
 * unreachable for 4 minutes on a fast machine, it really IS a crash.
 */
function detectLowRam(): boolean {
  try {
    // navigator.deviceMemory is Chrome-only, returns one of: 0.25, 0.5, 1, 2, 4, 8
    // (it caps at 8GB even on larger machines). Anything <8 is "low".
    const dm = (navigator as any).deviceMemory;
    if (typeof dm === "number" && dm > 0 && dm < 8) return true;
  } catch {}
  // Conservative default: assume NOT low-RAM (let auto-restart stay enabled).
  // The user can always click "Restart Server" manually if they want.
  return false;
}
const AUTO_RESTART_ENABLED = !detectLowRam();

export function BackendRestartButton({ language = "ar" }: { language?: "ar" | "en" }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [restartSeconds, setRestartSeconds] = useState<number>(0);
  const [lastLogLine, setLastLogLine] = useState<string>("");
  const [startingSeconds, setStartingSeconds] = useState<number>(0);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const restartTimerRef = useRef<NodeJS.Timeout | null>(null);
  const elapsedIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const unsubLogsRef = useRef<(() => void) | null>(null);
  const mountedAtRef = useRef<number>(Date.now());
  const autoRestartAttemptedRef = useRef<boolean>(false);

  const t = (ar: string, en: string) => (language === "ar" ? ar : en);

  // Subscribe to backend log lines so we can show what Python is doing
  // during restart AND during the initial starting phase (so the user sees
  // "Background model pre-load started..." instead of a static message).
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

  // Periodic backend reachability poll
  useEffect(() => {
    let mounted = true;
    mountedAtRef.current = Date.now();

    const check = async () => {
      // Only render in the desktop app context
      if (typeof window === "undefined" || !(window as any).backend) {
        return;
      }
      const ok = await isBackendReachable(1500);
      if (!mounted) return;

      if (ok && phase !== "restarting") {
        setPhase("ok");
        // Reset the auto-restart flag so a future crash can trigger it again
        autoRestartAttemptedRef.current = false;
      } else if (!ok && phase !== "restarting" && phase !== "error") {
        // Backend unreachable. Decide between "starting" (grace) and "down".
        const elapsedSinceMount = Date.now() - mountedAtRef.current;
        if (elapsedSinceMount < STARTING_GRACE_MS) {
          // Within grace period — backend was healthy when PWA loaded, so
          // give it time. Most likely the background model pre-load is
          // still running (or /health was just briefly slow).
          setPhase("starting");
          // Subscribe to logs so the user sees what Python is doing
          subscribeToBackendLogs();
        } else {
          // Grace period expired. If we haven't tried auto-restart yet,
          // kick one off automatically — this recovers from the common
          // case where the backend crashed during background model pre-load.
          if (AUTO_RESTART_ENABLED && !autoRestartAttemptedRef.current) {
            autoRestartAttemptedRef.current = true;
            // Don't await — let the poll continue; the restart flow will
            // transition us to "restarting" phase.
            handleRestart(true);
          } else {
            setPhase("down");
          }
        }
      }
    };
    check();
    pollRef.current = setInterval(check, 10000);
    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [phase]);

  // Live elapsed-seconds counter for the "starting" phase (separate from
  // the "restarting" timer because the starting phase measures time-since-
  // mount, not time-since-restart-click).
  useEffect(() => {
    if (phase !== "starting") return;
    const id = setInterval(() => {
      setStartingSeconds(Math.floor((Date.now() - mountedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

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

  /**
   * Trigger a backend restart via IPC.
   * @param isAutoRestart - true if this was triggered automatically by the
   *   starting→down transition (not a user click). Affects the message text.
   */
  const handleRestart = async (isAutoRestart = false) => {
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

  // "checking" = first poll not done yet. "ok" = backend healthy.
  if (phase === "checking" || phase === "ok") return null;

  // Color scheme by phase:
  //   starting  → blue/cyan (informational, not alarming)
  //   restarting → blue/cyan (informational, in progress)
  //   down      → red (something is wrong, user action needed)
  //   error     → red (restart failed)
  const isInfo = phase === "starting" || phase === "restarting";
  const containerClass = isInfo
    ? "rounded-xl bg-blue-950/90 backdrop-blur border border-blue-500/40 shadow-2xl px-4 py-3 text-blue-100"
    : "rounded-xl bg-red-950/90 backdrop-blur border border-red-500/40 shadow-2xl px-4 py-3 text-red-100";
  const titleClass = isInfo ? "text-blue-50" : "text-red-50";
  const subtitleClass = isInfo ? "text-blue-200/80" : "text-red-200/80";
  const logLineClass = isInfo
    ? "text-[11px] mt-1.5 text-blue-200/60 font-mono truncate"
    : "text-[11px] mt-1.5 text-red-200/60 font-mono truncate";
  const buttonClass = isInfo
    ? "mt-2 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold flex items-center gap-1.5 transition"
    : "mt-2 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-semibold flex items-center gap-1.5 transition";

  const titleText =
    phase === "starting"
      ? t("جاري تشغيل السيرفر...", "Starting server...")
      : phase === "restarting"
      ? t("إعادة تشغيل السيرفر...", "Restarting server...")
      : phase === "error"
      ? t("فشل إعادة التشغيل", "Restart failed")
      : t("السيرفر مش شغال", "Backend is down");

  const subtitleText =
    phase === "starting"
      ? t(
          `الـ Python بيحمّل نماذج الـ AI... ${startingSeconds}s`,
          `Python is loading AI models... ${startingSeconds}s`
        )
      : phase === "restarting"
      ? t(
          `بيحمّل نماذج الـ AI... ${restartSeconds}s`,
          `Loading AI models... ${restartSeconds}s`
        )
      : phase === "error"
      ? errorMsg
      : t(
          "الـ Python backend وقع. اضغط لإعادة تشغيله.",
          "The Python backend crashed. Click to restart it."
        );

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-sm pointer-events-auto">
      <div className={containerClass}>
        <div className="flex items-start gap-3">
          {isInfo ? (
            <Loader2 className="w-5 h-5 mt-0.5 flex-shrink-0 text-blue-300 animate-spin" />
          ) : (
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-300" />
          )}
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold ${titleClass}`}>{titleText}</p>
            <p className={`text-xs mt-1 ${subtitleClass}`}>{subtitleText}</p>

            {/* Live Python log line — shows the user what's actually happening
                instead of a static message. Shown in both starting + restarting
                + down phases (in "down", shows the LAST line before crash). */}
            {lastLogLine && (
              <p className={logLineClass} dir="ltr">{lastLogLine}</p>
            )}

            {phase === "starting" && (
              <div className="mt-2 flex items-center gap-2 text-xs text-blue-200">
                <span>
                  {AUTO_RESTART_ENABLED
                    ? t(
                        "استنى، لو ما اشتغلش في خلال 4 دقايق هحاول أوتوماتيك",
                        "Auto-restart will trigger if not up in 4min"
                      )
                    : t(
                        "استنى، تحميل النماذج ممكن ياخد 3-5 دقايق على رام 4 جيجا",
                        "Model loading may take 3-5 min on 4GB RAM"
                      )}
                </span>
              </div>
            )}

            {phase === "down" && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => handleRestart(false)}
                  className={buttonClass}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t("إعادة تشغيل السيرفر", "Restart Server")}
                </button>
                <button
                  onClick={() => {
                    const inst = (window as any).installer;
                    if (inst && typeof inst.openLogFolder === "function") {
                      inst.openLogFolder();
                    }
                  }}
                  className="mt-0 px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-red-100 text-xs transition"
                  title={t("افتح مجلد الـ logs", "Open logs folder")}
                >
                  {t("الـ logs", "Logs")}
                </button>
              </div>
            )}

            {phase === "restarting" && (
              <div className="mt-2 flex items-center gap-2 text-xs text-blue-200">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>{t("استنى، ممكن ياخد لـ 3 دقايق", "Please wait, can take up to 3 min")}</span>
              </div>
            )}

            {phase === "error" && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => handleRestart(false)}
                  className={buttonClass}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  {t("حاول تاني", "Try again")}
                </button>
                <button
                  onClick={() => {
                    const inst = (window as any).installer;
                    if (inst && typeof inst.openLogFolder === "function") {
                      inst.openLogFolder();
                    }
                  }}
                  className="mt-0 px-2 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-red-100 text-xs transition"
                  title={t("افتح مجلد الـ logs", "Open logs folder")}
                >
                  {t("الـ logs", "Logs")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
