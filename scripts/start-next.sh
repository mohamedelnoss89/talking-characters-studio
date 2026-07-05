#!/bin/bash
# Stable launcher for Next.js dev server with auto-restart watchdog
# Usage: bash /home/z/my-project/scripts/start-next.sh

set -u

LOG="/tmp/next-dev.log"
PIDFILE="/tmp/next-dev.pid"
PORT=3000

cd /home/z/my-project

# Kill any existing next processes
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 2

# Start in a fully detached session with watchdog
setsid bash -c '
  while true; do
    echo "[$(date +%H:%M:%S)] Starting next dev..." >> '"$LOG"'
    npm run dev --prefix /home/z/my-project >> '"$LOG"' 2>&1
    EXIT_CODE=$?
    echo "[$(date +%H:%M:%S)] next dev exited with code $EXIT_CODE — restarting in 3s..." >> '"$LOG"'
    sleep 3
  done
' </dev/null >/dev/null 2>&1 &

WATCHDOG_PID=$!
echo $WATCHDOG_PID > $PIDFILE
echo "Watchdog PID: $WATCHDOG_PID"
echo "Log: $LOG"

# Wait for server to be ready
for i in {1..30}; do
  if curl -s -m 2 -o /dev/null -w "%{http_code}" http://localhost:3000/api/health 2>/dev/null | grep -q "200"; then
    echo "Next.js is ready on port $PORT"
    echo "---HEALTH RESPONSE---"
    curl -s -m 5 http://localhost:3000/api/health
    echo
    exit 0
  fi
  sleep 1
done

echo "Server failed to start within 30s. Last log lines:"
tail -30 $LOG
exit 1
