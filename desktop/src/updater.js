/**
 * Auto-updater module for Talking Characters Studio Desktop.
 *
 * Uses electron-updater to check GitHub Releases for new versions
 * (configured via `publish` in package.json — provider: github,
 * owner: mohamedelnoss89, repo: talking-characters-studio).
 *
 * Flow:
 *   1. On app startup (after main window loads), call checkForUpdates().
 *   2. If a new version is available, we emit an 'update-available' event
 *      to the renderer (PWA) via IPC, so it can show a banner.
 *   3. The user can click "Download & Install" — we call downloadUpdate().
 *   4. While downloading, we emit 'update-progress' events with percent.
 *   5. When done, we emit 'update-downloaded'. The user can click
 *      "Restart & Install" — we call quitAndInstall().
 *
 * IMPORTANT: In DEV mode (app.isPackaged === false), electron-updater
 * throws an "App is not packaged" error. We catch it and emit a
 * 'update-error' event instead of crashing.
 *
 * Also: electron-updater requires `latest.yml` (Windows) / `latest-mac.yml`
 * to be present alongside the installer in the GitHub Release. electron-builder
 * generates these automatically — just make sure they get uploaded.
 */

const { ipcMain, BrowserWindow, app } = require("electron");

let autoUpdater = null;
let checkedAtLeastOnce = false;
let lastError = null;
let updateInfo = null;       // { version, releaseNotes, releaseName }
let downloadedVersion = null;
let downloadPercent = 0;
let downloadAttempts = 0;     // tracks retries within a single download session
let isDownloading = false;    // guards against concurrent download attempts

const MAX_DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;  // 5s between retries

try {
  // Lazy-load so the app still runs if the package isn't installed yet.
  autoUpdater = require("electron-updater").autoUpdater;
} catch (e) {
  console.warn("[updater] electron-updater not installed:", e.message);
}

// Don't auto-download — let the user opt-in via the UI.
// We also don't auto-install on quit; the user must explicitly click
// "Restart & Install" so they don't lose unsaved work.
if (autoUpdater) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Allow updates even without code signing (we're not signing the .exe).
  autoUpdater.allowDowngrade = false;
  // Don't catch unhandled rejections in the updater — emit our own error event.
  autoUpdater.logger = null;
}

/**
 * Broadcast an update event to ALL browser windows (installer + main).
 * The renderer subscribes via `installer.onUpdateInfo`.
 */
function broadcast(event, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(`updater:${event}`, payload || {});
    }
  }
}

/**
 * Initialize the updater: wire up event listeners and IPC handlers.
 * MUST be called after app.whenReady() — autoUpdater uses app.getVersion().
 */
