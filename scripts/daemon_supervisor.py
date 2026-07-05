#!/usr/bin/env python3
"""Daemonize the persistent server supervisor so it survives parent shell exit."""
import os
import sys
import time
import subprocess

LOG = "/tmp/persistent-servers.log"

def log(msg):
    with open(LOG, "a") as f:
        f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")

def daemonize():
    """Standard double-fork daemonization."""
    # First fork
    try:
        if os.fork() > 0:
            sys.exit(0)
    except OSError as e:
        sys.exit(f"fork #1 failed: {e}")

    os.setsid()
    os.umask(0)

    # Second fork
    try:
        if os.fork() > 0:
            sys.exit(0)
    except OSError as e:
        sys.exit(f"fork #2 failed: {e}")

    # Redirect std streams
    sys.stdout.flush()
    sys.stderr.flush()
    with open("/dev/null", "rb") as f:
        os.dup2(f.fileno(), 0)
    with open("/dev/null", "ab") as f:
        os.dup2(f.fileno(), 1)
        os.dup2(f.fileno(), 2)

def backend_alive():
    try:
        r = subprocess.run(
            ["curl", "-sf", "http://localhost:8000/health", "--max-time", "3"],
            timeout=5, capture_output=True
        )
        return r.returncode == 0
    except Exception:
        return False

def frontend_alive():
    try:
        r = subprocess.run(
            ["curl", "-sf", "http://localhost:3000/", "--max-time", "5"],
            timeout=8, capture_output=True
        )
        return r.returncode == 0
    except Exception:
        return False

def start_backend():
    log("Backend not responding — restarting")
    subprocess.run("pkill -f 'backend/server.py'", shell=True)
    time.sleep(1)
    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = "/home/z/my-project/.libs/usr/lib/x86_64-linux-gnu:/home/z/my-project/.libs"
    with open("/tmp/backend.log", "wb") as f:
        p = subprocess.Popen(
            ["/home/z/.venv/bin/python", "-u", "/home/z/my-project/backend/server.py"],
            cwd="/home/z/my-project/backend",
            env=env,
            stdout=f, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    with open("/tmp/backend.pid", "w") as f:
        f.write(str(p.pid))
    log(f"Backend started PID={p.pid}")

def start_frontend():
    log("Frontend not responding — restarting")
    subprocess.run("pkill -f 'next dev'", shell=True)
    subprocess.run("pkill -f 'next-server'", shell=True)
    time.sleep(2)
    with open("/tmp/frontend.log", "wb") as f:
        p = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd="/home/z/my-project",
            stdout=f, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    with open("/tmp/next.pid", "w") as f:
        f.write(str(p.pid))
    log(f"Frontend started PID={p.pid}")

def main():
    daemonize()
    log(f"=== Python daemon supervisor started (PID {os.getpid()}) ===")
    while True:
        try:
            if not backend_alive():
                start_backend()
                time.sleep(5)
            if not frontend_alive():
                start_frontend()
                time.sleep(15)
        except Exception as e:
            log(f"Supervisor loop error: {e}")
        time.sleep(10)

if __name__ == "__main__":
    main()
