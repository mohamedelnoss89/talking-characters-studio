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
const { spawn, execFile, execFileSync } = require("child_process");
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

/** Find a usable system Python 3.x binary. */
function findSystemPython() {
  const candidates =
    process.platform === "win32"
      ? ["python.exe", "python3.exe", "py.exe -3"]
      : ["python3", "python"];
  for (const c of candidates) {
    try {
      const parts = c.split(" ");
      const out = execFileSync(parts[0], parts.slice(1).concat(["--version"]), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      if (/Python 3\./.test(out)) return c;
    } catch {}
  }
  return null;
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

async function installPython({ PYTHON_DIR, VENV_DIR, sendProgress, log }) {
  try {
    fs.mkdirSync(PYTHON_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });

    // Step 1: Get a Python binary to use for venv creation
    sendProgress && sendProgress("python", 5, "البحث عن Python...");

    let pythonExe = null;

    if (process.platform === "win32") {
      // Windows: try to use system Python first (cheaper than downloading embed)
      pythonExe = findSystemPython();
      if (!pythonExe) {
        // Download Python embeddable (smallest option, ~10MB)
        sendProgress && sendProgress("python", 15, "تحميل Python embedded...");
        const pyVersion = "3.11.9";
        const pyUrl = `https://www.python.org/ftp/python/${pyVersion}/python-${pyVersion}-embed-amd64.zip`;
        const zipPath = path.join(PYTHON_DIR, "python-embed.zip");
        await downloadFile(pyUrl, zipPath, (r, t) => {
          if (t) {
            const pct = 15 + Math.floor((r / t) * 30);
            sendProgress && sendProgress("python", pct, `تحميل Python... ${Math.floor(r / 1024 / 1024)}MB / ${Math.floor(t / 1024 / 1024)}MB`);
          }
        });
        sendProgress && sendProgress("python", 45, "فك ضغط Python...");
        await extractZip(zipPath, PYTHON_DIR);
        fs.unlinkSync(zipPath);
        // Embeddable Python doesn't include pip — we need to bootstrap it later.
        // For venv creation we need a full Python. Fall back to system install.
        sendProgress && sendProgress("python", 50, "Python embedded لا يدعم venv. البحث عن Python مثبت...");
        pythonExe = findSystemPython();
        if (!pythonExe) {
          throw new Error(
            "Python مش مثبت على الويندوز. نزّل Python 3.11+ من python.org وشغّل التثبيت تاني."
          );
        }
      }
    } else {
      // Mac/Linux: use system python3
      pythonExe = findSystemPython();
      if (!pythonExe) {
        throw new Error(
          "Python 3 مش موجود. ثبّته من brew install python (Mac) أو apt install python3 (Linux)."
        );
      }
    }

    // Step 2: Create venv
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

    // Step 3: Upgrade pip
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

    sendProgress && sendProgress("python", 100, "Python جاهز ✓");
    return { success: true };
  } catch (e) {
    log("[installPython] FAILED:", e);
    sendProgress && sendProgress("python", -1, `فشل: ${e.message}`);
    return { success: false, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// installPipDeps
// ---------------------------------------------------------------------------

async function installPipDeps({ VENV_DIR, BACKEND_SRC_DIR, sendProgress, log }) {
  try {
    const venvPy = path.join(
      VENV_DIR,
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python"
    );
    if (!fs.existsSync(venvPy)) {
      throw new Error("venv مش موجود. شغّل تثبيت Python الأول.");
    }

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

async function installWav2Lip({ WAV2LIP_DIR, CKPT_PATH, VENV_DIR, sendProgress, log }) {
  try {
    const venvPy = path.join(
      VENV_DIR,
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python"
    );
    if (!fs.existsSync(venvPy)) {
      throw new Error("venv مش موجود. شغّل تثبيت Python الأول.");
    }

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
