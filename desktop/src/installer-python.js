/**
 * installer-python.js
 *
 * Heavy lifting for the install flow:
 *   installPython()   → download Python embeddable (Win) / use system Python (Mac),
 *                       then create a venv
 *   installPipDeps()  → pip install torch + opencv + fastapi + ... + edge-tts
 *   installWav2Lip()  → git clone Wav2Lip (or download ZIP), download wav2lip_gan.pth,
 *                       patch librosa
 *
 * Each function accepts { ..., sendProgress, log } and calls
 * sendProgress(stage, percent, message) to push UI updates.
 *
 * Returns { success: boolean, error?: string }.
 *
 * CRITICAL FIXES (v2):
 *   - Use tar.exe (built into Windows 10 1803+) for zip extraction instead of
 *     PowerShell Expand-Archive. PowerShell's quoting breaks when paths contain
 *     non-ASCII characters (e.g. the Arabic app name in userData dir).
 *   - Properly configure embedded Python ._pth: add Lib\site-packages AND
 *     Lib to the path. Without this, `python -m pip` fails even after
 *     get-pip.py runs.
 *   - Add fallback for git clone: download Wav2Lip ZIP from GitHub directly.
 *     Many Windows users don't have git in PATH.
 *   - Add timeouts to network operations (download, pip install) so they
 *     don't hang forever.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile, execFileSync, spawnSync } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// Logging to file — so we can debug even if the UI doesn't show the error
// ---------------------------------------------------------------------------

let LOG_FILE_PATH = null;

function setLogFilePath(p) {
  LOG_FILE_PATH = p;
}

function logToFile(msg) {
  if (!LOG_FILE_PATH) return;
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE_PATH, line);
  } catch {
    // ignore — log file is best-effort
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a command exists in PATH (returns true/false). */
function commandExists(cmd) {
  try {
    const isWin = process.platform === "win32";
    const checker = isWin ? "where" : "which";
    const result = spawnSync(checker, [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Promise-wrapper around spawn that streams stdout/stderr to `log`. */
function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => {
      const s = c.toString();
      stdout += s;
      opts.onStdout && opts.onStdout(s);
    });
    proc.stderr.on("data", (c) => {
      const s = c.toString();
      stderr += s;
      opts.onStderr && opts.onStderr(s);
    });
    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn '${cmd}': ${err.message}`));
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (exit ${code}): ${cmd} ${args.join(" ")}\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Find a usable system Python 3.x binary.
 *
 * IMPORTANT: Python 3.4+ prints `--version` to STDERR, not stdout.
 * Also, on Windows, `python.exe` may be a Microsoft Store stub that
 * prints nothing — we need to detect that case and skip it.
 *
 * Returns the command (as a string, possibly with spaces for args like
 * "py.exe -3") or null if no Python 3.x is found.
 */
function findSystemPython() {
  const candidates =
    process.platform === "win32"
      ? ["py.exe -3", "python.exe", "python3.exe"]
      : ["python3", "python"];

  for (const c of candidates) {
    try {
      const parts = c.split(" ");
      const result = spawnSync(
        parts[0],
        parts.slice(1).concat(["--version"]),
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 5000,
        }
      );
      const combined = (result.stdout || "") + (result.stderr || "");
      if (/Python 3\.\d+/.test(combined)) {
        return c;
      }
    } catch {}
  }
  return null;
}

function getPythonVersion(cmd) {
  try {
    const parts = cmd.split(" ");
    const result = spawnSync(
      parts[0],
      parts.slice(1).concat(["--version"]),
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5000,
      }
    );
    return (result.stdout || "").trim() + (result.stderr || "").trim();
  } catch {
    return "(unknown)";
  }
}

/**
 * Download a URL to a file path. Reports progress via onProgress(received, total).
 * Follows redirects. Has a default 5-minute timeout.
 */
function downloadFile(url, dest, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let received = 0;
    let total = 0;
    const startedAt = Date.now();
    const maxTimeout = timeoutMs || 5 * 60 * 1000; // 5 min default

    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        const next = new URL(res.headers.location, url).toString();
        return downloadFile(next, dest, onProgress, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      total = parseInt(res.headers["content-length"] || "0", 10);
      res.on("data", (chunk) => {
        received += chunk.length;
        onProgress && onProgress(received, total);
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (e) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(e);
      });
    };

    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, handle);
    req.on("error", (e) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
    req.setTimeout(maxTimeout, () => {
      req.destroy(new Error(`Download timed out after ${maxTimeout/1000}s: ${url}`));
    });
  });
}

/**
 * Extract a .zip to a directory.
 *
 * CRITICAL FIX: Use `extract-zip` (pure Node.js, no system dependencies) as
 * the PRIMARY extraction method. This eliminates ALL issues with:
 *   - tar.exe not being available (Windows 7/8)
 *   - tar.exe not being able to extract .zip (Linux GNU tar)
 *   - PowerShell Expand-Archive failing on non-ASCII paths (Arabic app name)
 *   - System tool availability
 *
 * Falls back to tar.exe / PowerShell / unzip only if extract-zip fails.
 */
async function extractZip(zipPath, destDir, log) {
  fs.mkdirSync(destDir, { recursive: true });
  const absDestDir = path.resolve(destDir);
  const absZipPath = path.resolve(zipPath);

  // Method 1: extract-zip (pure Node.js) — ALWAYS works, no system deps
  try {
    log && log("[extractZip] Using extract-zip (Node.js native)");
    const extract = require("extract-zip");
    await extract(absZipPath, { dir: absDestDir });
    log && log("[extractZip] extract-zip succeeded");
    return;
  } catch (e) {
    log && log("[extractZip] extract-zip failed: " + e.message + " — trying system tools");
    logToFile("[extractZip] extract-zip failed: " + (e?.stack || e));
  }

  // Method 2: tar.exe (Windows 10 1803+ has bsdtar which CAN extract zip)
  if (process.platform === "win32" && (commandExists("tar.exe") || commandExists("tar"))) {
    log && log("[extractZip] Trying tar.exe");
    try {
      await spawnAsync("tar.exe", ["-xf", absZipPath, "-C", absDestDir], {
        windowsHide: true,
      });
      return;
    } catch (e) {
      log && log("[extractZip] tar.exe failed: " + e.message);
    }
  }

  // Method 3: PowerShell Expand-Archive (Windows)
  if (process.platform === "win32") {
    log && log("[extractZip] Trying PowerShell Expand-Archive");
    const psScript = `Expand-Archive -LiteralPath '${absZipPath}' -DestinationPath '${absDestDir}' -Force`;
    try {
      await spawnAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-Command", psScript,
      ]);
      return;
    } catch (e) {
      log && log("[extractZip] PowerShell failed: " + e.message);
    }
  }

  // Method 4: unzip (Mac/Linux)
  if (process.platform !== "win32") {
    if (commandExists("unzip")) {
      log && log("[extractZip] Trying unzip");
      await spawnAsync("unzip", ["-o", absZipPath, "-d", absDestDir]);
      return;
    }
    if (commandExists("tar")) {
      log && log("[extractZip] Trying tar (BSD/Mac)");
      await spawnAsync("tar", ["-xf", absZipPath, "-C", absDestDir]);
      return;
    }
  }

  // All methods failed
  throw new Error(
    "فشل فك ضغط الملف بكل الطرق المتاحة.\n" +
    "الملف: " + absZipPath + "\n" +
    "الوجهة: " + absDestDir + "\n" +
    "جرب تشغيل البرنامج كمسؤول أو تواصل مع الدعم."
  );
}

// ---------------------------------------------------------------------------
// installPython
// ---------------------------------------------------------------------------

async function installPython({ PYTHON_DIR, VENV_DIR, sendProgress, log }) {
  try {
    fs.mkdirSync(PYTHON_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });

    sendProgress && sendProgress("python", 5, "البحث عن Python...");
    log("[installPython] PYTHON_DIR=" + PYTHON_DIR);
    log("[installPython] VENV_DIR=" + VENV_DIR);
    logToFile("[installPython] start. PYTHON_DIR=" + PYTHON_DIR);

    let pythonExe = null;
    let useEmbedded = false;

    // Try system Python first
    pythonExe = findSystemPython();
    if (pythonExe) {
      log("[installPython] Found system Python: " + pythonExe + " " + getPythonVersion(pythonExe));
      logToFile("[installPython] using system python: " + pythonExe);
    } else if (process.platform === "win32") {
      // Windows without system Python → download embeddable + bootstrap pip
      log("[installPython] No system Python. Downloading embeddable Python...");
      logToFile("[installPython] downloading embeddable python");
      useEmbedded = true;

      sendProgress && sendProgress("python", 10, "تحميل Python embedded (~10MB)...");
      const pyVersion = "3.11.9";
      const pyUrl = `https://www.python.org/ftp/python/${pyVersion}/python-${pyVersion}-embed-amd64.zip`;
      const zipPath = path.join(PYTHON_DIR, "python-embed.zip");

      await downloadFile(pyUrl, zipPath, (r, t) => {
        if (t) {
          const pct = 10 + Math.floor((r / t) * 30);
          const mbDone = Math.floor(r / 1024 / 1024);
          const mbTotal = Math.floor(t / 1024 / 1024);
          sendProgress && sendProgress("python", pct, `تحميل Python... ${mbDone}MB / ${mbTotal}MB`);
        }
      }, 5 * 60 * 1000); // 5 min timeout

      log("[installPython] Downloaded, extracting...");
      sendProgress && sendProgress("python", 45, "فك ضغط Python...");
      await extractZip(zipPath, PYTHON_DIR, log);
      try { fs.unlinkSync(zipPath); } catch {}

      // Verify python.exe exists
      const embeddedPython = path.join(PYTHON_DIR, "python.exe");
      if (!fs.existsSync(embeddedPython)) {
        throw new Error(`python.exe مش موجود بعد فك الضغط. اتحقق من: ${PYTHON_DIR}`);
      }
      log("[installPython] python.exe found at: " + embeddedPython);

      // CRITICAL FIX: Properly configure ._pth file.
      // The embeddable Python's ._pth file restricts sys.path to ONLY the
      // entries listed in it. Just uncommenting "import site" is NOT enough —
      // we also need to add Lib\site-packages so pip can be found after install.
      const pthFiles = fs.readdirSync(PYTHON_DIR).filter(f => f.endsWith("._pth"));
      log("[installPython] Found ._pth files: " + pthFiles.join(", "));
      for (const pthFile of pthFiles) {
        const pthPath = path.join(PYTHON_DIR, pthFile);
        let content = fs.readFileSync(pthPath, "utf8");
        log("[installPython] Original ._pth content:\n" + content);

        let modified = content;
        // Uncomment "import site"
        if (modified.includes("#import site")) {
          modified = modified.replace("#import site", "import site");
        } else if (!modified.includes("import site")) {
          modified += "\nimport site\n";
        }
        // Add Lib\site-packages and Lib to the path (so pip works)
        if (!modified.includes("Lib\\site-packages") && !modified.includes("Lib/site-packages")) {
          modified += "\nLib\\site-packages\n";
        }
        if (!modified.includes("\nLib\n") && !modified.includes("\nLib\\") && !modified.includes("Lib\n")) {
          modified += "\nLib\n";
        }
        if (modified !== content) {
          fs.writeFileSync(pthPath, modified);
          log("[installPython] Updated ._pth content:\n" + modified);
          logToFile("[installPython] patched ._pth: " + pthFile);
        }
      }

      // Download get-pip.py and run it to bootstrap pip
      sendProgress && sendProgress("python", 55, "تثبيت pip...");
      log("[installPython] Downloading get-pip.py...");
      const getPipUrl = "https://bootstrap.pypa.io/get-pip.py";
      const getPipPath = path.join(PYTHON_DIR, "get-pip.py");
      await downloadFile(getPipUrl, getPipPath, null, 3 * 60 * 1000); // 3 min timeout

      log("[installPython] Running get-pip.py...");
      // Use just the filename since cwd is PYTHON_DIR — avoids path issues
      // with backslashes/forward-slashes in args on Windows
      const getPipName = path.basename(getPipPath);
      await spawnAsync(embeddedPython, [getPipName, "--no-warn-script-location"], {
        cwd: PYTHON_DIR,
        onStdout: (s) => { log("[get-pip] " + s.trim()); logToFile("[get-pip] " + s.trim()); },
        onStderr: (s) => { log("[get-pip:err] " + s.trim()); logToFile("[get-pip:err] " + s.trim()); },
      });

      // Try to clean up get-pip.py (best effort)
      try { fs.unlinkSync(getPipPath); } catch {}

      // Verify pip works
      log("[installPython] Verifying pip...");
      const pipCheck = spawnSync(embeddedPython, ["-m", "pip", "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 15000,
      });
      const pipVersion = ((pipCheck.stdout || "") + (pipCheck.stderr || "")).trim();
      log("[installPython] pip check output: " + pipVersion);
      logToFile("[installPython] pip version: " + pipVersion);

      if (!pipVersion.toLowerCase().includes("pip")) {
        throw new Error(
          "pip ماتثبتش صح في الـ embedded Python.\n" +
          "Output: " + pipVersion + "\n" +
          "Exit code: " + pipCheck.status
        );
      }
      log("[installPython] pip installed: " + pipVersion);

      pythonExe = embeddedPython;

      // For embedded Python, we use it directly (no venv). Write a marker.
      fs.writeFileSync(path.join(PYTHON_DIR, "USE_EMBEDDED.txt"), "1");

      sendProgress && sendProgress("python", 95, "Python + pip جاهز ✓");
    } else {
      // Mac/Linux without python3
      throw new Error(
        "Python 3 مش موجود. ثبّته من brew install python (Mac) أو apt install python3 (Linux)."
      );
    }

    // Create venv only if we're using system Python (not embedded)
    if (!useEmbedded) {
      sendProgress && sendProgress("python", 60, "إنشاء البيئة الافتراضية (venv)...");
      const pyParts = pythonExe.split(" ");
      await spawnAsync(pyParts[0], pyParts.slice(1).concat([
        "-m",
        "venv",
        "--system-site-packages",
        VENV_DIR,
      ]), {
        onStdout: (s) => log("[venv] " + s.trim()),
        onStderr: (s) => log("[venv:err] " + s.trim()),
      });

      sendProgress && sendProgress("python", 80, "تحديث pip...");
      const venvPy = path.join(
        VENV_DIR,
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python"
      );
      await spawnAsync(venvPy, ["-m", "pip", "install", "--upgrade", "pip"], {
        onStdout: (s) => log("[pip-upgrade] " + s.trim()),
        onStderr: (s) => log("[pip-upgrade:err] " + s.trim()),
      });
    }

    sendProgress && sendProgress("python", 100, "Python جاهز ✓");
    logToFile("[installPython] success");
    return { success: true };
  } catch (e) {
    log("[installPython] FAILED: " + (e?.stack || e));
    logToFile("[installPython] FAILED: " + (e?.stack || e));
    sendProgress && sendProgress("python", -1, `فشل: ${e.message}`);
    return { success: false, error: String(e?.message || e) };
  }
}

