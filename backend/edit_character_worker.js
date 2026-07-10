/**
 * edit_character_worker.js
 * Standalone Node script that edits an existing character image using z-ai-web-dev-sdk.
 * Reads JSON input from STDIN (not argv) to avoid "Argument list too long" errors.
 * Called by the Python backend as a subprocess.
 *
 * Usage: echo '{"image_base64":"...","edit_prompt":"add a hat"}' | node edit_character_worker.js
 * Output: JSON on stdout: {"success":true,"image_base64":"..."}
 *
 * IMPORTANT: On ANY error (including API content-filter rejects), we write a JSON
 * error object to stdout AND exit with code 0. The backend reads stdout JSON first.
 * This way the user gets a clean error message instead of a Node stack trace.
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

/**
 * Classify the API error and return a clean, user-friendly message.
 * Detects content filter rejects (code 1301) and other common API errors.
 */
function classifyError(err, language) {
  const msg = (err && err.message) ? err.message : String(err);
  const isAr = language === "ar";

  // Content filter rejection: code 1301 or "contentFilter" in the response
  if (msg.includes('"code":"1301"') || msg.includes('"contentFilter"') ||
      msg.includes('敏感内容') || msg.includes('unsafe or sensitive')) {
    return {
      error_type: "content_filter",
      message: isAr
        ? "الوصف اللي كتبته اترفض من فلتر المحتوى في الـ AI. جرّب صياغة تانية (تجنّب تغيير الجنس أو أوصاف حساسة)."
        : "Your edit prompt was rejected by the AI content filter. Try a different phrasing (avoid gender changes or sensitive descriptions)."
    };
  }

  // Rate limit
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit')) {
    return {
      error_type: "rate_limit",
      message: isAr
        ? "الـ AI مشغول دلوقتي — استنى دقيقة وجرّب تاني"
        : "AI is busy right now — wait a minute and try again"
    };
  }

  // Auth error
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('Unauthorized')) {
    return {
      error_type: "auth",
      message: isAr
        ? "مشكلة في الـ API key — تواصل مع الدعم"
        : "API key issue — contact support"
    };
  }

  // Server error
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
    return {
      error_type: "server",
      message: isAr
        ? "الـ AI سيرفر فيه مشكلة مؤقتة — جرّب تاني بعد شوية"
        : "AI server is having a temporary issue — try again shortly"
    };
  }

  // Empty result
  if (msg.includes('empty image') || msg.includes('no image')) {
    return {
      error_type: "empty",
      message: isAr
        ? "الـ AI مارجّعش صورة — جرّب وصف مختلف"
        : "AI returned no image — try a different description"
    };
  }

  // Generic fallback — keep the original message but trim it
  return {
    error_type: "unknown",
    message: isAr
      ? `فشل التعديل: ${msg.slice(0, 150)}`
      : `Edit failed: ${msg.slice(0, 150)}`
  };
}

async function main() {
  // Read JSON from stdin
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`[edit-worker] Invalid JSON input: ${e.message}\n`);
    process.stdout.write(JSON.stringify({
      success: false,
      error: "Invalid JSON input",
      error_type: "input",
    }));
    return;  // exit 0 — backend will read stdout
  }

  const { image_base64, edit_prompt, language = "ar" } = input;

  if (!image_base64 || image_base64.length < 1000) {
    process.stdout.write(JSON.stringify({
      success: false,
      error: language === "ar" ? "صورة غير صالحة" : "Invalid source image",
      error_type: "input",
    }));
    return;
  }
  if (!edit_prompt || !edit_prompt.trim()) {
    process.stdout.write(JSON.stringify({
      success: false,
      error: language === "ar" ? "اكتب التعديل المطلوب" : "Empty edit prompt",
      error_type: "input",
    }));
    return;
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
    const info = classifyError(err, language);
    process.stdout.write(JSON.stringify({
      success: false,
      error: info.message,
      error_type: info.error_type,
      raw_error: (err && err.message) ? err.message.slice(0, 500) : String(err).slice(0, 500),
    }));
    // IMPORTANT: exit 0 — the backend reads stdout JSON, not stderr
    return;
  }
}

main().catch(err => {
  process.stderr.write(`[edit-worker] Uncaught: ${err.message}\n`);
  const info = classifyError(err, "ar");
  process.stdout.write(JSON.stringify({
    success: false,
    error: info.message,
    error_type: info.error_type,
    raw_error: (err && err.message) ? err.message.slice(0, 500) : String(err).slice(0, 500),
  }));
  return;
});
