#!/usr/bin/env python3
"""
start-servers.py — يبدأ السيرفرين (Python backend + Next.js) كـ daemons حقيقيين
بتقنية double-fork عشان يتفصلوا تماماً عن الـ bash tool session.
"""
import os
import sys
import time
import subprocess
import signal
from pathlib import Path

PROJECT_DIR = Path("/home/z/my-project")
LOG_DIR = PROJECT_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

PYTHON_LOG = LOG_DIR / "python.log"
NEXT_LOG = LOG_DIR / "next.log"


def kill_existing():
    """اقتل أي عمليات قديمة"""
    for pattern in ["next dev", "next-server", "uvicorn", "backend/server.py"]:
        try:
            subprocess.run(
                ["pkill", "-f", pattern],
                capture_output=True, timeout=5
            )
        except Exception:
            pass
    time.sleep(2)


def start_python():
    """شغّل Python backend بـ double-fork daemon"""
    pid = os.fork()
    if pid > 0:
        # parent
        return pid

    # child - become session leader
    os.setsid()
    os.umask(0)

    # second fork
    pid2 = os.fork()
    if pid2 > 0:
        os._exit(0)

    # grandchild - the actual daemon
    os.chdir(PROJECT_DIR)

    # redirect stdio
    sys.stdout.flush()
    sys.stderr.flush()
    with open(PYTHON_LOG, "wb") as f:
        os.dup2(f.fileno(), 1)
        os.dup2(f.fileno(), 2)
    with open("/dev/null", "rb") as f:
        os.dup2(f.fileno(), 0)

    # exec the python server
    os.execvp("python", ["python", "backend/server.py"])


def start_next():
    """شغّل Next.js بـ double-fork daemon"""
    pid = os.fork()
    if pid > 0:
        return pid

    os.setsid()
    os.umask(0)

    pid2 = os.fork()
    if pid2 > 0:
        os._exit(0)

    os.chdir(PROJECT_DIR)

    sys.stdout.flush()
    sys.stderr.flush()
    with open(NEXT_LOG, "wb") as f:
        os.dup2(f.fileno(), 1)
        os.dup2(f.fileno(), 2)
    with open("/dev/null", "rb") as f:
        os.dup2(f.fileno(), 0)

    os.execvp("npm", ["npm", "run", "dev"])


def wait_for_port(port, timeout=30):
    """استنى لحد ما port يفتح"""
    import socket
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1)
            s.connect(("127.0.0.1", port))
            s.close()
            return True
        except Exception:
            time.sleep(1)
    return False


def main():
    kill_existing()

    print("Starting Python backend on :8000 ...")
    py_pid = start_python()
    time.sleep(1)

    if wait_for_port(8000, timeout=15):
        print(f"  Python backend UP (PID {py_pid})")
    else:
        print("  Python backend FAILED to start")
        print(f"  Log: {PYTHON_LOG}")
        try:
            print(PYTHON_LOG.read_text()[-500:])
        except Exception:
            pass

    print("Starting Next.js on :3000 ...")
    nx_pid = start_next()

    if wait_for_port(3000, timeout=40):
        print(f"  Next.js UP (PID {nx_pid})")
    else:
        print("  Next.js FAILED to start")
        print(f"  Log: {NEXT_LOG}")
        try:
            print(NEXT_LOG.read_text()[-500:])
        except Exception:
            pass

    # final check
    print("\n=== STATUS ===")
    import socket
    for port in [3000, 8000]:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1)
            s.connect(("127.0.0.1", port))
            s.close()
            print(f"  :{port} UP")
        except Exception:
            print(f"  :{port} DOWN")


if __name__ == "__main__":
    main()
