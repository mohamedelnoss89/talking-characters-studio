#!/bin/bash
# Watchdog script: keeps the Next.js dev server running
# Restarts it if it dies
LOG=/tmp/next-dev.log
PIDFILE=/tmp/next-server.pid

while true; do
  # Check if Next.js is still listening on port 3000
  if ! ss -tln 2>/dev/null | grep -q ":3000"; then
    echo "[$(date)] Next.js not running, starting..." >> $LOG
    cd /home/z/my-project
    npm run dev >> $LOG 2>&1 &
    NEXT_PID=$!
    echo $NEXT_PID > $PIDFILE
    echo "[$(date)] Started Next.js with PID $NEXT_PID" >> $LOG
    # Wait for it to be ready
    sleep 12
    if ss -tln 2>/dev/null | grep -q ":3000"; then
      echo "[$(date)] Next.js is up" >> $LOG
    else
      echo "[$(date)] Next.js failed to start" >> $LOG
    fi
  fi
  # Check every 10 seconds
  sleep 10
done
