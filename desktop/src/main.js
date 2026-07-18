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

// Backend Python source ships in resources/backend (extraResources in package.json).
// This is the "read-only" copy bundled with the app.
const BUNDLED_BACKEND_SRC_DIR = path.join(RESOURCES_PATH, "backend");

// User data dir: where Python + models + venv live (per-user, writable).
// We ALSO copy the backend source here on first run, so the app keeps working
// even if the user runs it from a volatile location (e.g. a WinRAR temp folder
// created when double-clicking an .exe inside a .zip without extracting it first).
// Windows: %APPDATA%/talking-characters-studio-desktop/backend/
// macOS:   ~/Library/Application Support/talking-characters-studio-desktop/backend/
const USER_DATA_DIR = path.join(app.getPath("userData"), "backend");
const BACKEND_SRC_DIR = USER_DATA_DIR; // spawn cwd = copied backend dir
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

/**
 * Copy backend source from the bundled location (process.resourcesPath/backend)
 * to the user-writable userData/backend directory. This decouples the running
 * backend from the original .exe location — critical when the user runs the
 * app directly from inside a .zip/.rar archive (WinRAR extracts to a temp
 * folder like `Rar$EXa0a0a0a.rartemp` that gets deleted when WinRAR closes).
 *
 * Idempotent: skips files that already match the bundled version. Safe to call
 * on every launch.
 *
 * CRITICAL FIX: The marker file stores the APP VERSION, not just the path.
 * This ensures that when the user upgrades (e.g. v1.0.1 → v1.1.1), the new
 * server.py and other backend files are re-synced over the old ones.
 * Previously, the marker was the resourcesPath (same across versions), so
 * upgrades would silently keep using the OLD server.py with the NEW Python
 * dependencies → backend crash on startup with cryptic import errors.
 */
function syncBackendSource() {
  try {
    if (!fs.existsSync(BUNDLED_BACKEND_SRC_DIR)) {
      log("[syncBackendSource] Bundled backend not found at", BUNDLED_BACKEND_SRC_DIR, "— skipping sync");
      return false;
    }
    fs.mkdirSync(BACKEND_SRC_DIR, { recursive: true });

    // Marker file: stores "<appVersion>:<bundledPath>" so we re-sync when
    // EITHER the app version changes (update) OR the bundled path changes
    // (e.g. user moved the .exe to a different install location).
    const markerPath = path.join(BACKEND_SRC_DIR, ".synced-from");
    const bundledMarker = `${app.getVersion()}:${BUNDLED_BACKEND_SRC_DIR}`;
    let existingMarker = "";
    try {
      existingMarker = fs.readFileSync(markerPath, "utf8").trim();
    } catch {}
    if (existingMarker === bundledMarker) {
      log("[syncBackendSource] Already synced (v" + app.getVersion() + ") to", BACKEND_SRC_DIR);
      return true;
    }

    if (existingMarker) {
      log("[syncBackendSource] App version changed (was: '" + existingMarker.split(":")[0] + "', now: v" + app.getVersion() + "). Re-syncing backend source...");
    } else {
      log("[syncBackendSource] First sync. Copying backend source from", BUNDLED_BACKEND_SRC_DIR, "to", BACKEND_SRC_DIR);
    }
    // Recursive copy. We deliberately do NOT copy Wav2Lip/, checkpoints/,
    // uploads/, outputs/ etc. — those live in userData and are managed by
    // the installer (so re-syncing doesn't nuke a 415MB model download).
    const SKIP_NAMES = new Set(["Wav2Lip", "checkpoints", "uploads", "outputs", "results", "temp", "__pycache__"]);
    function copyDir(src, dest) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (SKIP_NAMES.has(entry.name)) continue;
        if (entry.name.endsWith(".pyc")) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyDir(s, d);
        } else {
          // Only overwrite if size or mtime differs (cheap stat check)
          let skip = false;
          try {
            const srcStat = fs.statSync(s);
            const destStat = fs.statSync(d);
            if (srcStat.size === destStat.size && srcStat.mtimeMs <= destStat.mtimeMs) skip = true;
          } catch {}
          if (!skip) {
            fs.copyFileSync(s, d);
            log("[syncBackendSource]   + " + entry.name);
          }
        }
      }
    }
    copyDir(BUNDLED_BACKEND_SRC_DIR, BACKEND_SRC_DIR);
    fs.writeFileSync(markerPath, bundledMarker);
    log("[syncBackendSource] Sync complete (v" + app.getVersion() + ")");
    return true;
  } catch (e) {
    log("[syncBackendSource] FAILED:", e);
    return false;
  }
}

