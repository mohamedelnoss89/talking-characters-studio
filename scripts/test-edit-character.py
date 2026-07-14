#!/usr/bin/env python3
"""اختبر edit-character endpoint بـ session cookie."""
import json
import subprocess
import time
import urllib.request

# اقرأ الـ cookie من الملف
with open('/tmp/cookies2.txt') as f:
    cookie_val = None
    for line in f:
        line = line.rstrip('\n')
        if 'tcs_session' in line and 'HttpOnly' not in line.split('\t')[0].lstrip('#'):
            parts = line.split('\t')
            if len(parts) >= 7:
                cookie_val = parts[6]
                break
    # fallback: try HttpOnly line
    if not cookie_val:
        f.seek(0)
        for line in f:
            line = line.rstrip('\n')
            if 'tcs_session' in line:
                parts = line.split('\t')
                if len(parts) >= 7:
                    cookie_val = parts[6]
                    break

if not cookie_val:
    print("ERROR: No session cookie found")
    exit(1)

# اقرأ الصورة المولّدة
job_id = "gen_8093574d0506"
req = urllib.request.Request(
    f"http://localhost:3000/api/generate-character?id={job_id}",
    headers={"Cookie": f"tcs_session={cookie_val}"}
)
char_data = json.loads(urllib.request.urlopen(req, timeout=10).read())
img_b64 = char_data['image_base64']
print(f"Image base64 length: {len(img_b64)}")

# POST لـ edit-character
payload = json.dumps({
    "image_base64": img_b64,
    "edit_prompt": "add sunglasses",
    "language": "en"
}).encode('utf-8')

req2 = urllib.request.Request(
    "http://localhost:3000/api/edit-character",
    data=payload,
    headers={
        "Content-Type": "application/json",
        "Cookie": f"tcs_session={cookie_val}"
    },
    method="POST"
)
try:
    resp = urllib.request.urlopen(req2, timeout=30)
    result = json.loads(resp.read())
    print("Edit job started:", result)
    edit_job_id = result.get('job_id')
    if not edit_job_id:
        print("FAILED:", result)
        exit(1)
    
    # Poll
    for i in range(40):
        time.sleep(3)
        req3 = urllib.request.Request(
            f"http://localhost:3000/api/edit-character?id={edit_job_id}",
            headers={"Cookie": f"tcs_session={cookie_val}"}
        )
        status = json.loads(urllib.request.urlopen(req3, timeout=10).read())
        s = status.get('status')
        p = status.get('progress', 0)
        print(f"Poll {i+1}: status={s} progress={p}")
        if s == 'completed':
            print(f"SUCCESS - new image base64 length: {len(status.get('image_base64',''))}")
            break
        elif s == 'error':
            print(f"FAILED: {status.get('error','')}")
            break
except urllib.error.HTTPError as e:
    print(f"HTTP Error {e.code}: {e.read().decode()[:300]}")
except Exception as e:
    print(f"ERROR: {e}")