function getActivePython(VENV_DIR, PYTHON_DIR) {
  const isWin = process.platform === "win32";
  const venvPy = path.join(
    VENV_DIR,
    isWin ? "Scripts" : "bin",
    isWin ? "python.exe" : "python"
  );
  if (fs.existsSync(venvPy)) return venvPy;

  const embeddedMarker = path.join(PYTHON_DIR || "", "USE_EMBEDDED.txt");
  if (PYTHON_DIR && fs.existsSync(embeddedMarker)) {
    const embPy = path.join(PYTHON_DIR, "python.exe");
    if (fs.existsSync(embPy)) return embPy;
  }

  if (PYTHON_DIR) {
    const legacy = path.join(PYTHON_DIR, "python.exe");
    if (fs.existsSync(legacy)) return legacy;
  }
  return venvPy;
}

// ---------------------------------------------------------------------------
// installPipDeps
// ---------------------------------------------------------------------------

async function installPipDeps({ VENV_DIR, PYTHON_DIR, BACKEND_SRC_DIR, sendProgress, log }) {
  try {
    const venvPy = getActivePython(VENV_DIR, PYTHON_DIR);
    if (!fs.existsSync(venvPy)) {
      throw new Error("Python مش موجود. شغّل تثبيت Python الأول. (الاتجول على: " + venvPy + ")");
    }
    log("[installPipDeps] Using Python: " + venvPy);
    logToFile("[installPipDeps] using python: " + venvPy);

    const packages = [
      "torch==2.2.2",
      "torchvision==0.17.2",
      "torchaudio==2.2.2",
      "opencv-python==4.9.0.80",
      "numpy<2",
      "librosa==0.10.1",
      "tqdm",
      "huggingface_hub",
      "edge-tts",
      "fastapi==0.109.2",
      "uvicorn==0.27.1",
      "python-multipart==0.0.9",
      "mediapipe==0.10.14",
      "Pillow",
      "requests",
    ];

    const chunks = [];
    for (let i = 0; i < packages.length; i += 4) {
      chunks.push(packages.slice(i, i + 4));
    }

    for (let i = 0; i < chunks.length; i++) {
      const pct = Math.floor((i / chunks.length) * 100);
      sendProgress && sendProgress("pip", pct, `تثبيت: ${chunks[i].join(", ")}`);
      log("[installPipDeps] Chunk " + (i+1) + "/" + chunks.length + ": " + chunks[i].join(", "));
      try {
        await spawnAsync(
          venvPy,
          ["-m", "pip", "install", ...chunks[i]],
          {
            onStdout: (s) => log("[pip] " + s.trim()),
            onStderr: (s) => log("[pip:err] " + s.trim()),
          }
        );
      } catch (e) {
        log("[installPipDeps] Chunk failed: " + e.message);
        throw e;
      }
    }

    sendProgress && sendProgress("pip", 100, "كل المكتبات اتثبتت ✓");
    logToFile("[installPipDeps] success");
    return { success: true };
  } catch (e) {
    log("[installPipDeps] FAILED: " + (e?.stack || e));
    logToFile("[installPipDeps] FAILED: " + (e?.stack || e));
    sendProgress && sendProgress("pip", -1, `فشل: ${e.message}`);
    return { success: false, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// installWav2Lip
// ---------------------------------------------------------------------------

async function installWav2Lip({ WAV2LIP_DIR, CKPT_PATH, VENV_DIR, PYTHON_DIR, sendProgress, log }) {
  try {
    const venvPy = getActivePython(VENV_DIR, PYTHON_DIR);
    if (!fs.existsSync(venvPy)) {
      throw new Error("Python مش موجود. شغّل تثبيت Python الأول. (الاتجول على: " + venvPy + ")");
    }
    log("[installWav2Lip] Using Python: " + venvPy);
    logToFile("[installWav2Lip] start. WAV2LIP_DIR=" + WAV2LIP_DIR);

    // Step 1: clone Wav2Lip (or download ZIP if git not available)
    if (fs.existsSync(path.join(WAV2LIP_DIR, "models", "wav2lip.py"))) {
      sendProgress && sendProgress("wav2lip", 10, "Wav2Lip موجود بالفعل، تخطّي...");
      log("[installWav2Lip] Wav2Lip already exists, skipping clone");
    } else {
      sendProgress && sendProgress("wav2lip", 5, "تحميل Wav2Lip من GitHub...");
      fs.mkdirSync(path.dirname(WAV2LIP_DIR), { recursive: true });
      if (fs.existsSync(WAV2LIP_DIR)) {
        fs.rmSync(WAV2LIP_DIR, { recursive: true, force: true });
      }

      // Try git clone first
      let cloned = false;
      if (commandExists("git")) {
        log("[installWav2Lip] Using git clone");
        try {
          await spawnAsync("git", [
            "clone",
            "--depth",
            "1",
            "https://github.com/Rudrabha/Wav2Lip.git",
            WAV2LIP_DIR,
          ], {
            onStdout: (s) => log("[git] " + s.trim()),
            onStderr: (s) => log("[git:err] " + s.trim()),
          });
          cloned = true;
        } catch (e) {
          log("[installWav2Lip] git clone failed: " + e.message + " — falling back to ZIP download");
        }
      } else {
        log("[installWav2Lip] git not in PATH — using ZIP download");
      }

      // Fallback: download ZIP from GitHub
      if (!cloned) {
        sendProgress && sendProgress("wav2lip", 8, "تحميل Wav2Lip كـ ZIP...");
        const zipUrl = "https://github.com/Rudrabha/Wav2Lip/archive/refs/heads/master.zip";
        const zipPath = path.join(path.dirname(WAV2LIP_DIR), "wav2lip-master.zip");
        await downloadFile(zipUrl, zipPath, (r, t) => {
          if (t) {
            const pct = 5 + Math.floor((r / t) * 10);
            sendProgress && sendProgress("wav2lip", pct, `تحميل Wav2Lip ZIP... ${Math.floor(r/1024/1024)}MB`);
          }
        }, 3 * 60 * 1000);

        // Extract to temp dir, then move contents to WAV2LIP_DIR
        const tempExtractDir = path.join(path.dirname(WAV2LIP_DIR), "wav2lip-extract-" + Date.now());
        await extractZip(zipPath, tempExtractDir, log);
        try { fs.unlinkSync(zipPath); } catch {}

        // The ZIP extracts to "Wav2Lip-master/", move its contents to WAV2LIP_DIR
        const extractedSubdir = path.join(tempExtractDir, "Wav2Lip-master");
        if (fs.existsSync(extractedSubdir)) {
          fs.mkdirSync(WAV2LIP_DIR, { recursive: true });
          // Move all contents
          for (const item of fs.readdirSync(extractedSubdir)) {
            fs.renameSync(path.join(extractedSubdir, item), path.join(WAV2LIP_DIR, item));
          }
          try { fs.rmSync(tempExtractDir, { recursive: true, force: true }); } catch {}
        } else {
          throw new Error("Wav2Lip ZIP extract failed: Wav2Lip-master subdir not found in " + tempExtractDir);
        }
        log("[installWav2Lip] Wav2Lip extracted from ZIP to " + WAV2LIP_DIR);
      }

      // Verify
      if (!fs.existsSync(path.join(WAV2LIP_DIR, "models", "wav2lip.py"))) {
        throw new Error("Wav2Lip clone/extract failed: models/wav2lip.py not found in " + WAV2LIP_DIR);
      }
    }

    // Step 2: download checkpoint (~415MB)
    if (fs.existsSync(CKPT_PATH) && fs.statSync(CKPT_PATH).size > 400_000_000) {
      sendProgress && sendProgress("wav2lip", 80, "الـ model موجود بالفعل، تخطّي...");
      log("[installWav2Lip] Checkpoint already exists, skipping");
    } else {
      sendProgress && sendProgress("wav2lip", 20, "تحميل model Wav2Lip (~415MB)...");
      fs.mkdirSync(path.dirname(CKPT_PATH), { recursive: true });

      const script = `
from huggingface_hub import hf_hub_download
import shutil
path = hf_hub_download(
    repo_id="numz/wav2lip_studio",
    filename="Wav2lip/wav2lip_gan.pth",
    repo_type="model",
)
shutil.copy(path, r"${CKPT_PATH.replace(/\\/g, "\\\\")}")
print("DOWNLOADED:", "${CKPT_PATH.replace(/\\/g, "\\\\")}")
`;
      let fakePct = 20;
      const ticker = setInterval(() => {
        fakePct = Math.min(75, fakePct + 1);
        sendProgress && sendProgress("wav2lip", fakePct, `تحميل الـ model... ${fakePct}%`);
      }, 3000);

      try {
        await spawnAsync(venvPy, ["-c", script], {
          onStdout: (s) => log("[hf] " + s.trim()),
          onStderr: (s) => log("[hf:err] " + s.trim()),
        });
      } finally {
        clearInterval(ticker);
      }

      if (!fs.existsSync(CKPT_PATH) || fs.statSync(CKPT_PATH).size < 400_000_000) {
        throw new Error("الـ model ماتحملش صح. حاول تاني. (Path: " + CKPT_PATH + ")");
      }
    }

    // Step 3: patch librosa
    sendProgress && sendProgress("wav2lip", 85, "تعديل Wav2Lip لـ librosa 0.10+...");
    const audioPy = path.join(WAV2LIP_DIR, "audio.py");
    if (fs.existsSync(audioPy)) {
      let text = fs.readFileSync(audioPy, "utf8");
      const old = "librosa.filters.mel(hp.sample_rate, hp.n_fft, n_mels=hp.num_mels,";
      const neu = "librosa.filters.mel(sr=hp.sample_rate, n_fft=hp.n_fft, n_mels=hp.num_mels,";
      if (text.includes(old) && !text.includes(neu)) {
        text = text.replace(old, neu);
        fs.writeFileSync(audioPy, text);
        log("[installWav2Lip] patched audio.py for librosa 0.10+");
      }
    }

    // Step 4: verify (best-effort — don't fail the whole install if verify fails)
    sendProgress && sendProgress("wav2lip", 95, "اختبار التثبيت...");
    try {
      await spawnAsync(
        venvPy,
        ["-c", "import sys; sys.path.insert(0, r'" + WAV2LIP_DIR + "'); import wav2lip_runner; wav2lip_runner._check_wav2lip_available(); print('OK')"],
        {
          cwd: BACKEND_SRC_DIR || undefined,
          env: { ...process.env, PYTHONPATH: WAV2LIP_DIR },
          onStdout: (s) => log("[verify] " + s.trim()),
          onStderr: (s) => log("[verify:err] " + s.trim()),
        }
      );
    } catch (e) {
      log("[installWav2Lip] Verify step failed (non-fatal): " + e.message);
    }

    sendProgress && sendProgress("wav2lip", 100, "Wav2Lip جاهز ✓");
    logToFile("[installWav2Lip] success");
    return { success: true };
  } catch (e) {
    log("[installWav2Lip] FAILED: " + (e?.stack || e));
    logToFile("[installWav2Lip] FAILED: " + (e?.stack || e));
    sendProgress && sendProgress("wav2lip", -1, `فشل: ${e.message}`);
    return { success: false, error: String(e?.message || e) };
  }
}

module.exports = { installPython, installPipDeps, installWav2Lip, downloadFile, spawnAsync, extractZip, commandExists, setLogFilePath };