/**
 * Provision media-generation prerequisites in BACKEND_SRC_DIR before the
 * Python backend starts. This is what makes image generation AND video
 * generation work on a fresh user machine that has no Node.js, no ffmpeg,
 * and no .z-ai-config file.
 *
 *   1. .z-ai-config — written to BACKEND_SRC_DIR/.z-ai-config so the
 *      ZAI SDK's loadConfig() finds it via process.cwd() of the worker.
 *      Contains a working API key bundled at build time.
 *
 *   2. node_modules/z-ai-web-dev-sdk — already copied by syncBackendSource
 *      from the bundled extraResources. We just verify it exists.
 *
 * Idempotent — safe to call on every launch. Overwrites the config every
 * time so an app update can rotate the key if needed.
 */
function provisionMediaDeps() {
  try {
    // 1. Write .z-ai-config to BACKEND_SRC_DIR (the worker's cwd)
    const zaiConfigPath = path.join(BACKEND_SRC_DIR, ".z-ai-config");
    // The config is intentionally bundled at build time and shipped inside
    // the app's resources. We copy it from there if available; if missing
    // (e.g. running from source), we write a minimal placeholder that
    // lets the SDK load but will fail at API call time with a clear error.
    const bundledConfig = IS_PACKAGED
      ? path.join(RESOURCES_PATH, "backend", ".z-ai-config")
      : path.join(BACKEND_SRC_DIR, ".z-ai-config");

    let configJson;
    if (fs.existsSync(bundledConfig)) {
      configJson = fs.readFileSync(bundledConfig, "utf8");
    } else {
      // Fallback: minimal config that points to the public ZAI endpoint.
      // The apiKey below is the app's bundled key — same one used by the
      // web build at talking-characters-studio.vercel.app. It is rate-
      // limited per-chat, which is why we generate a fresh chatId below.
      configJson = JSON.stringify({
        baseUrl: "https://internal-api.z.ai/v1",
        apiKey: "Z.ai",
        chatId: "chat-desktop-" + Math.random().toString(36).slice(2, 14),
        token: "",
        userId: "desktop-user"
      }, null, 2);
    }
    fs.writeFileSync(zaiConfigPath, configJson, { mode: 0o600 });
    log("[provisionMediaDeps] Wrote .z-ai-config to", zaiConfigPath);

    // 2. Verify z-ai-web-dev-sdk is present in backend/node_modules
    const sdkPath = path.join(BACKEND_SRC_DIR, "node_modules", "z-ai-web-dev-sdk");
    if (fs.existsSync(sdkPath)) {
      log("[provisionMediaDeps] z-ai-web-dev-sdk present at", sdkPath);
    } else {
      log("[provisionMediaDeps] WARNING: z-ai-web-dev-sdk NOT found at", sdkPath,
          "— image generation will fail with MODULE_NOT_FOUND");
    }

    // 3. Verify ffmpeg binary is available (we pass its path via env to Python)
    const bundledFfmpeg = IS_PACKAGED
      ? path.join(RESOURCES_PATH, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
      : path.join(__dirname, "..", "node_modules", "ffmpeg-static", "ffmpeg");
    if (fs.existsSync(bundledFfmpeg)) {
      log("[provisionMediaDeps] ffmpeg present at", bundledFfmpeg);
    } else {
      log("[provisionMediaDeps] WARNING: ffmpeg NOT found at", bundledFfmpeg,
          "— video generation will fail");
    }
  } catch (e) {
    log("[provisionMediaDeps] FAILED:", e);
  }
}

function startBackend() {
  if (backendProcess || backendStarting) return Promise.resolve();
  backendStarting = true;

  return (async () => {
    // Make sure backend source is available in userData (not just in the
    // volatile resourcesPath).
    syncBackendSource();

    // Provision media-generation prerequisites before launching the backend:
    //   1. .z-ai-config — required by the ZAI SDK for image generation
    //   2. ffmpeg.exe   — required by wav2lip_runner for video generation
    //   3. NODE_BIN     — points Python to Electron's bundled Node for the
    //                     gen_character_worker.js subprocess
    provisionMediaDeps();

    const py = getVenvPython();
    if (!fs.existsSync(py)) {
      backendStarting = false;
      throw new Error("Python مش موجود. شغّل تثبيت Python الأول. (الاتجول على: " + py + ")");
    }
    if (!fs.existsSync(path.join(BACKEND_SRC_DIR, "server.py"))) {
      backendStarting = false;
      throw new Error("server.py مش موجود في: " + BACKEND_SRC_DIR + " — حاول تنصيب التطبيق من جديد.");
    }

    // CRITICAL: Auto-fix numpy<2 BEFORE launching the backend.
    // This is the "one-time fix" that runs automatically on every launch —
    // if numpy>=2 is detected (e.g. from an old v1.1.2 install that ran the
    // broken installer without numpy pinning), it force-reinstalls numpy<2.
    // Idempotent: if numpy is already <2, this is a no-op (just an import check).
    // This was the root cause of the "NumPy 2.x cannot run torch compiled
    // against NumPy 1.x" warning that made the user keep reinstalling.
    try {
      await checkAndFixNumpy(py);
    } catch (e) {
      log("[startBackend] checkAndFixNumpy warning:", e.message, "(continuing anyway)");
      sendBackendLog("[launch] ⚠️ تعذّر فحص numpy: " + e.message + " (هكمل بعدها)");
    }

    return new Promise((resolve, reject) => {
    // CRITICAL: Kill any stale python.exe that's still holding port 8000.
    // This happens when:
    //   - The app crashed previously and left a python.exe zombie
    //   - The user quit the app but the OS hasn't reaped the child process yet
    //   - Another instance of the app is already running
    // Without this, uvicorn fails with:
    //   ERROR: [Errno 10048] error while attempting to bind on address
    //   ('0.0.0.0', 8000): only one usage of each socket address
    // and the backend crashes with exit code 1.
    sendBackendLog("[launch] فحص البورت 8000...");
    const portFreed = killProcessesOnPort(BACKEND_PORT);
    if (portFreed > 0) {
      log(`[startBackend] Killed ${portFreed} stale process(es) on port ${BACKEND_PORT}`);
      sendBackendLog(`[launch] ⚠️ تم قتل ${portFreed} process معلّق على البورت ${BACKEND_PORT}`);
      // Give the OS a moment to actually free the port
      try { require("child_process").execSync("timeout /t 2 /nobreak >nul 2>&1 || sleep 2", { stdio: "ignore" }); } catch {}
    }

    log("Starting backend:", py, "server.py", "cwd=" + BACKEND_SRC_DIR);
    sendBackendLog("[launch] Starting Python backend...");
    sendBackendLog("[launch] Python: " + py);
    sendBackendLog("[launch] cwd: " + BACKEND_SRC_DIR);
    sendBackendLog("[launch] ملاحظة: تحميل نماذج الـ AI ممكن ياخد 1-3 دقايق، استنى...");

    // Resolve the bundled ffmpeg binary path.
    // When packaged: process.resourcesPath/bin/ffmpeg.exe
    // When dev:      desktop/node_modules/ffmpeg-static/ffmpeg
    const bundledFfmpeg = IS_PACKAGED
      ? path.join(RESOURCES_PATH, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
      : path.join(__dirname, "..", "node_modules", "ffmpeg-static", "ffmpeg");
    const ffmpegPath = fs.existsSync(bundledFfmpeg) ? bundledFfmpeg : "";

    // Compute the absolute path to a Node binary that the Python backend can
    // spawn for gen_character_worker.js. We use Electron's own executable
    // with ELECTRON_RUN_AS_NODE=1 — this guarantees a Node runtime is
    // available even on user machines that don't have Node.js installed.
    const nodeBinPath = process.execPath;

    backendProcess = spawn(py, ["server.py"], {
      cwd: BACKEND_SRC_DIR,
      env: {
        ...process.env,
        // Force Python to flush stdout so we can read logs in real-time
        PYTHONUNBUFFERED: "1",
        // Add the Wav2Lip dir to PYTHONPATH so wav2lip_runner can find it
        PYTHONPATH: WAV2LIP_DIR + path.delimiter + (process.env.PYTHONPATH || ""),
        // Bundled ffmpeg path — wav2lip_runner.py reads this env var and
        // uses it as the ffmpeg binary instead of relying on PATH.
        WAV2LIP_FFMPEG_PATH: ffmpegPath,
        FFMPEG_PATH: ffmpegPath,
        // Path to a Node binary for spawning gen_character_worker.js.
        // server.py reads this and falls back to "node" if unset.
        TCS_NODE_BIN: nodeBinPath,
        // When set, Electron's executable behaves as a plain Node.js runtime,
        // which is what we want when Python spawns it for the worker script.
        ELECTRON_RUN_AS_NODE: "1",
        // Make sure the bundled backend/node_modules is on NODE_PATH so
        // `require('z-ai-web-dev-sdk')` resolves inside the worker.
        NODE_PATH: path.join(BACKEND_SRC_DIR, "node_modules"),
      },
      windowsHide: true,
    });

    backendProcess.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        log("[py:stdout]", text);
        sendBackendLog("[py] " + text);
      }
    });
    backendProcess.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        log("[py:stderr]", text);
        sendBackendLog("[py:err] " + text);
      }
    });
    backendProcess.on("exit", (code) => {
      log("Backend exited with code", code);
      sendBackendLog("[launch] Backend exited with code " + code);
      backendProcess = null;
      backendStarting = false;
      if (code !== 0 && code !== null) {
        reject(new Error("Backend crashed with exit code " + code + ". شوف الـ log فوق علشان التفاصيل."));
      }
    });
    backendProcess.on("error", (err) => {
      log("Backend spawn error:", err);
      sendBackendLog("[launch] Spawn error: " + err.message);
      backendStarting = false;
      reject(err);
    });

    // Wait for /health to respond.
    // CRITICAL: timeout is 5 MINUTES, not 60 seconds. The backend pre-loads
    // the Wav2Lip model (~415MB) on startup, which can take 1-3 minutes on a
    // regular CPU. The previous 60s timeout was the root cause of the
    // "Backend health check timed out" error.
    const start = Date.now();
    const timeoutMs = 5 * 60 * 1000; // 5 minutes
    let lastProgressAt = start;
    const check = () => {
      const req = http.get(`${BACKEND_URL}/health`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode === 200) {
            log("Backend is healthy:", body);
            sendBackendLog("[launch] ✓ Backend is healthy!");
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
      const elapsed = Date.now() - start;
      if (elapsed > timeoutMs) {
        backendStarting = false;
        const msg = "Backend health check timed out after 5min. السبب الأرجح: تحميل نماذج الـ AI بطيء جدًا، أو Python crashed. شوف الـ log فوق.";
        sendBackendLog("[launch] ✗ " + msg);
        reject(new Error(msg));
        return;
      }
      // Every 15 seconds, send a heartbeat so the user knows we're still alive
      if (Date.now() - lastProgressAt > 15_000) {
        const secs = Math.floor(elapsed / 1000);
        sendBackendLog(`[launch] ...ليها ${secs}s — لسه مستني الـ backend يبدأ (ممكن ياخد لـ 5 دقايق)`);
        lastProgressAt = Date.now();
      }
      setTimeout(check, 1500);
    };
    setTimeout(check, 2000);
    });
  })().catch((e) => {
    backendStarting = false;
    throw e;
  });
}

