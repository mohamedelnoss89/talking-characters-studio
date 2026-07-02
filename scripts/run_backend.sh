#!/bin/bash
# Persistent backend launcher
# Add libGLESv2.so.2 / libEGL.so.1 to library path for mediapipe
cd /home/z/my-project/backend
export LD_LIBRARY_PATH="/home/z/my-project/.libs:$LD_LIBRARY_PATH"
exec /home/z/.venv/bin/python3 -u server.py >> server.log 2>&1
