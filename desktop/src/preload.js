/**
 * Preload — exposes a small, safe IPC bridge to the renderer (installer.html
 * and the PWA loaded from Vercel).
 *
 * The renderer is loaded with contextIsolation:true, so it can't touch Node
 * directly. It can only call these explicitly-allowed methods.
 *
 * Two namespaces:
 *   - window.installer  → installer + diagnostic + launch APIs
 *   - window.updater    → auto-update APIs (check, download, install, subscribe)
 *   - window.backend    → backend lifecycle APIs (restart, status)
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("installer", {
  /** Returns { venv, wav2lip, fullyInstalled, paths } */
  getInstallState: () => ipcRenderer.invoke("installer:getInstallState"),

  /** Returns { success, error } */
  installPython: () => ipcRenderer.invoke("installer:installPython"),
  installPipDeps: () => ipcRenderer.invoke("installer:installPipDeps"),
  installWav2Lip: () => ipcRenderer.invoke("installer:installWav2Lip"),

  /** Returns { success, error } — starts backend + opens main window */
  launchApp: () => ipcRenderer.invoke("installer:launchApp"),

  /** Open the log folder in the OS file explorer (so user can share the log). */
  openLogFolder: () => ipcRenderer.invoke("installer:openLogFolder"),

  /** Returns diagnostic info about the system (OS, paths, available tools). */
  getDiagnosticInfo: () => ipcRenderer.invoke("installer:getDiagnosticInfo"),

  /** Subscribe to progress events. Returns an unsubscribe function. */
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("installer:progress", handler);
    return () => ipcRenderer.removeListener("installer:progress", handler);
  },

  /** Subscribe to backend stdout/stderr lines (so user sees what Python is doing during launch). */
  onBackendLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("installer:backendLog", handler);
    return () => ipcRenderer.removeListener("installer:backendLog", handler);
  },
});

// ---------------------------------------------------------------------------
// Auto-updater bridge — used by the PWA (loaded from Vercel) to show an
// "update available" banner and trigger download/install.
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld("updater", {
  /**
   * Check GitHub Releases for a newer version.
   * Returns { success, cached?, updateInfo?, error? }.
   *   updateInfo = { version, releaseDate, releaseName, releaseNotes } | null
   */
  check: () => ipcRenderer.invoke("updater:check"),

  /**
   * Download the latest update (if available). Triggers `progress` events.
   * Returns { success, error? }.
   */
  download: () => ipcRenderer.invoke("updater:download"),

  /**
   * Quit the app and run the NSIS updater. The app will relaunch after install.
   * Returns { success, error? }.
   */
  install: () => ipcRenderer.invoke("updater:install"),

  /** Returns { available, currentVersion, updateInfo, downloadedVersion, downloadPercent, lastError } */
  status: () => ipcRenderer.invoke("updater:status"),

  /**
   * Subscribe to updater events. Returns an unsubscribe function.
   * Events:
   *   { event: "checking" }
   *   { event: "available",  updateInfo }
   *   { event: "not-available", currentVersion }
   *   { event: "error",      error }
   *   { event: "progress",   percent, transferred, total }
   *   { event: "downloaded", version }
   */
  subscribe: (callback) => {
    const channels = [
      "updater:checking",
      "updater:available",
      "updater:not-available",
      "updater:error",
      "updater:progress",
      "updater:downloaded",
    ];
    const handlers = {};
    for (const ch of channels) {
      const eventName = ch.replace("updater:", "");
      const h = (_event, data) => callback({ event: eventName, ...data });
      handlers[ch] = h;
      ipcRenderer.on(ch, h);
    }
    return () => {
      for (const ch of channels) {
        ipcRenderer.removeListener(ch, handlers[ch]);
      }
    };
  },
});

// ---------------------------------------------------------------------------
// Backend lifecycle bridge — lets the PWA restart the local Python backend
// when it crashes (OOM during heavy lip-sync) instead of forcing the user
// to quit and relaunch the whole app.
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld("backend", {
  /**
   * Restart the local Python backend (kill + respawn + wait for /health).
   * Returns { success, error? }.
   */
  restart: () => ipcRenderer.invoke("backend:restart"),

  /**
   * Force-kill any process holding the backend port, then restart.
   * Use when 'restart' fails because a zombie python.exe is still
   * attached to port 8000 from a previous crash.
   * Returns { success, killedProcesses, error? }.
   */
  killPortAndRestart: () => ipcRenderer.invoke("backend:killPortAndRestart"),

  /**
   * Force re-sync backend source from bundled copy (fixes crashes caused
   * by stale server.py from a previous app version). Returns { success, error? }.
   */
  resync: () => ipcRenderer.invoke("backend:resync"),

  /**
   * Manually trigger the numpy<2 fix (downgrades numpy>=2 to <2 so torch
   * 2.2.2 can import cleanly). Same check that runs automatically on every
   * backend launch — exposed here for manual recovery.
   * Returns { success, fixed, oldVersion?, newVersion?, error? }.
   */
  fixNumpy: () => ipcRenderer.invoke("backend:fixNumpy"),

  /**
   * Returns { running, starting, lastExitCode, pid?, port, logFile, logDir }.
   */
  status: () => ipcRenderer.invoke("backend:status"),

  /** Subscribe to backend log lines (so the PWA can show what Python is doing). */
  onLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("backend:log", handler);
    return () => ipcRenderer.removeListener("backend:log", handler);
  },
});
