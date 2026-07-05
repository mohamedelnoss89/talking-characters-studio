#!/bin/bash
# Persistent server runner - loop forever, restart if dies
LOG=/tmp/persistent-servers.log
echo "[$(date)] Starting persistent server loop" >> $LOG

while true; do
  # Backend
  if ! pgrep -f "server.py" > /dev/null 2>&1; then
    echo "[$(date)] Backend not running - starting" >> $LOG
    cd /home/z/my-project/backend
    LD_LIBRARY_PATH="/home/z/my-project/.libs/usr/lib/x86_64-linux-gnu:/home/z/my-project/.libs" \
      /home/z/.venv/bin/python -u server.py > /tmp/backend.log 2>&1 &
    BACKEND_PID=$!
    echo $! > /tmp/backend.pid
    disown
    echo "[$(date)] Backend started PID=$BACKEND_PID" >> $LOG
    sleep 5
  fi
  
  # Next.js
  if ! pgrep -f "next-server" > /dev/null 2>&1; then
    echo "[$(date)] Next.js not running - starting" >> $LOG
    cd /home/z/my-project
    npm run dev > /tmp/next-dev.log 2>&1 &
    NEXT_PID=$!
    echo $! > /tmp/next.pid
    disown
    echo "[$(date)] Next.js started PID=$NEXT_PID" >> $LOG
    sleep 12
  fi
  
  sleep 10
done
