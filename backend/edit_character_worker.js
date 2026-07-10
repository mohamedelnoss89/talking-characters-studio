/**
 * edit_character_worker.js
 * Standalone Node script that edits an existing character image using z-ai-web-dev-sdk.
 * Reads JSON input from STDIN (not argv) to avoid "Argument list too long" errors.
 * Called by the Python backend as a subprocess.
 *
 * Usage: echo '{"image_base64":"...","edit_prompt":"add a hat"}' | node edit_character_worker.js
 * Output: JSON on stdout: {"success":true,"image_base64":"..."}
 */

const ZAI = require('z-ai-web-dev-sdk').default;

function sanitizeBase64(b64) {
  return b64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  // Read JSON from stdin
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[edit-worker] Invalid JSON input: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ success: false, error: "Invalid JSON input" }));
    process.exit(1);
  }

  const { image_base64, edit_prompt, language = "ar" } = input;

  if (!image_base64 || image_base64.length < 1000) {
    process.stdout.write(JSON.stringify({ success: false, error: "Invalid source image" }));
    process.exit(1);
  }
  if (!edit_prompt || !edit_prompt.trim()) {
    process.stdout.write(JSON.stringify({ success: false, error: "Empty edit prompt" }));
    process.exit(1);
  }

  try {
    const cleanB64 = sanitizeBase64(image_base64);
    const dataUrl = `data:image/png;base64,${cleanB64}`;

    process.stderr.write(`[edit-worker] Editing image with prompt: "${edit_prompt.slice(0, 80)}"\n`);
    process.stderr.write(`[edit-worker] Image size: ${cleanB64.length} chars\n`);

    const zai = await ZAI.create();
    const response = await zai.images.generations.edit({
      prompt: edit_prompt,
      images: [{ url: dataUrl }],
      size: "1024x1024",
    });

    const b64 = response?.data?.[0]?.base64;
    if (!b64 || b64.length < 1000) {
      throw new Error("Edit returned empty image");
    }

    const result = {
      success: true,
      image_base64: sanitizeBase64(b64),
      image_mime: "image/png",
      prompt_used: edit_prompt,
    };
    process.stdout.write(JSON.stringify(result));
    process.stderr.write(`[edit-worker] Done. New image size: ${result.image_base64.length}\n`);
  } catch (err) {
    process.stderr.write(`[edit-worker] FAILED: ${err.message}\n`);
    process.stdout.write(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`[edit-worker] Uncaught: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
