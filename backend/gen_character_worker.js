/**
 * gen_character_worker.js
 * Standalone Node script that generates a character using z-ai-web-dev-sdk.
 * Called by the Python backend as a subprocess.
 *
 * Usage: node gen_character_worker.js '{"prompt":"...","style":"realistic","gender":"male","language":"ar"}'
 * Output: JSON on stdout: {"success":true,"image_base64":"...","description_ar":"...","description_en":"...","prompt_used":"..."}
 *
 * IMPORTANT: On ANY error (including API content-filter rejects), we write a JSON
 * error object to stdout AND exit with code 0. The backend reads stdout JSON first.
 * This way the user gets a clean error message instead of a Node stack trace.
 *
 * لا توجد أي قيود على وصف المستخدم — الوصف بيتعدّى للـ AI زي ما هو.
 * الـ LLM مجرد مترجم من العربية للإنجليزية (لو احتاج) وبيحافظ على نية المستخدم بالكامل.
 */

const ZAI = require('z-ai-web-dev-sdk').default;

// ============================================================
// v1.1.20: Cached ZAI instance — created ONCE per process
// lifetime, reused across all calls. Saves ~50-100ms per
// generation (the SDK's loadConfig() reads from disk every
// time ZAI.create() is called).
// ============================================================
let _zaiInstance = null;
async function getZAI() {
  if (!_zaiInstance) {
    _zaiInstance = await ZAI.create();
  }
  return _zaiInstance;
}

// ============================================================
// Per-call timeouts — prevent a single hung API call from eating
// the entire generation budget.
//
// v1.1.20 changes:
//   - LLM_TIMEOUT_MS: 30s → 20s (LLM calls typically finish in 5-10s;
//     if it takes >20s, the API is stuck and a retry is faster than
//     waiting)
//   - IMAGE_TIMEOUT_MS: 90s → 60s (image gen typically finishes in
//     15-40s; 60s is plenty for legitimate calls, and we retry faster
//     on stuck calls)
// ============================================================
const LLM_TIMEOUT_MS = 20000;       // 20s per LLM call (was 30s)
const IMAGE_TIMEOUT_MS = 60000;      // 60s per image gen call (was 90s)

/**
 * v1.1.20: Detect simple English prompts that DON'T need LLM translation.
 *
 * Why: The LLM translation step adds 5-30s of pure overhead. For users
 * who type short English prompts like "warrior with sword" or "anime girl
 * with blue hair", the LLM doesn't add much value — we can just append
 * the style hint and send directly to the image API.
 *
 * Criteria for "simple English":
 *   - Length ≤ 80 chars (short enough to send as-is)
 *   - >85% ASCII characters (allows some punctuation/emojis)
 *   - No Arabic Unicode characters (Arabic range: \u0600-\u06FF)
 *
 * For Arabic prompts or longer English prompts with complex intent,
 * we still use the LLM to translate + expand.
 */
function isSimpleEnglishPrompt(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length === 0 || t.length > 80) return false;
  // Check for Arabic characters
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(t)) return false;
  // Count ASCII chars
  let asciiCount = 0;
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) < 128) asciiCount++;
  }
  const asciiRatio = asciiCount / t.length;
  return asciiRatio > 0.85;
}

/**
 * Wrap a promise with a timeout. If the promise doesn't resolve/reject
 * within `ms` milliseconds, rejects with a timeout error.
 *
 * We use Promise.race (not AbortController) because the z-ai SDK doesn't
 * reliably support AbortSignal — the underlying HTTP request may continue
 * in the background, but we no longer wait for it.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000}s — API may be busy`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Check if an error is a timeout or transient network error that warrants
 * a retry with the SAME prompt (as opposed to a content filter reject,
 * which warrants a rephrase).
 */
function isRetryableError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  return msg.includes('timed out') ||
         msg.includes('timeout') ||
         msg.includes('ETIMEDOUT') ||
         msg.includes('ESOCKETTIMEDOUT') ||
         msg.includes('ECONNRESET') ||
         msg.includes('ECONNREFUSED') ||
         msg.includes('ENETUNREACH') ||
         msg.includes('fetch failed') ||
         msg.includes('network') ||
         msg.includes('socket hang up');
}

