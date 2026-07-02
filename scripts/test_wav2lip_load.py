"""Quick test - just load the model to verify everything works"""
import sys
import os
sys.path.insert(0, '/home/z/my-project/backend')

print("Step 1: importing wav2lip_runner...")
try:
    import wav2lip_runner
    print("OK")
except Exception as e:
    print(f"FAIL: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\nStep 2: loading model...")
try:
    model = wav2lip_runner.load_model()
    print(f"OK - model loaded: {type(model).__name__}")
except Exception as e:
    print(f"FAIL: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\nStep 3: checking audio module...")
try:
    import audio as w2l_audio
    print(f"OK - audio module: {w2l_audio}")
except Exception as e:
    print(f"FAIL: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\nAll checks passed!")