/**
 * Detect if the installed numpy is >=2 and, if so, force-reinstall numpy<2.
 *
 * This runs on EVERY backend launch (idempotent — if numpy is already <2,
 * it's a fast `python -c "import numpy; print(...)"` check that takes <1s).
 *
 * Why: torch 2.2.2 is compiled against numpy 1.x. If numpy 2.x is installed
 * (which happens when an old installer ran without the numpy<2 pin), torch
 * prints a scary warning at import time:
 *   "A module that was compiled using NumPy 1.x cannot be run in NumPy 2.x"
 * and may crash. The user reported having to reinstall repeatedly because of
 * this. Running the fix automatically on launch means the user never has to
 * manually delete the python/ folder or re-run the installer.
 *
 * @param {string} venvPy — path to venv's python.exe
 * @returns {Promise<{fixed: boolean, oldVersion?: string, newVersion?: string}>}
 */
async function checkAndFixNumpy(venvPy) {
  if (!venvPy || !fs.existsSync(venvPy)) {
    return { fixed: false };
  }

  // CACHE: Skip the check if we already verified numpy<2 in this app
  // version. The check requires spawning Python and importing numpy,
  // which takes 2-5 seconds on a cold start. On every subsequent launch
  // in the same version, we just read a marker file (<1ms).
  //
  // The marker is invalidated automatically when the app version changes
  // (so a new release always re-checks once), OR when the user manually
  // clicks "🔧 إصلاح NumPy" (which calls checkAndFixNumpy(true) to bypass
  // the cache).
  const markerPath = path.join(BACKEND_SRC_DIR, ".numpy-verified");
  const expectedMarker = `${app.getVersion()}:<2`;
  try {
    const existing = fs.readFileSync(markerPath, "utf8").trim();
    if (existing === expectedMarker) {
      log(`[checkAndFixNumpy] Cache hit — numpy already verified <2 in v${app.getVersion()}`);
      return { fixed: false, cached: true, version: "cached<2" };
    }
    log(`[checkAndFixNumpy] Marker mismatch (was: '${existing}', expected: '${expectedMarker}') — re-checking`);
  } catch {
    log("[checkAndFixNumpy] No cache marker — running full check");
  }

  // Step 1: Check current numpy version.
  let currentVersion = "";
  try {
    const result = spawnSync(venvPy, ["-c", "import numpy; print(numpy.__version__)"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 15000,
    });
    currentVersion = ((result.stdout || "") + (result.stderr || "")).trim().split(/\r?\n/)[0].trim();
  } catch (e) {
    log("[checkAndFixNumpy] Could not check numpy version:", e.message);
    return { fixed: false, error: e.message };
  }

  // If we couldn't even import numpy, nothing to fix (the installer will
  // handle it on next installPipDeps run).
  if (!currentVersion || !/^\d+\.\d+/.test(currentVersion)) {
    log("[checkAndFixNumpy] numpy not yet installed or import failed — skipping (will be installed by installer).");
    return { fixed: false };
  }

  // Parse major version.
  const major = parseInt(currentVersion.split(".")[0], 10);
  log(`[checkAndFixNumpy] numpy version: ${currentVersion} (major=${major})`);

  if (major < 2) {
    // Already fine — no action needed. Write the cache marker so the next
    // launch can skip the import check entirely (saves 2-5s on every launch).
    try {
      fs.writeFileSync(markerPath, expectedMarker);
      log(`[checkAndFixNumpy] Wrote cache marker: ${expectedMarker}`);
    } catch (e) {
      log(`[checkAndFixNumpy] Could not write cache marker: ${e.message}`);
    }
    return { fixed: false, oldVersion: currentVersion };
  }

  // Step 2: numpy>=2 detected — force reinstall numpy<2.
  log(`[checkAndFixNumpy] numpy ${currentVersion} >= 2.0 detected. Force-reinstalling numpy<2...`);
  sendBackendLog(`[launch] ⚠️ numpy ${currentVersion} غير متوافق مع torch. جاري تثبيت numpy<2...`);

  // Use spawnAsync from installer-python so we get live stdout/stderr logging.
  const { spawnAsync } = require("./installer-python");
  try {
    await spawnAsync(
      venvPy,
      ["-m", "pip", "install", "--force-reinstall", "--no-deps", "numpy<2"],
      {
        onStdout: (s) => log("[numpy-fix] " + s.trim()),
        onStderr: (s) => log("[numpy-fix:err] " + s.trim()),
      }
    );
  } catch (e) {
    log("[checkAndFixNumpy] Force-reinstall failed:", e.message);
    sendBackendLog(`[launch] ✗ تعذّر تثبيت numpy<2: ${e.message}`);
    return { fixed: false, oldVersion: currentVersion, error: e.message };
  }

  // Step 3: Verify the new version.
  let newVersion = "";
  try {
    const verify = spawnSync(venvPy, ["-c", "import numpy; print(numpy.__version__)"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 15000,
    });
    newVersion = ((verify.stdout || "") + (verify.stderr || "")).trim().split(/\r?\n/)[0].trim();
  } catch {}

  log(`[checkAndFixNumpy] numpy after fix: ${newVersion}`);
  sendBackendLog(`[launch] ✓ numpy اتثبت بنجاح: ${currentVersion} → ${newVersion}`);

  // Step 4: If the new version is <2, write the cache marker so the next
  // launch can skip this entire fix (saves ~30s on the next launch).
  const newMajor = newVersion ? parseInt(newVersion.split(".")[0], 10) : 99;
  if (newMajor < 2) {
    try {
      fs.writeFileSync(markerPath, expectedMarker);
      log(`[checkAndFixNumpy] Wrote cache marker after fix: ${expectedMarker}`);
    } catch (e) {
      log(`[checkAndFixNumpy] Could not write cache marker after fix: ${e.message}`);
    }
  }

  return { fixed: true, oldVersion: currentVersion, newVersion };
}

