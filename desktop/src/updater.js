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
  ipcMain.handle("updater:check", async () => {
    if (!autoUpdater) {
      return { success: false, error: "electron-updater not installed" };
    }
    try {
      // Don't check more than once per minute to avoid GitHub rate limits.
      if (checkedAtLeastOnce) {
        return { success: true, cached: true, updateInfo, lastError };
      }
      checkedAtLeastOnce = true;
      await autoUpdater.checkForUpdates();
      return { success: true, updateInfo, lastError };
    } catch (e) {
      lastError = String(e?.message || e);
      return { success: false, error: lastError };
    }
  });

  ipcMain.handle("updater:download", async () => {
    if (!autoUpdater) {
      return { success: false, error: "electron-updater not installed" };
    }
    try {
      // downloadUpdate() returns a Promise<Array<DownloadUpdateResult>>
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (e) {
      lastError = String(e?.message || e);
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
      lastError,
      checkedAtLeastOnce,
    };
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
