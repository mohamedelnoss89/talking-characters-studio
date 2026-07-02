#!/bin/bash
# Persistent Next.js dev server launcher
cd /home/z/my-project
exec npm run dev >> /home/z/my-project/dev.log 2>&1
