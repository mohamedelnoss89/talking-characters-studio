#!/bin/bash
# Persistent server runner — checks HTTP health, restarts if dead
LOG=/tmp/persistent-servers.log
echo "[$(date)] === Persistent server supervisor started (PID $$) ===" >> $LOG

while true; do
  # ---- Backend (port 8000) ----
  if ! curl -sf http://localhost:8000/health --max-time 3 > /dev/null 2>&1; then
    echo "[$(date)] Backend not responding — killing stale and restarting" >> $LOG
    pkill -f "backend/server.py" 2>/dev/null
    sleep 1
    cd /home/z/my-project/backend
    LD_LIBRARY_PATH="/home/z/my-project/.libs/usr/lib/x86_64-linux-gnu:/home/z/my-project/.libs" \
      nohup /home/z/.venv/bin/python -u server.py > /tmp/backend.log 2>&1 &
    disown $! 2>/dev/null
    echo $! > /tmp/backend.pid
    echo "[$(date)] Backend started PID=$!" >> $LOG
    sleep 5
  fi

  # ---- Frontend (port 3000) ----
  if ! curl -sf http://localhost:3000/ --max-time 5 > /dev/null 2>&1; then
    echo "[$(date)] Frontend not responding — killing stale and restarting" >> $LOG
    pkill -f "next dev" 2>/dev/null
    pkill -f "next-server" 2>/dev/null
    sleep 2
    cd /home/z/my-project
    nohup npm run dev > /tmp/frontend.log 2>&1 &
    disown $! 2>/dev/null
    echo $! > /tmp/next.pid
    echo "[$(date)] Frontend started PID=$!" >> $LOG
    sleep 15
  fi

  sleep 10
done
