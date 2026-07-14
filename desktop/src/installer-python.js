/**
 * installer-python.js
 *
 * Heavy lifting for the install flow:
 *   installPython()   → download Python embeddable (Win) / use system Python (Mac),
 *                       then create a venv
 *   installPipDeps()  → pip install torch + opencv + fastapi + ... + edge-tts
 *   installWav2Lip()  → git clone Wav2Lip, download wav2lip_gan.pth (~415MB),
 *                       patch librosa
 *
 * Each function accepts { ..., sendProgress, log } and calls
 * sendProgress(stage, percent, message) to push UI updates.
 *
 * Returns { success: boolean, error?: string }.
 */

const fs = require("fs");
const path = require("path");
const { spawn, execFile, execFileSync, spawnSync } = require("child_process");
const https = require("https");
const http = require("http");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr}`));
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
      // Capture BOTH stdout and stderr — Python 3.4+ prints version to stderr
      const result = require("child_process").spawnSync(
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
      // Must contain "Python 3." to be valid
      if (/Python 3\.\d+/.test(combined)) {
        return c;
      }
      // If the output mentions "Microsoft Store" or "Windows Store",
      // it's the Store stub — skip it.
      // (No output at all also means stub — silent failure.)
    } catch {}
  }
  return null;
}

/**
 * Get the full version string of a Python binary (e.g. "Python 3.11.9").
 * Used for diagnostic logging.
 */
function getPythonVersion(cmd) {
  try {
    const parts = cmd.split(" ");
    const result = require("child_process").spawnSync(
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

/** Download a URL to a file path. Reports progress via onProgress(received, total). */
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let received = 0;
    let total = 0;

    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
        file.close();
        fs.unlinkSync(dest);
        const next = new URL(res.headers.location, url).toString();
        return downloadFile(next, dest, onProgress).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
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
        fs.unlinkSync(dest);
        reject(e);
      });
    };

    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, handle);
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error("Download timed out"));
    });
  });
}

/** Extract a .zip to a directory using Node's built-in approach (via unzip cmd). */
async function extractZip(zipPath, destDir) {
  // Use PowerShell on Windows, unzip on Mac/Linux
  if (process.platform === "win32") {
    await spawnAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ]);
  } else {
    await spawnAsync("unzip", ["-o", zipPath, "-d", destDir]);
  }
}

// ---------------------------------------------------------------------------
// installPython
// ---------------------------------------------------------------------------
//
// Strategy:
//   1. On Windows: try system Python first. If not found (or it's the
//      Microsoft Store stub), download Python embeddable (~10MB) and
//      bootstrap pip into it using get-pip.py. No venv needed — we use
//      the embeddable Python directly.
//   2. On Mac/Linux: use system python3, create a venv.
//
// The venv path (VENV_DIR) is kept for backwards compatibility — on Windows
// with embedded Python, we set VENV_DIR = PYTHON_DIR (same location).
// ---------------------------------------------------------------------------

async function installPython({ PYTHON_DIR, VENV_DIR, sendProgress, log }) {
  try {
    fs.mkdirSync(PYTHON_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });

    sendProgress && sendProgress("python", 5, "البحث عن Python...");

    let pythonExe = null;
    let useEmbedded = false;

    // Try system Python first
    pythonExe = findSystemPython();
    if (pythonExe) {
      log("[installPython] Found system Python:", pythonExe, getPythonVersion(pythonExe));
    } else if (process.platform === "win32") {
      // Windows without system Python → download embeddable + bootstrap pip
      log("[installPython] No system Python. Downloading embeddable Python...");
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
      });

      sendProgress && sendProgress("python", 45, "فك ضغط Python...");
      await extractZip(zipPath, PYTHON_DIR);
      try { fs.unlinkSync(zipPath); } catch {}

      // Enable pip in embeddable Python:
      // 1. Uncomment "import site" in the ._pth file (otherwise pip won't work)
      const pthFiles = fs.readdirSync(PYTHON_DIR).filter(f => f.endsWith("._pth"));
      for (const pthFile of pthFiles) {
        const pthPath = path.join(PYTHON_DIR, pthFile);
        let content = fs.readFileSync(pthPath, "utf8");
        if (content.includes("#import site")) {
          content = content.replace("#import site", "import site");
          fs.writeFileSync(pthPath, content);
          log("[installPython] Enabled 'import site' in", pthFile);
        }
      }

      // 2. Download get-pip.py and run it to bootstrap pip
      sendProgress && sendProgress("python", 55, "تثبيت pip...");
      const getPipUrl = "https://bootstrap.pypa.io/get-pip.py";
      const getPipPath = path.join(PYTHON_DIR, "get-pip.py");
      await downloadFile(getPipUrl, getPipPath);

      const embeddedPython = path.join(PYTHON_DIR, "python.exe");
      if (!fs.existsSync(embeddedPython)) {
        throw new Error(`python.exe مش موجود بعد فك الضغط. اتحقق من: ${PYTHON_DIR}`);
      }

      await spawnAsync(embeddedPython, [getPipPath, "--no-warn-script-location"], {
        cwd: PYTHON_DIR,
        onStdout: (s) => log("[get-pip]", s.trim()),
        onStderr: (s) => log("[get-pip:err]", s.trim()),
      });

      // Verify pip works
      const pipCheck = spawnSync(embeddedPython, ["-m", "pip", "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 10000,
      });
      const pipVersion = ((pipCheck.stdout || "") + (pipCheck.stderr || "")).trim();
      if (!pipVersion.includes("pip")) {
        throw new Error("pip ماتثبتش صح في الـ embedded Python. الإخراج: " + pipVersion);
      }
      log("[installPython] pip installed:", pipVersion);

      pythonExe = embeddedPython;

      // For embedded Python, VENV_DIR = PYTHON_DIR (we use it directly)
      // We write a marker file so installPipDeps knows to use PYTHON_DIR
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
        onStdout: (s) => log("[venv]", s.trim()),
        onStderr: (s) => log("[venv:err]", s.trim()),
      });

      sendProgress && sendProgress("python", 80, "تحديث pip...");
      const venvPy = path.join(
        VENV_DIR,
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python"
      );
      await spawnAsync(venvPy, ["-m", "pip", "install", "--upgrade", "pip"], {
        onStdout: (s) => log("[pip-upgrade]", s.trim()),
        onStderr: (s) => log("[pip-upgrade:err]", s.trim()),
      });
    }

    sendProgress && sendProgress("python", 100, "Python جاهز ✓");
    return { success: true };
  } catch (e) {
    log("[installPython] FAILED:", e);
    sendProgress && sendProgress("python", -1, `فشل: ${e.message}`);
    return { success: false, error: String(e?.message || e) };
  }
}

/**
 * Get the Python executable to use for running pip / backend.
 * - If VENV_DIR/Scripts/python.exe (or bin/python) exists → use venv
 * - Else if PYTHON_DIR/USE_EMBEDDED.txt exists → use PYTHON_DIR/python.exe
 * - Else fall back to PYTHON_DIR/python.exe (legacy)
 */
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

  // Legacy fallback
  if (PYTHON_DIR) {
    const legacy = path.join(PYTHON_DIR, "python.exe");
    if (fs.existsSync(legacy)) return legacy;
  }
  return venvPy; // returns nonexistent path; caller will fail with clear error
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
    log("[installPipDeps] Using Python:", venvPy);

    // Pin versions known to work with Wav2Lip
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

    // Install in chunks so we can report progress
    const chunks = [];
    for (let i = 0; i < packages.length; i += 4) {
      chunks.push(packages.slice(i, i + 4));
    }

    for (let i = 0; i < chunks.length; i++) {
      const pct = Math.floor((i / chunks.length) * 100);
      sendProgress && sendProgress("pip", pct, `تثبيت: ${chunks[i].join(", ")}`);
      await spawnAsync(
        venvPy,
        ["-m", "pip", "install", ...chunks[i]],
        {
          onStdout: (s) => log("[pip]", s.trim()),
          onStderr: (s) => log("[pip:err]", s.trim()),
        }
      );
    }

    sendProgress && sendProgress("pip", 100, "كل المكتبات اتثبتت ✓");
    return { success: true };
  } catch (e) {
    log("[installPipDeps] FAILED:", e);
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
    log("[installWav2Lip] Using Python:", venvPy);

    // Step 1: clone Wav2Lip
    if (fs.existsSync(path.join(WAV2LIP_DIR, "models", "wav2lip.py"))) {
      sendProgress && sendProgress("wav2lip", 10, "Wav2Lip موجود بالفعل، تخطّي...");
    } else {
      sendProgress && sendProgress("wav2lip", 5, "تحميل Wav2Lip من GitHub...");
      fs.mkdirSync(path.dirname(WAV2LIP_DIR), { recursive: true });
      // Delete partial dir if exists
      if (fs.existsSync(WAV2LIP_DIR)) {
        fs.rmSync(WAV2LIP_DIR, { recursive: true, force: true });
      }
      await spawnAsync("git", [
        "clone",
        "--depth",
        "1",
        "https://github.com/Rudrabha/Wav2Lip.git",
        WAV2LIP_DIR,
      ], {
        onStdout: (s) => log("[git]", s.trim()),
        onStderr: (s) => log("[git:err]", s.trim()),
      });
    }

    // Step 2: download checkpoint (~415MB)
    if (fs.existsSync(CKPT_PATH) && fs.statSync(CKPT_PATH).size > 400_000_000) {
      sendProgress && sendProgress("wav2lip", 80, "الـ model موجود بالفعل، تخطّي...");
    } else {
      sendProgress && sendProgress("wav2lip", 20, "تحميل model Wav2Lip (~415MB)...");
      fs.mkdirSync(path.dirname(CKPT_PATH), { recursive: true });

      // Use huggingface_hub for resumable download
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
      // Stream progress — we can't easily get huggingface_hub progress, so use a fake ticker
      let fakePct = 20;
      const ticker = setInterval(() => {
        fakePct = Math.min(75, fakePct + 1);
        sendProgress && sendProgress("wav2lip", fakePct, `تحميل الـ model... ${fakePct}%`);
      }, 3000);

      try {
        await spawnAsync(venvPy, ["-c", script], {
          onStdout: (s) => log("[hf]", s.trim()),
          onStderr: (s) => log("[hf:err]", s.trim()),
        });
      } finally {
        clearInterval(ticker);
      }

      if (!fs.existsSync(CKPT_PATH) || fs.statSync(CKPT_PATH).size < 400_000_000) {
        throw new Error("الـ model ماتحملش صح. حاول تاني.");
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
        log("[wav2lip] patched audio.py for librosa 0.10+");
      }
    }

    // Step 4: verify
    sendProgress && sendProgress("wav2lip", 95, "اختبار التثبيت...");
    await spawnAsync(
      venvPy,
      ["-c", "import sys; sys.path.insert(0, r'" + WAV2LIP_DIR + "'); import wav2lip_runner; wav2lip_runner._check_wav2lip_available(); print('OK')"],
      {
        cwd: BACKEND_SRC_DIR || undefined,
        env: { ...process.env, PYTHONPATH: WAV2LIP_DIR },
        onStdout: (s) => log("[verify]", s.trim()),
        onStderr: (s) => log("[verify:err]", s.trim()),
      }
    );

    sendProgress && sendProgress("wav2lip", 100, "Wav2Lip جاهز ✓");
    return { success: true };
  } catch (e) {
    log("[installWav2Lip] FAILED:", e);
    sendProgress && sendProgress("wav2lip", -1, `فشل: ${e.message}`);
    return { success: false, error: String(e?.message || e) };
  }
}

module.exports = { installPython, installPipDeps, installWav2Lip, downloadFile, spawnAsync };
