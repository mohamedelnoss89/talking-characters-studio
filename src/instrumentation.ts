/**
 * Next.js Instrumentation - runs once on server startup.
 *
 * On the local dev container, this auto-starts the Python Wav2Lip backend.
 * On Vercel (or any platform without the Python backend), it's a no-op.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Skip on Vercel and other serverless platforms — they don't have a Python
  // backend, and trying to spawn one would cause timeouts.
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    console.log('[Instrumentation] Running on Vercel — skipping Python backend auto-start');
    return;
  }

  console.log('[Instrumentation] Starting Wav2Lip backend...');
  try {
    const { spawn } = await import('child_process');
    const path = await import('path');

    const serverPath = path.join(process.cwd(), 'backend', 'server.py');
    const pythonPath = '/home/z/.venv/bin/python';
    const libsPath = path.join(process.cwd(), '.libs');

    // Build environment with LD_LIBRARY_PATH for mediapipe (libGLESv2.so.2)
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
    const existingLd = (env.LD_LIBRARY_PATH || '').trim();
    const extraLd = `${libsPath}/usr/lib/x86_64-linux-gnu:${libsPath}`;
    env.LD_LIBRARY_PATH = existingLd
      ? `${extraLd}:${existingLd}`
      : extraLd;

    const proc = spawn(pythonPath, ['-u', serverPath], {
      cwd: path.join(process.cwd(), 'backend'),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env,
    });

    proc.stdout?.on('data', (data) => {
      console.log(`[Backend] ${data.toString().trim()}`);
    });
    proc.stderr?.on('data', (data) => {
      console.error(`[Backend] ${data.toString().trim()}`);
    });
    proc.on('exit', (code) => {
      console.log(`[Instrumentation] Backend exited with code ${code}`);
    });

    // Don't wait for it - let it run in background
    proc.unref();

    console.log(`[Instrumentation] Backend started with PID ${proc.pid}`);
  } catch (err) {
    console.error('[Instrumentation] Failed to start backend:', err);
  }
}
