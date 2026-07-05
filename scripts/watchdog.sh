#!/bin/bash
# Watchdog - يشغل السيرفرات لو وقعوا
LOG="/tmp/watchdog.log"
while true; do
  NEEDS_NEXT=0
  NEEDS_BACKEND=0
  
  if ! ss -tlnp 2>/dev/null | grep -q ":3000 "; then
    NEEDS_NEXT=1
  fi
  if ! ss -tlnp 2>/dev/null | grep -q ":8000 "; then
    NEEDS_BACKEND=1
  fi
  
  if [ $NEEDS_BACKEND -eq 1 ]; then
    echo "[$(date +%H:%M:%S)] Backend down — restarting..." >> $LOG
    cd /home/z/my-project/backend
    LD_LIBRARY_PATH="/home/z/my-project/.libs/usr/lib/x86_64-linux-gnu:/home/z/my-project/.libs:${LD_LIBRARY_PATH:-}" \
      setsid nohup /home/z/.venv/bin/python -u server.py > /tmp/backend.log 2>&1 </dev/null &
    disown
    sleep 5
  fi
  
  if [ $NEEDS_NEXT -eq 1 ]; then
    echo "[$(date +%H:%M:%S)] Next.js down — restarting..." >> $LOG
    cd /home/z/my-project
    setsid nohup npm run dev > /tmp/next-dev.log 2>&1 </dev/null &
    disown
    sleep 10
  fi
  
  sleep 30
done
