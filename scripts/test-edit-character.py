#!/usr/bin/env python3
"""Test the edit-character endpoint end-to-end."""
import json
import time
import urllib.request

BASE = "http://localhost:8000"

# 1. Generate a character first
print("=== Step 1: Generate character ===")
req = urllib.request.Request(
    f"{BASE}/generate-character",
    data=json.dumps({"prompt": "businessman", "style": "realistic", "gender": "male"}).encode(),
    headers={"Content-Type": "application/json"},
)
resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
job_id = resp["job_id"]
print(f"Gen job: {job_id}")

# Poll for completion
img_b64 = None
for i in range(20):
    time.sleep(3)
    resp = json.loads(urllib.request.urlopen(f"{BASE}/generate-character/{job_id}", timeout=5).read())
    print(f"  Poll {i+1}: {resp['status']} {resp.get('progress', 0)}%")
    if resp["status"] == "completed":
        img_b64 = resp["image_base64"]
        print(f"  ✓ Generated! Image size: {len(img_b64)} chars")
        break
    if resp["status"] == "error":
        print(f"  ✗ Error: {resp.get('error')}")
        exit(1)

if not img_b64:
    print("✗ Generation timed out")
    exit(1)

# 2. Edit the character
print("\n=== Step 2: Edit character (add sunglasses) ===")
req = urllib.request.Request(
    f"{BASE}/edit-character",
    data=json.dumps({"image_base64": img_b64, "edit_prompt": "add stylish sunglasses", "language": "en"}).encode(),
    headers={"Content-Type": "application/json"},
)
resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
edit_job_id = resp["job_id"]
print(f"Edit job: {edit_job_id}")

# Poll for completion
for i in range(40):
    time.sleep(3)
    resp = json.loads(urllib.request.urlopen(f"{BASE}/edit-character/{edit_job_id}", timeout=5).read())
    print(f"  Poll {i+1}: {resp['status']} {resp.get('progress', 0)}% - {resp.get('message', '')}")
    if resp["status"] == "completed":
        edited_b64 = resp["image_base64"]
        print(f"  ✓ Edited! New image size: {len(edited_b64)} chars")
        # Save the edited image
        import base64
        with open("/tmp/edited-character.png", "wb") as f:
            f.write(base64.b64decode(edited_b64))
        print(f"  Saved to /tmp/edited-character.png")
        break
    if resp["status"] == "error":
        print(f"  ✗ Error: {resp.get('error')}")
        exit(1)

print("\n=== ✅ Test passed! ===")
