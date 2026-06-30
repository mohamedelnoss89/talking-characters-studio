#!/bin/bash
# Full end-to-end test: start server, submit job, poll, download, all in one session
cd /home/z/my-project/backend

# Kill any existing server
pkill -f "server.py" 2>/dev/null
sleep 2

# Start server
/home/z/.venv/bin/python -u server.py > /tmp/server_run.log 2>&1 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Wait for server
for i in $(seq 1 30); do
    if curl -s http://localhost:8000/health 2>/dev/null | grep -q "ok"; then
        echo "Server ready after ${i}s"
        break
    fi
    sleep 1
done

# Submit job
echo "=== Submitting job ==="
RESPONSE=$(curl -s -X POST http://localhost:8000/lip-sync \
  -F "file=@/home/z/my-project/backend/uploads/08216505/input_image.png" \
  -F "audio=@/home/z/my-project/backend/test_speech.wav" \
  -F "pads=0,20,0,0")
echo "Response: $RESPONSE"
JOB_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])" 2>/dev/null)
echo "Job ID: $JOB_ID"

if [ -z "$JOB_ID" ]; then
    echo "ERROR: No job ID"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

# Poll for completion
echo "=== Polling ==="
for i in $(seq 1 60); do
    STATUS=$(curl -s http://localhost:8000/status/$JOB_ID 2>/dev/null)
    if [ -z "$STATUS" ]; then
        echo "[$i] Empty response, server may have died"
        break
    fi
    PROGRESS=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('progress', '?'))" 2>/dev/null)
    STATE=$(echo "$STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status', '?'))" 2>/dev/null)
    echo "[$i] status=$state progress=$PROGRESS"
    if [ "$STATE" = "done" ] || [ "$STATE" = "error" ]; then
        break
    fi
    sleep 2
done

# Download result
echo "=== Downloading result ==="
curl -s http://localhost:8000/result/$JOB_ID -o /home/z/my-project/download/v6_api_final.mp4
ls -la /home/z/my-project/download/v6_api_final.mp4 2>/dev/null
file /home/z/my-project/download/v6_api_final.mp4 2>/dev/null

# Show server logs
echo "=== Server logs (last 20 lines) ==="
tail -20 /tmp/server_run.log

# Cleanup
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
