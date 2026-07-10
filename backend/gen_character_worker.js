/**
 * gen_character_worker.js
 * Standalone Node script that generates a character using z-ai-web-dev-sdk.
 * Called by the Python backend as a subprocess.
 *
 * Usage: node gen_character_worker.js '{"prompt":"...","style":"realistic","gender":"male","language":"ar"}'
 * Output: JSON on stdout: {"success":true,"image_base64":"...","description_ar":"...","description_en":"...","prompt_used":"..."}
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

async function expandConcept(userPrompt, style, gender, lang) {
  const styleHint = STYLE_PRESETS[style] || STYLE_PRESETS.realistic;
  const genderHint = GENDER_HINT[gender] || "";

  const systemPrompt = `You are a character designer. The user wants a character based on: "${userPrompt}".
Generate a JSON object with these exact fields:
- "visual_prompt": A detailed English visual description for an image generator. Include: appearance, clothing, expression, pose, background, lighting. Combine with: ${styleHint}. ${genderHint}. Keep it under 300 words.
- "description_ar": وصف الشخصية بالعربية في 2-3 جمل. ذاكر الاسم المقترح والمظهر والشخصية.
- "description_en": English description in 2-3 sentences. Include suggested name, appearance, and personality.

Output ONLY the JSON object, no markdown, no explanation.`;

  let parsed;
  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
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
    parsed = {
      visual_prompt: `${userPrompt}, ${styleHint}, ${genderHint}, portrait, high quality`,
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

async function main() {
  const input = JSON.parse(process.argv[2]);
  const { prompt, style = "realistic", gender = "any", language = "ar" } = input;

  if (!prompt || !prompt.trim()) {
    process.stdout.write(JSON.stringify({ success: false, error: "Empty prompt" }));
    process.exit(1);
  }

  try {
    process.stderr.write(`[worker] Expanding concept for: "${prompt}"\n`);
    const { imagePrompt, descriptionAr, descriptionEn } = await expandConcept(prompt, style, gender, language);

    process.stderr.write(`[worker] Generating image (prompt: ${imagePrompt.slice(0, 80)}...)\n`);
    const base64Image = await generateImage(imagePrompt);

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
    process.stdout.write(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`[worker] Uncaught: ${err.message}\n`);
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
