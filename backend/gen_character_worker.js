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
 */

const ZAI = require('z-ai-web-dev-sdk').default;

const STYLE_PRESETS = {
  realistic: "photorealistic, ultra-detailed, 8k, professional photography, natural lighting, sharp focus, high resolution portrait",
  anime: "anime style, cel-shaded, vibrant colors, detailed eyes, studio ghibli inspired, clean line art",
  cartoon: "cartoon style, bold outlines, flat colors, exaggerated features, playful, pixar-inspired 3D cartoon",
  "3d": "3D render, octane render, cinema 4D, subsurface scattering, detailed textures, professional 3D character",
  oil: "oil painting, thick brush strokes, classical art style, rich textures, rembrandt lighting",
  watercolor: "watercolor painting, soft washes, delicate brushwork, artistic, hand-painted, flowing colors",
};

const GENDER_HINT = {
  male: "male, man, masculine features",
  female: "female, woman, feminine features",
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
        ? "الوصف اللي كتبته اترفض من فلتر المحتوى في الـ AI. جرّب صياغة تانية أو اوصاف أبسط."
        : "Your prompt was rejected by the AI content filter. Try a simpler or different phrasing."
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
 * Expand the user's concept into a detailed English visual prompt + descriptions.
 * Uses LLM to translate Arabic → professional English character description.
 *
 * The system prompt is designed to produce professional, safe, filter-friendly
 * descriptions that won't trigger content filters.
 */
async function expandConcept(userPrompt, style, gender, lang) {
  const styleHint = STYLE_PRESETS[style] || STYLE_PRESETS.realistic;
  const genderHint = GENDER_HINT[gender] || "";

  const systemPrompt = `You are a professional character designer for a family-friendly creative studio. The user wants a character based on their description (which may be in Arabic or English).

Your task: Generate a JSON object with these exact fields:
- "visual_prompt": A detailed ENGLISH visual description for an image generator. Include: appearance, clothing, expression, pose, background, lighting. Combine with: ${styleHint}. ${genderHint}. Keep it under 300 words.
- "description_ar": وصف الشخصية بالعربية في 2-3 جمل. ذاكر الاسم المقترح والمظهر والشخصية.
- "description_en": English description in 2-3 sentences. Include suggested name, appearance, and personality.

IMPORTANT RULES for the visual_prompt:
1. Use professional, neutral, descriptive language only.
2. Describe the character as a fully-clothed, dignified professional portrait subject.
3. Use terms like "professional portrait", "character study", "studio photograph".
4. Do NOT include any suggestive, violent, or sensitive descriptors.
5. Keep the description focused on: face, hair, clothing style, pose, expression, background, lighting.
6. Translate any Arabic input to clean professional English first.

Output ONLY the JSON object, no markdown, no explanation.`;

  let parsed;
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
    });
    const content = completion.choices?.[0]?.message?.content || "";
    const first = content.indexOf("{");
    const last = content.lastIndexOf("}");
    if (first !== -1 && last > first) {
      parsed = JSON.parse(content.slice(first, last + 1));
    } else {
      throw new Error("No JSON in LLM response");
    }
  } catch (e) {
    process.stderr.write(`[worker] LLM expand failed: ${e.message}\n`);
    // Fallback: build a safe, simple prompt from the user's input + style
    // Translate Arabic to a generic safe description to avoid content filter
    parsed = {
      visual_prompt: `professional portrait photograph of a character, ${genderHint}, ${styleHint}, studio lighting, neutral background, high quality`,
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

async function generateImage(imagePrompt) {
  const zai = await ZAI.create();
  const response = await zai.images.generations.create({
    prompt: imagePrompt,
    size: "1024x1024",
  });
  const b64 = response?.data?.[0]?.base64;
  if (!b64) throw new Error("Image generation returned empty response");
  return sanitizeBase64(b64);
}

/**
 * Check if an error is a content-filter rejection.
 */
function isContentFilterError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  return msg.includes('"code":"1301"') || msg.includes('"contentFilter"') ||
         msg.includes('敏感内容') || msg.includes('unsafe or sensitive');
}

/**
 * Simplify a detailed visual prompt into a minimal, filter-safe version.
 * Strips potentially sensitive descriptors (ethnicity, age, etc.) and keeps
 * only the core concept + style.
 */
function simplifyPrompt(imagePrompt, style, gender) {
  const styleHint = STYLE_PRESETS[style] || STYLE_PRESETS.realistic;
  const genderHint = GENDER_HINT[gender] || "";
  // Build a minimal, generic prompt that's very unlikely to trigger filters
  return `professional portrait photograph, ${genderHint}, ${styleHint}, studio lighting, neutral background, high quality, friendly expression`;
}

/**
 * Try to generate an image. If the first attempt is rejected by the content
 * filter, retry ONCE with a simplified generic prompt.
 */
async function generateImageWithRetry(imagePrompt, style, gender) {
  try {
    return await generateImage(imagePrompt);
  } catch (err) {
    if (isContentFilterError(err)) {
      process.stderr.write(`[worker] Content filter rejected prompt. Retrying with simplified prompt...\n`);
      const simplified = simplifyPrompt(imagePrompt, style, gender);
      process.stderr.write(`[worker] Simplified prompt: ${simplified.slice(0, 80)}...\n`);
      return await generateImage(simplified);
    }
    throw err; // re-throw non-filter errors
  }
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
    process.stderr.write(`[worker] Expanding concept for: "${prompt}"\n`);
    const { imagePrompt, descriptionAr, descriptionEn } = await expandConcept(prompt, style, gender, language);

    process.stderr.write(`[worker] Generating image (prompt: ${imagePrompt.slice(0, 80)}...)\n`);
    const base64Image = await generateImageWithRetry(imagePrompt, style, gender);

    if (!base64Image || base64Image.length < 1000) {
      throw new Error("Image too small / empty");
    }

    const result = {
      success: true,
      image_base64: base64Image,
      image_mime: "image/png",
      prompt_used: imagePrompt,
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
