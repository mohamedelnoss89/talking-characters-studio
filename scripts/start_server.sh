#!/bin/bash
# Watchdog script that keeps the server alive
cd /home/z/my-project/backend
exec /home/z/.venv/bin/python -u server.py