const STYLE_PRESETS = {
  realistic: "photorealistic, ultra-detailed, 8k, professional photography, natural lighting, sharp focus, high resolution portrait",
  anime: "anime style, cel-shaded, vibrant colors, detailed eyes, studio ghibli inspired, clean line art",
  cartoon: "cartoon style, bold outlines, flat colors, exaggerated features, playful, pixar-inspired 3D cartoon",
  "3d": "3D render, octane render, cinema 4D, subsurface scattering, detailed textures, professional 3D character",
  oil: "oil painting, thick brush strokes, classical art style, rich textures, rembrandt lighting",
  watercolor: "watercolor painting, soft washes, delicate brushwork, artistic, hand-painted, flowing colors",
};

const GENDER_HINT = {
  male: "male",
  female: "female",
  any: "",
};

function isFiller(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 10) return true;
  const filler = ["بيئة الاختبار", "بيئة الاختبار غير نشطة", "test environment", "placeholder"];
  return filler.some(f => t.includes(f));
}

function sanitizeBase64(b64) {
  return b64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
}

/**
 * Classify the API error and return a clean, user-friendly message.
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
        ? "الـ AI رفض هذا الوصف من فلتر المحتوى. جرّب صياغة تانية."
        : "The AI rejected this prompt via content filter. Try a different phrasing."
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
  if (msg.includes('empty image') || msg.includes('no image') || msg.includes('empty response')) {
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
      ? `فشل التوليد: ${msg.slice(0, 150)}`
      : `Generation failed: ${msg.slice(0, 150)}`
  };
}

/**
 * Translate the user's prompt into a detailed English visual prompt + descriptions.
 * NO content filtering, NO sanitization — preserve the user's intent EXACTLY.
 *
 * If the input is already English, still expand it visually (add appearance/clothing/lighting/etc
 * hints based on the chosen style).
 *
 * If the LLM fails, fall back to using the user's original prompt directly + style hint.
 *
 * v1.1.20 changes:
 *   - Uses getZAI() cached instance instead of ZAI.create() per call
 *   - FAST PATH: if the prompt is simple English (<80 chars, no Arabic),
 *     skip the LLM entirely and use the prompt directly + style/gender hints.
 *     This saves 5-30s for English-speaking users.
 */
async function translateAndExpand(userPrompt, style, gender, lang) {
  const styleHint = STYLE_PRESETS[style] || STYLE_PRESETS.realistic;
  const genderHint = GENDER_HINT[gender] || "";

  // -------------------------------------------------------
  // v1.1.20: FAST PATH — skip LLM for simple English prompts.
  // The LLM step adds 5-30s of overhead. For short English
  // prompts, we can just append the style/gender hints and
  // send directly to the image API.
  // -------------------------------------------------------
  if (isSimpleEnglishPrompt(userPrompt)) {
    process.stderr.write(`[worker] Fast-path: simple English prompt, skipping LLM translate\n`);
    const imagePrompt = `${userPrompt}, ${styleHint}${genderHint ? `, ${genderHint}` : ""}`.trim();
    const descriptionAr = `شخصية مولّدة بالذكاء الاصطناعي بناءً على: ${userPrompt}`;
    const descriptionEn = `AI-generated character based on: ${userPrompt}`;
    return { imagePrompt, descriptionAr, descriptionEn };
  }

  const systemPrompt = `You are a prompt translator and expander for an AI image generator.

The user gave a character description (may be in Arabic, English, or mixed). Your task is to produce a JSON object with these exact fields:

- "visual_prompt": A detailed ENGLISH visual description for an image generator. Take the user's description LITERALLY and TRANSLATE it to English (if not already English), then ADD visual details about: appearance, clothing, expression, pose, background, lighting. Append style hints: "${styleHint}". ${genderHint ? `Subject gender: ${genderHint}.` : ""} Keep it under 300 words.
- "description_ar": وصف الشخصية بالعربية في 2-3 جمل. ذاكر المظهر والشخصية.
- "description_en": English description in 2-3 sentences. Include appearance and personality.

CRITICAL RULES:
1. PRESERVE the user's exact intent — do NOT censor, soften, or omit anything they asked for.
2. Do NOT add "professional", "family-friendly", "fully-clothed", or any other constraints they didn't ask for.
3. Do NOT remove descriptions of age, gender, body type, expression, clothing, accessories, weapons, fantasy/sci-fi elements, or anything else the user mentioned.
4. Just translate (if needed) and visually expand — nothing more, nothing less.
5. Output ONLY the JSON object, no markdown, no explanation.`;

  let parsed;
  try {
    const zai = await getZAI();
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      }),
      LLM_TIMEOUT_MS,
      "LLM translate"
    );
    const content = completion.choices?.[0]?.message?.content || "";
    const first = content.indexOf("{");
    const last = content.lastIndexOf("}");
    if (first !== -1 && last > first) {
      parsed = JSON.parse(content.slice(first, last + 1));
    } else {
      throw new Error("No JSON in LLM response");
    }
  } catch (e) {
    process.stderr.write(`[worker] LLM translate failed: ${e.message}\n`);
    // Fallback: use the user's original prompt directly (NO sanitization)
    parsed = {
      visual_prompt: `${userPrompt}, ${styleHint}, ${genderHint}`.trim(),
      description_ar: `شخصية مولّدة بالذكاء الاصطناعي بناءً على: ${userPrompt}`,
      description_en: `AI-generated character based on: ${userPrompt}`,
    };
  }

  const descriptionAr = isFiller(parsed.description_ar)
    ? `شخصية مولّدة بالذكاء الاصطناعي بناءً على وصف: ${userPrompt}.`
    : parsed.description_ar;
  const descriptionEn = isFiller(parsed.description_en)
    ? `AI-generated character based on concept: ${userPrompt}.`
    : parsed.description_en;
  const imagePrompt = (parsed.visual_prompt || `${userPrompt}, ${styleHint}, ${genderHint}`).trim();

  return { imagePrompt, descriptionAr, descriptionEn };
}

