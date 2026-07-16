/**
 * Preload — exposes a small, safe IPC bridge to the renderer (installer.html).
 * The renderer is loaded with contextIsolation:true, so it can't touch Node
 * directly. It can only call these explicitly-allowed methods.
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
});
