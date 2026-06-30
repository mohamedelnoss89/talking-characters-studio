#!/bin/bash
# Keeps the Wav2Lip server alive - restarts if it dies
while true; do
    if ! pgrep -f "server.py" > /dev/null 2>&1; then
        echo "[$(date)] Starting server..." >> /home/z/my-project/backend/server_watchdog.log
        cd /home/z/my-project/backend
        /home/z/.venv/bin/python -u server.py >> /home/z/my-project/backend/server.log 2>&1 &
        SERVER_PID=$!
        echo "[$(date)] Server started with PID $SERVER_PID" >> /home/z/my-project/backend/server_watchdog.log
        # Wait for it to be ready or die
        sleep 15
    else
        sleep 5
    fi
done
