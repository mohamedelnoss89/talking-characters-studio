/**
 * Test the edit_character_worker.js directly to see what fails.
 * Generates a small PNG, then asks the worker to edit it.
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// 1) Create a tiny 512x512 PNG via Node Buffer (no deps): solid color block.
// Use a simpler approach: just use an existing image from the project if available.
const testImgCandidates = [
  '/home/z/my-project/scripts/lip-sync-running.png',
  '/home/z/my-project/scripts/preview-running.png',
];

let imgPath = null;
for (const p of testImgCandidates) {
  if (fs.existsSync(p)) { imgPath = p; break; }
}
if (!imgPath) {
  console.error('No test image found');
  process.exit(2);
}

console.log(`[test] Using image: ${imgPath}`);
const buf = fs.readFileSync(imgPath);
const b64 = buf.toString('base64');
console.log(`[test] Image b64 length: ${b64.length}`);

const payload = JSON.stringify({
  image_base64: b64,
  edit_prompt: 'add a red hat',
  language: 'en',
});

console.log(`[test] Payload size: ${payload.length} bytes`);
console.log('[test] Spawning edit_character_worker.js...');

const t0 = Date.now();
const result = spawnSync('node', ['/home/z/my-project/backend/edit_character_worker.js'], {
  input: payload,
  encoding: 'utf8',
  timeout: 120000,
});

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[test] Worker exited in ${elapsed}s with code ${result.status}`);

console.log('\n=== STDOUT (first 500 chars) ===');
console.log((result.stdout || '').slice(0, 500));
console.log('\n=== STDERR (full) ===');
console.log(result.stderr || '(empty)');

// Try to parse stdout JSON
try {
  const out = result.stdout.trim();
  const first = out.indexOf('{');
  const last = out.lastIndexOf('}');
  if (first !== -1 && last !== -1) {
    const parsed = JSON.parse(out.slice(first, last + 1));
    console.log('\n=== PARSED RESULT ===');
    console.log('success:', parsed.success);
    console.log('error:', parsed.error);
    if (parsed.image_base64) {
      console.log('image_base64 length:', parsed.image_base64.length);
    }
  }
} catch (e) {
  console.log('\nFailed to parse JSON:', e.message);
}