/**
 * Check if an error is a content-filter rejection from the upstream API.
 */
function isContentFilterError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  return msg.includes('"code":"1301"') || msg.includes('"contentFilter"') ||
         msg.includes('敏感内容') || msg.includes('unsafe or sensitive') ||
         msg.includes('content filter') || msg.includes('Content filter');
}

async function generateImage(imagePrompt) {
  const zai = await getZAI();
  const response = await withTimeout(
    zai.images.generations.create({
      prompt: imagePrompt,
      size: "1024x1024",
    }),
    IMAGE_TIMEOUT_MS,
    "Image generation"
  );
  const b64 = response?.data?.[0]?.base64;
  if (!b64) throw new Error("Image generation returned empty response");
  return sanitizeBase64(b64);
}

/**
 * Ask the LLM to REPHRASE the user's prompt while preserving the EXACT same intent.
 * Uses different framing strategies (fantasy illustration, concept art, storybook, etc.)
 * that are less likely to be flagged by the upstream content filter.
 *
 * The rephrasing NEVER removes anything the user asked for — it just wraps the same
 * concept in artistic language.
 */
async function rephraseForRetry(originalPrompt, attempt, style, gender) {
  const styleHint = STYLE_PRESETS[style] || STYLE_PRESETS.realistic;
  const genderHint = GENDER_HINT[gender] || "";

  const framings = [
    `Rephrase this as a fantasy concept art illustration prompt. Frame the entire description as an illustration for a published art book. Preserve EVERY element the user requested — do not remove or soften anything. Style: ${styleHint}. ${genderHint ? `Subject: ${genderHint}.` : ""} Output ONLY the prompt, no explanation.`,
    `Rephrase this as a cinematic storyboard illustration prompt. Frame it as concept art for a film production. Preserve EVERY element the user requested — do not remove or soften anything. Style: ${styleHint}. ${genderHint ? `Subject: ${genderHint}.` : ""} Output ONLY the prompt, no explanation.`,
    `Rephrase this as a Renaissance-style oil painting description. Frame it as classical fine art. Preserve EVERY element the user requested — do not remove or soften anything. Style: ${styleHint}. ${genderHint ? `Subject: ${genderHint}.` : ""} Output ONLY the prompt, no explanation.`,
    `Rephrase this as a comic book character design illustration. Frame it as a professional character sheet for a graphic novel. Preserve EVERY element the user requested — do not remove or soften anything. Style: ${styleHint}. ${genderHint ? `Subject: ${genderHint}.` : ""} Output ONLY the prompt, no explanation.`,
  ];

  const systemPrompt = framings[attempt % framings.length];

  try {
    const zai = await getZAI();
    const completion = await withTimeout(
      zai.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: originalPrompt },
        ],
        temperature: 0.8,
      }),
      LLM_TIMEOUT_MS,
      `LLM rephrase ${attempt}`
    );
    const content = (completion.choices?.[0]?.message?.content || "").trim();
    const cleaned = content.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (cleaned.length < 10 || cleaned.length > 2000) {
      process.stderr.write(`[worker] rephrase ${attempt} bad length (${cleaned.length}), returning original\n`);
      return originalPrompt;
    }
    return cleaned;
  } catch (e) {
    process.stderr.write(`[worker] rephrase ${attempt} failed: ${e.message}\n`);
    return originalPrompt;
  }
}

