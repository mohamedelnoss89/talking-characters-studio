/**
 * Next.js Instrumentation - runs once on server startup
 * Starts the Python Wav2Lip backend automatically
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] Starting Wav2Lip backend...');
    try {
      const { spawn } = await import('child_process');
      const path = await import('path');
      
      const serverPath = path.join(process.cwd(), 'backend', 'server.py');
      const pythonPath = '/home/z/.venv/bin/python';
      
      const proc = spawn(pythonPath, ['-u', serverPath], {
        cwd: path.join(process.cwd(), 'backend'),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
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
}
