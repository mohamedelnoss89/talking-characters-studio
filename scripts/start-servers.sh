#!/bin/bash
# Launcher script - بيشتغل من cron أو يدوي
# بيفحص لو السيرفرين شغالين، لو لأ يشغلهم

LOGFILE=/tmp/server-launcher.log
echo "[$(date +%H:%M:%S)] Launcher running..." >> $LOGFILE

# فحص backend
if ! curl -s -m 3 -o /dev/null http://localhost:8000/health 2>/dev/null; then
  echo "[$(date +%H:%M:%S)] Backend down - starting..." >> $LOGFILE
  pkill -9 -f "server.py" 2>/dev/null
  sleep 1
  cd /home/z/my-project/backend
  LD_LIBRARY_PATH="/home/z/my-project/.libs/usr/lib/x86_64-linux-gnu:/home/z/my-project/.libs" \
    /home/z/.venv/bin/python -u server.py > /tmp/backend.log 2>&1 &
  echo $! > /tmp/backend.pid
  disown
  sleep 5
fi

# فحص Next.js
if ! curl -s -m 3 -o /dev/null http://localhost:3000/api/health 2>/dev/null; then
  echo "[$(date +%H:%M:%S)] Next.js down - starting..." >> $LOGFILE
  pkill -9 -f "next-server" 2>/dev/null
  pkill -9 -f "next dev" 2>/dev/null
  sleep 1
  cd /home/z/my-project
  npm run dev > /tmp/next-dev.log 2>&1 &
  echo $! > /tmp/next.pid
  disown
  sleep 12
fi

echo "[$(date +%H:%M:%S)] Done. Backend: $(curl -s -m 2 http://localhost:8000/health 2>/dev/null | head -c 50) | Next: $(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:3000/api/health 2>/dev/null)" >> $LOGFILE
