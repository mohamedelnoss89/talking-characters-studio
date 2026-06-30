#!/bin/bash
# يبدأ الـ backend (Wav2Lip) و الـ frontend (Next.js) مع بعض

set -e

cd /home/z/my-project

echo "=== 1. بدء Wav2Lip Backend (port 8000) ==="
# تحقق لو شغال بالفعل
if curl -sS http://localhost:8000/health > /dev/null 2>&1; then
  echo "[OK] Backend already running"
else
  echo "Starting backend..."
  (setsid bash -c 'cd /home/z/my-project/backend && python3 server.py > /tmp/wav2lip-server.log 2>&1' &)
  echo "Waiting for backend to load model (may take ~10s)..."
  for i in $(seq 1 30); do
    if curl -sS http://localhost:8000/health > /dev/null 2>&1; then
      echo "[OK] Backend started after ${i}s"
      curl -sS http://localhost:8000/health
      echo ""
      break
    fi
    sleep 1
  done
fi

echo ""
echo "=== 2. بدء Next.js Frontend (port 3000) ==="
# تحقق لو شغال بالفعل
if curl -sS http://localhost:3000/ > /dev/null 2>&1; then
  echo "[OK] Frontend already running"
else
  echo "Starting frontend..."
  (setsid bash -c 'cd /home/z/my-project && npm run dev > /tmp/next-dev.log 2>&1' &)
  echo "Waiting for frontend..."
  for i in $(seq 1 20); do
    if curl -sS http://localhost:3000/ > /dev/null 2>&1; then
      echo "[OK] Frontend started after ${i}s"
      break
    fi
    sleep 1
  done
fi

echo ""
echo "=== الخدمات شغالة ==="
echo "Frontend:  http://localhost:3000"
echo "Backend:   http://localhost:8000"
echo "Health:    http://localhost:8000/health"
echo ""
echo "Backend log:  /tmp/wav2lip-server.log"
echo "Frontend log: /tmp/next-dev.log"
