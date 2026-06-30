#!/bin/bash
# Start server, wait, test API, all in one session
cd /home/z/my-project/backend

# Kill any existing server
pkill -f "server.py" 2>/dev/null
sleep 2

# Start server in background
/home/z/.venv/bin/python -u server.py > /tmp/server_run.log 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for model to load (up to 30s)
for i in $(seq 1 30); do
    if curl -s http://localhost:8000/health 2>/dev/null | grep -q "ok"; then
        echo "Server ready after ${i}s"
        break
    fi
    sleep 1
done

# Test API
echo "=== Testing API ==="
curl --max-time 90 -s -X POST http://localhost:8000/lip-sync \
  -F "file=@/home/z/my-project/backend/uploads/08216505/input_image.png" \
  -F "audio=@/home/z/my-project/backend/test_speech.wav" \
  -F "pads=0,20,0,0" \
  -o /home/z/my-project/download/v6_api_test.mp4 \
  -w "HTTP: %{http_code}\nSize: %{size_download} bytes\nTime: %{time_total}s\n"

echo "==="
ls -la /home/z/my-project/download/v6_api_test.mp4 2>/dev/null
file /home/z/my-project/download/v6_api_test.mp4 2>/dev/null

# Show server logs
echo "=== Server logs (tail) ==="
tail -20 /tmp/server_run.log

# Kill server
kill $SERVER_PID 2>/dev/null
