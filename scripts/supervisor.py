"""Simple supervisor that keeps the server alive."""
import subprocess
import time
import os
import sys

SERVER_SCRIPT = "/home/z/my-project/backend/server.py"
PYTHON = "/home/z/.venv/bin/python"
LOG_FILE = "/home/z/my-project/backend/server.log"

def main():
    # Write our own PID file
    with open("/home/z/my-project/backend/supervisor.pid", "w") as f:
        f.write(str(os.getpid()))
    
    while True:
        # Check if server is running
        try:
            result = subprocess.run(
                ["pgrep", "-f", "server.py"],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                # Server is running, just wait
                time.sleep(10)
                continue
        except:
            pass
        
        # Start server
        print(f"[{time.strftime('%H:%M:%S')}] Starting server...", flush=True)
        with open(LOG_FILE, "a") as log:
            proc = subprocess.Popen(
                [PYTHON, "-u", SERVER_SCRIPT],
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,  # Critical: detach from our session
            )
        print(f"[{time.strftime('%H:%M:%S')}] Server PID: {proc.pid}", flush=True)
        
        # Wait for it to exit (or be killed)
        proc.wait()
        print(f"[{time.strftime('%H:%M:%S')}] Server exited with code {proc.returncode}", flush=True)
        time.sleep(2)  # Brief pause before restart

if __name__ == "__main__":
    main()