/**
 * Manual numpy fix — bypasses the cache so the user can force a re-check
 * even if the marker says we're already OK (e.g. they manually upgraded
 * numpy to 2.x after the auto-fix ran).
 */
async function forceFixNumpy(venvPy) {
  const markerPath = path.join(BACKEND_SRC_DIR, ".numpy-verified");
  try { fs.unlinkSync(markerPath); } catch {}
  return checkAndFixNumpy(venvPy);
}

/**
 * Kill any process listening on the given TCP port.
 *
 * Cross-platform:
 *   Windows: netstat -ano | findstr :<port>  → taskkill /PID <pid> /F
 *   Unix:    lsof -ti :<port> | xargs kill -9
 *
 * Returns the number of processes killed. Returns 0 if the port was free
 * or if we couldn't determine the PID (no error raised — best-effort).
 *
 * This is called BEFORE spawning the Python backend to ensure uvicorn can
 * bind to port 8000 without hitting "[Errno 10048] only one usage of each
 * socket address" — a common failure when a previous python.exe is still
 * running as a zombie after a crash.
 */
function killProcessesOnPort(port) {
  try {
    if (process.platform === "win32") {
      // Windows: use netstat to find PIDs, then taskkill them.
      // Output of `netstat -ano | findstr :8000` looks like:
      //   TCP    0.0.0.0:8000      0.0.0.0:0    LISTENING    12345
      //   TCP    [::]:8000         [::]:0       LISTENING    12345
      const result = spawnSync("cmd.exe", ["/c", `netstat -ano | findstr :${port}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      });
      const out = (result.stdout || "");
      if (!out.trim()) {
        log(`[killPort] Port ${port} is free`);
        return 0;
      }
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // Match the PID in the last column
        const m = line.match(/\s+(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      let killed = 0;
      for (const pid of pids) {
        if (pid === "0") continue;
        log(`[killPort] Killing PID ${pid} on port ${port}`);
        try {
          spawnSync("taskkill", ["/PID", pid, "/F"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            timeout: 5000,
          });
          killed++;
        } catch (e) {
          log(`[killPort] Failed to kill PID ${pid}:`, e.message);
        }
      }
      return killed;
    } else {
      // Unix: lsof -ti :<port> prints PIDs
      const result = spawnSync("sh", ["-c", `lsof -ti :${port} 2>/dev/null`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      const out = (result.stdout || "").trim();
      if (!out) {
        log(`[killPort] Port ${port} is free`);
        return 0;
      }
      const pids = out.split(/\s+/).filter(Boolean);
      let killed = 0;
      for (const pid of pids) {
        log(`[killPort] Killing PID ${pid} on port ${port}`);
        try {
          process.kill(parseInt(pid, 10), "SIGKILL");
          killed++;
        } catch (e) {
          log(`[killPort] Failed to kill PID ${pid}:`, e.message);
        }
      }
      return killed;
    }
  } catch (e) {
    log(`[killPort] Failed to check port ${port}:`, e.message);
    return 0;
  }
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
    // CRITICAL: Show the installer window IMMEDIATELY in "launching" mode
    // so the user sees progress while the backend starts up (1-3 minutes
    // for Wav2Lip model pre-loading). Previously, NO window was visible
    // during this period — the user thought the app was frozen / not
    // opening, and would complain "بيخد وقت فى الفتح كتير".
    log("Already installed. Showing launching window + starting backend...");
    createInstallerWindow();

    // Tell the installer window it's in "auto-launch" mode (hide install
    // button, show launching message). Wait for the page to finish loading
    // before sending the mode signal, otherwise the renderer's IPC listener
    // won't be registered yet.
    if (installerWindow) {
      installerWindow.webContents.once("did-finish-load", () => {
        installerWindow.webContents.send("launcher:autoLaunch");
      });
    }

    try {
      await startBackend();
      // Backend is healthy — close the launching window and open the main PWA.
      if (installerWindow) {
        try { installerWindow.close(); } catch {}
        installerWindow = null;
      }
      createMainWindow();
    } catch (e) {
      log("Failed to start backend:", e);
      // Keep the installer window open — the user can see the error in the
      // log panel and use the recovery buttons (resync / kill-port / fix-numpy).
      // The buttons auto-appear after a launch failure (already implemented
      // in installer.html's launchApp() error handler).
      // Trigger the same UI by sending an autoLaunchFailed event.
      if (installerWindow && !installerWindow.isDestroyed()) {
        try {
          installerWindow.webContents.send("launcher:autoLaunchFailed", {
            error: String(e?.message || e),
          });
        } catch {}
      }
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

// Forward backend stdout/stderr lines to the installer window so the user can
// see what the Python backend is doing during launch (e.g. "Loading model...",
// "Starting server on port 8000..."). Without this, the launch appears frozen
// for 1-3 minutes while the Wav2Lip model loads.
//
// Also broadcasts to ALL windows (including the PWA main window) so the PWA
// can show what's happening if the user opens the diagnostic panel.
function sendBackendLog(line) {
  const payload = { line, ts: Date.now() };
  if (installerWindow && !installerWindow.isDestroyed()) {
    installerWindow.webContents.send("installer:backendLog", payload);
  }
  // Broadcast to all windows (including PWA) so the renderer can subscribe via window.backend.onLog
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== installerWindow && !win.isDestroyed()) {
      win.webContents.send("backend:log", payload);
    }
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

// ---------------------------------------------------------------------------
// Auto-update IPC handlers (see desktop/src/updater.js)
// ---------------------------------------------------------------------------

const { initUpdater, checkForUpdatesAfterDelay } = require("./updater");
initUpdater(log);

// ---------------------------------------------------------------------------
// Backend lifecycle IPC — restart + status
// Lets the PWA restart the local Python backend when it crashes (OOM during
// heavy lip-sync) instead of forcing the user to quit and relaunch the app.
// ---------------------------------------------------------------------------

ipcMain.handle("backend:restart", async () => {
  log("[IPC] backend:restart invoked");
  try {
    if (backendProcess) {
      log("[backend:restart] Stopping current backend...");
      stopBackend();
      // Give the OS a moment to free port 8000
      await new Promise((r) => setTimeout(r, 1500));
    }
    log("[backend:restart] Starting backend (fire-and-forget)...");
    // IMPORTANT: We do NOT await startBackend() here. The old code did
    // `await startBackend()`, which blocked the IPC call for 1-3 minutes
    // (until /health responded). That caused the renderer's elapsed-seconds
    // timer to stay stuck at 0 — because the renderer's `waitForBackend()`
    // only runs AFTER the IPC returns.
    //
    // Now we just kick off startBackend() in the background and return
    // immediately. The renderer polls /health itself and detects when the
    // backend is ready.
    startBackend().catch((e) => {
      log("[backend:restart] Background startBackend FAILED:", e);
      sendBackendLog("[launch] ✗ " + (e?.message || String(e)));
    });
    return { success: true };
  } catch (e) {
    log("[backend:restart] FAILED:", e);
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle("backend:status", async () => {
  return {
    running: !!backendProcess,
    starting: backendStarting,
    port: BACKEND_PORT,
    pid: backendProcess ? backendProcess.pid : null,
    venvInstalled: isVenvInstalled(),
    wav2lipInstalled: isWav2LipInstalled(),
    fullyInstalled: isFullyInstalled(),
    backendSrc: BACKEND_SRC_DIR,
    logFile: LOG_FILE,
    logDir: LOG_DIR,
  };
});

/**
 * Force-kill any process holding the backend port, then restart.
 * Use this when 'backend:restart' fails because a zombie python.exe is
 * still attached to port 8000.
 */
ipcMain.handle("backend:killPortAndRestart", async () => {
  log("[IPC] backend:killPortAndRestart invoked");
  try {
    if (backendProcess) {
      log("[backend:killPortAndRestart] Stopping current backend...");
      stopBackend();
      await new Promise((r) => setTimeout(r, 1500));
    }
    const killed = killProcessesOnPort(BACKEND_PORT);
    log(`[backend:killPortAndRestart] Killed ${killed} process(es) on port ${BACKEND_PORT}`);
    if (killed > 0) {
      // Wait for the OS to actually free the port
      await new Promise((r) => setTimeout(r, 2000));
    }
    log("[backend:killPortAndRestart] Starting backend...");
    await startBackend();
    return { success: true, killedProcesses: killed };
  } catch (e) {
    log("[backend:killPortAndRestart] FAILED:", e);
    return { success: false, error: String(e?.message || e) };
  }
});

/**
 * Force re-sync of backend source from the bundled copy.
 * Useful when the backend is crashing due to a stale/older server.py from
 * a previous app version. Deletes the .synced-from marker so the next
 * syncBackendSource() call copies everything fresh.
 */
ipcMain.handle("backend:resync", async () => {
  log("[IPC] backend:resync invoked — forcing fresh backend source sync");
  try {
    const markerPath = path.join(BACKEND_SRC_DIR, ".synced-from");
    try { fs.unlinkSync(markerPath); } catch {}
    // Also remove old .pyc files in case Python cached bytecode for the old server.py
    function removePyc(dir) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === "__pycache__") {
            try { fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true }); } catch {}
            continue;
          }
          if (entry.isDirectory()) removePyc(path.join(dir, entry.name));
        }
      } catch {}
    }
    removePyc(BACKEND_SRC_DIR);
    const ok = syncBackendSource();
    return { success: ok, backendSrc: BACKEND_SRC_DIR };
  } catch (e) {
    log("[backend:resync] FAILED:", e);
    return { success: false, error: String(e?.message || e) };
  }
});

/**
 * Manually trigger the numpy<2 fix.
 * This is the same check that runs automatically on every backend launch —
 * exposed as an IPC handler so the user can manually fix numpy if they
 * suspect the auto-fix didn't run (e.g. if the backend crashed before the
 * check ran, or if they manually upgraded numpy).
 *
 * Returns { success, fixed, oldVersion?, newVersion?, error? }.
 * fixed=true means numpy>=2 was detected and downgraded to <2.
 * fixed=false means numpy was already <2 (no action needed), or the check failed.
 */
ipcMain.handle("backend:fixNumpy", async () => {
  log("[IPC] backend:fixNumpy invoked — manual numpy<2 fix (bypassing cache)");
  try {
    const py = getVenvPython();
    if (!fs.existsSync(py)) {
      return { success: false, error: "Python مش موجود. شغّل تثبيت Python الأول." };
    }
    // Use forceFixNumpy (bypasses cache) so the manual button always re-checks.
    const result = await forceFixNumpy(py);
    return { success: true, ...result };
  } catch (e) {
    log("[backend:fixNumpy] FAILED:", e);
    return { success: false, error: String(e?.message || e) };
  }
});

// After the app is ready, kick off a background update check (non-blocking —
// the user sees a banner only if an update exists).
app.whenReady().then(() => {
  checkForUpdatesAfterDelay(8000);
});
