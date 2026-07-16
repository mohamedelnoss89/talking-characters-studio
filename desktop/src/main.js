/**
 * Talking Characters Studio — Electron main process
 *
 * Responsibilities:
 *   1. On startup, check whether the Python backend is installed locally.
 *      If not, show the installer window (src/installer.html) which downloads
 *      and installs Python + Wav2Lip + models.
 *   2. Once installed, spawn the Python backend as a child process on port 8000.
 *   3. Wait for /health to return ok, then load the PWA in a BrowserWindow.
 *
 * The PWA (served from Vercel) talks DIRECTLY to http://localhost:8000
 * for lip-sync / TTS / image generation. Auth (login/register) still
 * goes to Vercel via relative URLs and the httpOnly JWT cookie.
 */

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile, spawnSync } = require("child_process");
const http = require("http");
const https = require("https");

// ---------------------------------------------------------------------------
// Log file — write all installer logs to a file so we can debug even if the
// UI doesn't show the error.
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(app.getPath("userData"), "logs");
const LOG_FILE = path.join(LOG_DIR, `installer-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, `=== Talking Characters Studio Installer Log ===\nStarted: ${new Date().toISOString()}\nPlatform: ${process.platform} ${process.arch}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\nApp version: ${app.getVersion()}\n\n`);
} catch (e) {
  console.error("Failed to create log file:", e);
}

function logToFile(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const IS_PACKAGED = app.isPackaged;
const RESOURCES_PATH = IS_PACKAGED
  ? process.resourcesPath
  : path.join(__dirname, "..", "..");

// Backend Python source lives in resources/backend (extraResources in package.json)
const BACKEND_SRC_DIR = path.join(RESOURCES_PATH, "backend");

// User data dir: where Python + models + venv live (per-user, writable)
// Windows: %LOCALAPPDATA%/Talking Characters Studio/
// macOS:   ~/Library/Application Support/Talking Characters Studio/
const USER_DATA_DIR = path.join(app.getPath("userData"), "backend");
const PYTHON_DIR = path.join(app.getPath("userData"), "python");
const VENV_DIR = path.join(app.getPath("userData"), "venv");
const WAV2LIP_DIR = path.join(USER_DATA_DIR, "Wav2Lip");
const CKPT_PATH = path.join(WAV2LIP_DIR, "checkpoints", "wav2lip_gan.pth");

// Web app URL — PWA served from Vercel
const WEB_APP_URL =
  process.env.TCS_WEB_URL ||
  "https://talking-characters-studio.vercel.app";

const BACKEND_PORT = 8000;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let mainWindow = null;
let installerWindow = null;
let backendProcess = null;
let backendStarting = false;

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function log(...args) {
  const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  console.log("[main]", msg);
  logToFile("[main] " + msg);
}

// ---------------------------------------------------------------------------
// State checks
// ---------------------------------------------------------------------------

/** Returns true if a usable Python is installed (either venv or embedded). */
function isVenvInstalled() {
  const isWin = process.platform === "win32";
  // Check venv first
  const venvPy = path.join(VENV_DIR, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  if (fs.existsSync(venvPy)) return true;
  // Check embedded Python marker
  const embeddedMarker = path.join(PYTHON_DIR, "USE_EMBEDDED.txt");
  const embeddedPy = path.join(PYTHON_DIR, "python.exe");
  if (fs.existsSync(embeddedMarker) && fs.existsSync(embeddedPy)) return true;
  return false;
}

/** Returns true if Wav2Lip checkpoint exists and is large enough. */
function isWav2LipInstalled() {
  try {
    return fs.existsSync(CKPT_PATH) && fs.statSync(CKPT_PATH).size > 400_000_000;
  } catch {
    return false;
  }
}

/** Returns true if everything is set up. */
function isFullyInstalled() {
  return isVenvInstalled() && isWav2LipInstalled();
}

// ---------------------------------------------------------------------------
// Backend process management
// ---------------------------------------------------------------------------

function getVenvPython() {
  const isWin = process.platform === "win32";
  // Prefer venv if it exists
  const venvPy = path.join(VENV_DIR, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
  if (fs.existsSync(venvPy)) return venvPy;
  // Fall back to embedded Python (no venv case)
  const embeddedPy = path.join(PYTHON_DIR, "python.exe");
  if (fs.existsSync(embeddedPy)) return embeddedPy;
  // Return venvPy as default (will fail with clear error if used)
  return venvPy;
}

function startBackend() {
  if (backendProcess || backendStarting) return Promise.resolve();
  backendStarting = true;

  return new Promise((resolve, reject) => {
    const py = getVenvPython();
    if (!fs.existsSync(py)) {
      backendStarting = false;
      reject(new Error("Python venv not found: " + py));
      return;
    }

    log("Starting backend:", py, "server.py");
    backendProcess = spawn(py, ["server.py"], {
      cwd: BACKEND_SRC_DIR,
      env: {
        ...process.env,
        // Force Python to flush stdout so we can read logs in real-time
        PYTHONUNBUFFERED: "1",
        // Add the Wav2Lip dir to PYTHONPATH so wav2lip_runner can find it
        PYTHONPATH: WAV2LIP_DIR + path.delimiter + (process.env.PYTHONPATH || ""),
      },
      windowsHide: true,
    });

    backendProcess.stdout.on("data", (chunk) => {
      log("[py:stdout]", chunk.toString().trim());
    });
    backendProcess.stderr.on("data", (chunk) => {
      log("[py:stderr]", chunk.toString().trim());
    });
    backendProcess.on("exit", (code) => {
      log("Backend exited with code", code);
      backendProcess = null;
      backendStarting = false;
    });

    // Wait for /health to respond
    const start = Date.now();
    const timeoutMs = 60_000;
    const check = () => {
      const req = http.get(`${BACKEND_URL}/health`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            log("Backend is healthy:", body);
            backendStarting = false;
            resolve();
          } else {
            scheduleNext();
          }
        });
      });
      req.on("error", () => scheduleNext());
      req.setTimeout(2000, () => {
        req.destroy();
        scheduleNext();
      });
    };
    const scheduleNext = () => {
      if (Date.now() - start > timeoutMs) {
        backendStarting = false;
        reject(new Error("Backend health check timed out after 60s"));
        return;
      }
      setTimeout(check, 1000);
    };
    setTimeout(check, 1500);
  });
}

function stopBackend() {
  if (!backendProcess) return;
  try {
    backendProcess.kill("SIGTERM");
    // Give it a moment, then SIGKILL if still alive
    setTimeout(() => {
      try {
        backendProcess && backendProcess.kill("SIGKILL");
      } catch {}
    }, 3000);
  } catch (e) {
    log("Error stopping backend:", e);
  }
  backendProcess = null;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createInstallerWindow() {
  installerWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    title: "تثبيت محرك الشخصيات المتكلمة",
    backgroundColor: "#0a0b10",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    frame: true,
    resizable: false,
  });

  installerWindow.loadFile(path.join(__dirname, "installer.html"));

  installerWindow.on("closed", () => {
    installerWindow = null;
  });

  if (process.argv.includes("--dev")) {
    installerWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "محرك الشخصيات المتكلمة",
    backgroundColor: "#0a0b10",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    autoHideMenuBar: true,
    show: false,
  });

  // Open external links (e.g. Google OAuth redirects that escape the app scope)
  // in the user's default browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(WEB_APP_URL) || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  log("Loading PWA:", WEB_APP_URL);
  mainWindow.loadURL(WEB_APP_URL);

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  log("App ready. Checking install state...");

  if (isFullyInstalled()) {
    log("Already installed. Starting backend...");
    try {
      await startBackend();
      createMainWindow();
    } catch (e) {
      log("Failed to start backend:", e);
      // Show installer window with the error so user can retry
      createInstallerWindow();
    }
  } else {
    log("Not fully installed. Showing installer window.");
    createInstallerWindow();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (isFullyInstalled()) createMainWindow();
      else createInstallerWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopBackend();
});

// ---------------------------------------------------------------------------
// IPC — installer <-> main
// ---------------------------------------------------------------------------

/**
 * The installer page calls these to:
 *   - getInstallState   → check what's missing
 *   - installPython     → download + extract Python embedded
 *   - installPipDeps    → pip install all required packages
 *   - installWav2Lip    → clone + download checkpoint + patch librosa
 *   - launchApp         → start backend + open main window
 *
 * All send progress updates via `installer:progress` event.
 */

ipcMain.handle("installer:getInstallState", async () => {
  return {
    venv: isVenvInstalled(),
    wav2lip: isWav2LipInstalled(),
    fullyInstalled: isFullyInstalled(),
    paths: {
      backendSrc: BACKEND_SRC_DIR,
      userData: USER_DATA_DIR,
      python: PYTHON_DIR,
      venv: VENV_DIR,
      wav2lip: WAV2LIP_DIR,
      checkpoint: CKPT_PATH,
    },
  };
});

// Forward installer progress to the installer window
function sendProgress(stage, percent, message) {
  if (installerWindow && !installerWindow.isDestroyed()) {
    installerWindow.webContents.send("installer:progress", { stage, percent, message });
  }
}

// Set log file path in installer-python so it writes to the same file
const installerPython = require("./installer-python");
installerPython.setLogFilePath(LOG_FILE);

ipcMain.handle("installer:installPython", async () => {
  sendProgress("python", 0, "بدء تثبيت Python...");
  log("[IPC] installPython invoked");
  return installerPython.installPython({ PYTHON_DIR, VENV_DIR, sendProgress, log });
});

ipcMain.handle("installer:installPipDeps", async () => {
  sendProgress("pip", 0, "بدء تثبيت مكتبات Python...");
  log("[IPC] installPipDeps invoked");
  return installerPython.installPipDeps({ VENV_DIR, PYTHON_DIR, BACKEND_SRC_DIR, sendProgress, log });
});

ipcMain.handle("installer:installWav2Lip", async () => {
  sendProgress("wav2lip", 0, "بدء تثبيت Wav2Lip...");
  log("[IPC] installWav2Lip invoked");
  return installerPython.installWav2Lip({ WAV2LIP_DIR, CKPT_PATH, VENV_DIR, PYTHON_DIR, sendProgress, log });
});

ipcMain.handle("installer:launchApp", async () => {
  log("Launch requested. Starting backend...");
  try {
    await startBackend();
    if (installerWindow) {
      installerWindow.close();
      installerWindow = null;
    }
    createMainWindow();
    return { success: true };
  } catch (e) {
    log("Launch failed:", e);
    return { success: false, error: String(e?.message || e) };
  }
});

// Open the log folder in the OS file explorer
ipcMain.handle("installer:openLogFolder", async () => {
  try {
    log("[IPC] openLogFolder invoked. LOG_DIR=" + LOG_DIR);
    // Ensure the log folder exists
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Open the folder (not the file) so the user can see all log files
    shell.openPath(LOG_DIR);
    return { success: true, path: LOG_DIR };
  } catch (e) {
    log("[IPC] openLogFolder failed:", e);
    return { success: false, error: String(e?.message || e) };
  }
});

// Return diagnostic info about the system
ipcMain.handle("installer:getDiagnosticInfo", async () => {
  try {
    const info = {
      platform: `${process.platform} ${os.release()}`,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      appVersion: app.getVersion(),
      userDataDir: app.getPath("userData"),
      pythonDir: PYTHON_DIR,
      venvDir: VENV_DIR,
      wav2lipDir: WAV2LIP_DIR,
      backendSrcDir: BACKEND_SRC_DIR,
      logDir: LOG_DIR,
      logFile: LOG_FILE,
      hasPowershell: false,
      hasTar: false,
      hasGit: false,
      userDataWritable: false,
      venvInstalled: isVenvInstalled(),
      wav2lipInstalled: isWav2LipInstalled(),
      fullyInstalled: isFullyInstalled(),
    };

    // Check if PowerShell is available (Windows)
    if (process.platform === "win32") {
      try {
        const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "echo ok"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 5000,
        });
        info.hasPowershell = r.status === 0 && (r.stdout || "").includes("ok");
      } catch {}
    }

    // Check if tar is available
    try {
      const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";
      const r = spawnSync(tarCmd, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      });
      info.hasTar = r.status === 0;
    } catch {}

    // Check if git is available
    try {
      const r = spawnSync("git", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      });
      info.hasGit = r.status === 0;
    } catch {}

    // Check if userData dir is writable
    try {
      const testFile = path.join(app.getPath("userData"), ".write-test-" + Date.now());
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      info.userDataWritable = true;
    } catch (e) {
      info.userDataWritable = false;
      info.userDataError = String(e?.message || e);
    }

    log("[IPC] getDiagnosticInfo:", JSON.stringify(info, null, 2));
    return info;
  } catch (e) {
    log("[IPC] getDiagnosticInfo failed:", e);
    return { error: String(e?.message || e) };
  }
});

log("Main process module loaded");
