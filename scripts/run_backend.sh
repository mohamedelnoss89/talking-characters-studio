#!/bin/bash
# Persistent backend launcher
cd /home/z/my-project/backend
exec /home/z/.venv/bin/python3 -u server.py >> server.log 2>&1
