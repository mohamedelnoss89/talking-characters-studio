#!/bin/bash
# تشغيل Next.js dev server بطريقة مستقرة
cd /home/z/my-project

# قفل أي عملية next سابقة
pkill -f "next dev" 2>/dev/null
sleep 2

# تشغيل السيرفر في background مع setsid
setsid -f bash -c 'exec node_modules/.bin/next dev -p 3000 > dev.log 2>&1' < /dev/null > /dev/null 2>&1

# انتظار التشغيل
for i in {1..15}; do
  sleep 1
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null)
  if [ "$CODE" = "200" ]; then
    echo "Server is UP (HTTP $CODE after ${i}s)"
    exit 0
  fi
done

echo "Server failed to start"
tail -10 dev.log
exit 1
