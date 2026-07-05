#!/bin/bash
# Watchdog محسّن - بيفحص السيرفرين كل 30s ويعمل restart لو أي واحد وقع
LOG="/tmp/watchdog.log"
NEXT_PID_FILE="/tmp/next-dev-pid"
BACKEND_PID_FILE="/tmp/backend-pid"

start_backend() {
  echo "[$(date +%H:%M:%S)] Starting backend..." >> $LOG
  cd /home/z/my-project/backend
  LD_LIBRARY_PATH="/home/z/my-project/.libs/usr/lib/x86_64-linux-gnu:/home/z/my-project/.libs:${LD_LIBRARY_PATH:-}" \
    setsid nohup /home/z/.venv/bin/python -u server.py > /tmp/backend.log 2>&1 </dev/null &
  disown
  echo $! > $BACKEND_PID_FILE
  cd /home/z/my-project
}

start_next() {
  echo "[$(date +%H:%M:%S)] Starting Next.js..." >> $LOG
  cd /home/z/my-project
  setsid nohup npm run dev > /tmp/next-dev.log 2>&1 </dev/null &
  disown
  echo $! > $NEXT_PID_FILE
}

# شغّل الاتنين من الأول
start_backend
sleep 4
start_next

echo "[$(date +%H:%M:%S)] Watchdog initialized — backend PID $(cat $BACKEND_PID_FILE), next PID $(cat $NEXT_PID_FILE)" >> $LOG

while true; do
  sleep 30
  
  # فحص الـ backend
  if ! curl -s -m 3 -o /dev/null http://localhost:8000/health 2>/dev/null; then
    echo "[$(date +%H:%M:%S)] Backend health check failed — restarting..." >> $LOG
    pkill -9 -f "server.py" 2>/dev/null
    sleep 2
    start_backend
    sleep 4
  fi
  
  # فحص Next.js
  if ! curl -s -m 3 -o /dev/null http://localhost:3000/api/health 2>/dev/null; then
    echo "[$(date +%H:%M:%S)] Next.js health check failed — restarting..." >> $LOG
    pkill -9 -f "next-server" 2>/dev/null
    pkill -9 -f "next dev" 2>/dev/null
    sleep 2
    start_next
    sleep 10
  fi
done