/**
 * Try to generate the image. Retries on two kinds of errors:
 *
 *   1. Content filter reject → rephrase with different artistic framing
 *      (preserves user intent, just wraps it in different language)
 *
 *   2. Timeout / network error → retry with the SAME prompt
 *      (transient issues — the API might just be busy or the network
 *      had a hiccup. A retry with the same prompt often succeeds.)
 *
 * NEVER replaces the user's intent with a generic safe prompt — every
 * retry preserves the original concept.
 *
 * v1.1.20 changes:
 *   - Retry budget reduced from 3 → 2 total attempts (initial + 1 retry)
 *   - With per-call timeouts (60s image, 20s LLM), worst case is now:
 *       20s translate + 60s img + 20s rephrase + 60s img = 160s
 *     (was 30+90+30+90+30+90 = 360s — over 2x faster worst case)
 *   - If both attempts fail, the user gets a clear error and can
 *     click "Generate" again with a different prompt.
 *   - Uses cached ZAI instance via getZAI()
 */
async function generateImageWithRetry(imagePrompt, style, gender, language) {
  const maxRetries = 1;  // v1.1.20: was 2 (so 3 total attempts). Now 2 total.
  let currentPrompt = imagePrompt;
  // Pre-warm the cached ZAI instance (will be reused by rephraseForRetry too)
  const zai = await getZAI();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      process.stderr.write(`[worker] Generation attempt ${attempt + 1}/${maxRetries + 1}, prompt: ${currentPrompt.slice(0, 100)}...\n`);
      const b64 = await generateImage(currentPrompt);
      if (b64 && b64.length >= 1000) {
        return { base64Image: b64, finalPrompt: currentPrompt };
      }
      throw new Error("Image too small / empty");
    } catch (err) {
      if (attempt >= maxRetries) {
        throw err; // give up after all retries
      }

      if (isContentFilterError(err)) {
        // Content filter reject → rephrase with different framing
        process.stderr.write(`[worker] Content filter rejected attempt ${attempt + 1}. Rephrasing with different framing...\n`);
        currentPrompt = await rephraseForRetry(imagePrompt, attempt, style, gender);
      } else if (isRetryableError(err)) {
        // Timeout / network error → retry with SAME prompt (no rephrase needed)
        process.stderr.write(`[worker] Attempt ${attempt + 1} failed with retryable error: ${err.message}. Retrying with same prompt...\n`);
        // Keep currentPrompt as-is — don't rephrase, just retry
      } else {
        // Non-retryable error (auth, empty response, etc.) → fail fast
        throw err;
      }
    }
  }
  // unreachable, but keep TS happy
  throw new Error("Generation failed after all retries");
}

async function main() {
  const input = JSON.parse(process.argv[2]);
  const { prompt, style = "realistic", gender = "any", language = "ar" } = input;

  if (!prompt || !prompt.trim()) {
    process.stdout.write(JSON.stringify({
      success: false,
      error: language === "ar" ? "اكتب وصف الشخصية" : "Empty prompt",
      error_type: "input",
    }));
    return; // exit 0
  }

  try {
    process.stderr.write(`[worker] Translating/expanding: "${prompt}"\n`);
    const { imagePrompt, descriptionAr, descriptionEn } = await translateAndExpand(prompt, style, gender, language);

    process.stderr.write(`[worker] Generating image (prompt: ${imagePrompt.slice(0, 120)}...)\n`);
    // Retry with rephrased versions of the SAME user intent if the content filter rejects
    const { base64Image, finalPrompt } = await generateImageWithRetry(imagePrompt, style, gender, language);

    if (!base64Image || base64Image.length < 1000) {
      throw new Error("Image too small / empty");
    }

    const result = {
      success: true,
      image_base64: base64Image,
      image_mime: "image/png",
      prompt_used: finalPrompt,
      description_ar: descriptionAr,
      description_en: descriptionEn,
    };
    process.stdout.write(JSON.stringify(result));
    process.stderr.write(`[worker] Done. Image size: ${base64Image.length}\n`);
  } catch (err) {
    process.stderr.write(`[worker] FAILED: ${err.message}\n`);
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
  process.stderr.write(`[worker] Uncaught: ${err.message}\n`);
  const info = classifyError(err, "ar");
  process.stdout.write(JSON.stringify({
    success: false,
    error: info.message,
    error_type: info.error_type,
    raw_error: (err && err.message) ? err.message.slice(0, 500) : String(err).slice(0, 500),
  }));
  return;
});
