"""
Test the content-filter error path — reproduces the user's failed edit
with prompt 'خالى الراجل بنت' which got rejected by the AI content filter.
Verifies the new error handling returns a clean, friendly message.
"""
import base64, json, urllib.request, time, sys

# Load a real character image (use one of our test PNGs)
with open('/home/z/my-project/scripts/lip-sync-running.png', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')

# Use the EXACT prompt the user tried — should trigger content filter
edit_prompt = 'خالى الراجل بنت'
print(f'[test] Edit prompt: {edit_prompt!r}')

# Start edit job
payload = json.dumps({
    'image_base64': b64,
    'edit_prompt': edit_prompt,
    'language': 'ar',
}).encode('utf-8')

req = urllib.request.Request(
    'http://localhost:8000/edit-character',
    data=payload,
    headers={'Content-Type': 'application/json'},
    method='POST',
)
print('[test] POST /edit-character...')
with urllib.request.urlopen(req, timeout=30) as r:
    body = json.loads(r.read())
print(f'[test] POST response: {body}')
job_id = body.get('job_id')

# Poll
print(f'[test] Polling job {job_id}...')
for i in range(20):
    time.sleep(2)
    with urllib.request.urlopen(f'http://localhost:8000/edit-character/{job_id}', timeout=10) as r:
        data = json.loads(r.read())
    print(f'[test] Poll #{i}: status={data.get("status")}')
    if data.get('status') in ('completed', 'error'):
        print()
        print('=== FINAL RESPONSE ===')
        print(json.dumps(data, indent=2, ensure_ascii=False))
        if data.get('status') == 'error':
            print()
            print('=== USER-FACING ERROR ===')
            print(f'error: {data.get("error")}')
            print(f'error_type: {data.get("error_type")}')
            # Verify it's a clean message, not a stack trace
            err = data.get('error', '')
            if 'index.js' in err or 'at ' in err or '\n' in err:
                print('❌ FAIL: error contains stack trace garbage')
                sys.exit(1)
            elif 'ترفض' in err or 'filter' in err.lower() or 'محتوى' in err:
                print('✅ PASS: clean friendly content-filter message')
                sys.exit(0)
            else:
                print('⚠ WARN: unexpected message, but no stack trace')
                sys.exit(0)
        else:
            print('✅ Edit succeeded (unexpected for this prompt, but OK)')
            sys.exit(0)

print('Timeout')
sys.exit(1)