function initUpdater(log) {
  if (!autoUpdater) {
    log && log("[updater] electron-updater not available — skipping");
    return;
  }

  log && log("[updater] Initializing electron-updater...");

  // ---------------------------------------------------------
  // autoUpdater events → broadcast to renderer
  // ---------------------------------------------------------
  autoUpdater.on("checking-for-update", () => {
    log && log("[updater] Checking for updates...");
    broadcast("checking");
  });

  autoUpdater.on("update-available", (info) => {
    updateInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseName: info.releaseName || `v${info.version}`,
      releaseNotes: info.releaseNotes,
    };
    log && log(`[updater] Update available: v${info.version}`);
    broadcast("available", updateInfo);
  });

  autoUpdater.on("update-not-available", (info) => {
    log && log("[updater] No update available.");
    broadcast("not-available", { currentVersion: app.getVersion() });
  });

  autoUpdater.on("error", (err) => {
    lastError = err ? String(err.message || err) : "Unknown error";
    log && log(`[updater] Error: ${lastError}`);
    broadcast("error", { error: lastError });
  });

  autoUpdater.on("download-progress", (p) => {
    downloadPercent = Math.round(p.percent || 0);
    broadcast("progress", {
      percent: downloadPercent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloadedVersion = info.version;
    log && log(`[updater] Update downloaded: v${info.version}`);
    broadcast("downloaded", { version: info.version });
  });

  // ---------------------------------------------------------
  // IPC handlers — called by the renderer via preload.js
  // ---------------------------------------------------------
  ipcMain.handle("updater:check", async (_evt, force) => {
    if (!autoUpdater) {
      return { success: false, error: "electron-updater not installed" };
    }
    try {
      // Don't check more than once per minute to avoid GitHub rate limits.
      // `force` bypasses this — used by the Retry button after an error.
      if (checkedAtLeastOnce && !force) {
        return { success: true, cached: true, updateInfo, lastError };
      }
      checkedAtLeastOnce = true;
      // Clear stale error when forcing a fresh check
      if (force) lastError = null;
      await autoUpdater.checkForUpdates();
      return { success: true, updateInfo, lastError };
    } catch (e) {
      lastError = String(e?.message || e);
      return { success: false, error: lastError };
    }
  });

  /**
   * Download with auto-retry on transient network failures.
   *
   * electron-updater emits an `error` event when the download fails
   * (e.g. net::ERR_FAILED, ECONNRESET, ETIMEDOUT, GitHub 5xx). The
   * downloaded partial file is cached, so a subsequent downloadUpdate()
   * call RESUMES from where it left off (HTTP Range request).
   *
   * We retry up to MAX_DOWNLOAD_ATTEMPTS times with RETRY_DELAY_MS gap.
   * Each retry emits a `retry` event so the renderer can show
   * "Retry 2/3..." instead of just spinning.
   */
  async function downloadWithRetry() {
    if (isDownloading) {
      return { success: false, error: "Download already in progress" };
    }
    isDownloading = true;
    downloadAttempts = 0;
    downloadPercent = 0;

    try {
      while (downloadAttempts < MAX_DOWNLOAD_ATTEMPTS) {
        downloadAttempts++;
        broadcast("progress", { percent: downloadPercent, attempt: downloadAttempts, maxAttempts: MAX_DOWNLOAD_ATTEMPTS });
        broadcast("retry", { attempt: downloadAttempts, maxAttempts: MAX_DOWNLOAD_ATTEMPTS });
        try {
          await autoUpdater.downloadUpdate();
          // Success — download-downloaded event will fire separately.
          return { success: true };
        } catch (e) {
          const msg = String(e?.message || e);
          lastError = msg;
          // Abort retry loop if it's a non-retryable error
          if (/cancel|aborted|user/i.test(msg) && !/connection|network|timeout|reset|failed/i.test(msg)) {
            broadcast("error", { error: msg });
            return { success: false, error: msg };
          }
          if (downloadAttempts < MAX_DOWNLOAD_ATTEMPTS) {
            broadcast("progress", {
              percent: downloadPercent,
              attempt: downloadAttempts,
              maxAttempts: MAX_DOWNLOAD_ATTEMPTS,
              retryingIn: RETRY_DELAY_MS / 1000,
              lastError: msg,
            });
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else {
            broadcast("error", { error: msg, attemptsExhausted: true });
            return { success: false, error: msg };
          }
        }
      }
      return { success: false, error: lastError || "Max retries exceeded" };
    } finally {
      isDownloading = false;
    }
  }

  ipcMain.handle("updater:download", async () => {
    if (!autoUpdater) {
      return { success: false, error: "electron-updater not installed" };
    }
    return downloadWithRetry();
  });

  /**
   * Force re-check + retry download in one call. Used by the Retry button
   * in the UpdateBanner error state — previously the Retry button only
   * called `check()` which returned cached info and never actually
   * retried the download.
   */
  ipcMain.handle("updater:retry", async () => {
    if (!autoUpdater) {
      return { success: false, error: "electron-updater not installed" };
    }
    // Reset state so a fresh check actually runs
    checkedAtLeastOnce = false;
    lastError = null;
    try {
      await autoUpdater.checkForUpdates();
      checkedAtLeastOnce = true;
      if (!updateInfo) {
        return { success: true, noUpdate: true };
      }
      // Update is available — kick off download with retry
      return downloadWithRetry();
    } catch (e) {
      lastError = String(e?.message || e);
      broadcast("error", { error: lastError });
      return { success: false, error: lastError };
    }
  });

  ipcMain.handle("updater:install", async () => {
    if (!autoUpdater) {
      return { success: false, error: "electron-updater not installed" };
    }
    if (!downloadedVersion) {
      return { success: false, error: "No update downloaded yet" };
    }
    try {
      // quitAndInstall() quits the app and runs the NSIS updater.
      // The user will see the standard NSIS installer UI.
      setImmediate(() => {
        autoUpdater.quitAndInstall(true, true);
      });
      return { success: true };
    } catch (e) {
      lastError = String(e?.message || e);
      return { success: false, error: lastError };
    }
  });

  ipcMain.handle("updater:status", async () => {
    return {
      available: !!autoUpdater,
      currentVersion: app.getVersion(),
      updateInfo,
      downloadedVersion,
      downloadPercent,
      downloadAttempts,
      isDownloading,
      lastError,
      checkedAtLeastOnce,
    };
  });

  /**
   * Open the GitHub Releases page in the user's default browser.
   *
   * Used by the UpdateBanner's "فتح في المتصفح" button — when the in-app
   * download is too slow (94MB on a flaky Egyptian connection), the user
   * can fall back to downloading Setup.exe directly from GitHub in their
   * browser, which typically uses download managers / multi-connection
   * downloads that handle flaky networks better.
   *
   * After downloading, the user can just double-click the Setup.exe to
   * install — it will replace the existing installation cleanly.
   */
  ipcMain.handle("updater:openInBrowser", async () => {
    const { shell } = require("electron");
    const url = "https://github.com/mohamedelnoss89/talking-characters-studio/releases/latest";
    try {
      await shell.openExternal(url);
      return { success: true, url };
    } catch (e) {
      lastError = String(e?.message || e);
      return { success: false, error: lastError };
    }
  });

  log && log("[updater] electron-updater initialized");
}

/**
 * Trigger an update check after a small delay (so it doesn't compete with
 * backend startup). Safe to call multiple times — the IPC handler guards
 * against re-checking within 60 seconds.
 */
function checkForUpdatesAfterDelay(delayMs = 5000) {
  if (!autoUpdater) return;
  setTimeout(() => {
    try {
      autoUpdater.checkForUpdates().catch((e) => {
        console.warn("[updater] Background check failed:", e?.message || e);
      });
    } catch (e) {
      console.warn("[updater] Background check threw:", e?.message || e);
    }
  }, delayMs);
}

module.exports = {
  initUpdater,
  checkForUpdatesAfterDelay,
  isAvailable: () => !!autoUpdater,
};
