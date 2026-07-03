/**
 * POST /api/generate-character
 * يدخّل وصف مختصر من المستخدم، يستخدم LLM عشان يوسّعه لـ prompt بصري
 * مفصّل، يولّد صورة شخصية بالـ z-ai-web-dev-sdk، ويرجع:
 *   - base64 PNG للصورة
 *   - prompt اللي استخدمناه
 *   - وصف الشخصية بالعربي والإنجليزي
 *
 * لا يحتاج الـ Python backend — كل الحاجة Node.js.
 */
import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // 5 دقايق - توليد الصور ممكن ياخد وقت

interface CharacterRequestBody {
  prompt?: string;
  style?: string;       // realistic | anime | cartoon | 3d | oil | watercolor
  gender?: string;      // male | female | any
  language?: "ar" | "en";
}

interface StylePreset {
  label: string;
  suffix: string;
}

const STYLE_PRESETS: Record<string, StylePreset> = {
  realistic: {
    label: "واقعي / Realistic",
    suffix:
      "photorealistic professional portrait, studio lighting, 85mm lens, sharp focus, ultra-detailed skin texture, high resolution photograph",
  },
  anime: {
    label: "أنمي / Anime",
    suffix:
      "anime style portrait, cel shading, vibrant colors, clean line art, studio ghibli inspired, beautiful detailed eyes",
  },
  cartoon: {
    label: "كرتون / Cartoon",
    suffix:
      "modern cartoon style portrait, bold clean lines, flat colors, friendly proportions, pixar-inspired 3D shading",
  },
  "3d": {
    label: "3D",
    suffix:
      "3D rendered portrait, octane render, soft global illumination, subsurface scattering on skin, cinematic lighting, ultra detailed",
  },
  oil: {
    label: "زيت / Oil painting",
    suffix:
      "classical oil painting portrait, rich brush strokes, chiaroscuro lighting, rembrandt style, museum quality",
  },
  watercolor: {
    label: "ألوان مائية / Watercolor",
    suffix:
      "watercolor portrait painting, soft washes, delicate color bleeds, traditional media, artistic, dreamy",
  },
};

const GENDER_HINT: Record<string, string> = {
  male: "adult male person",
  female: "adult female person",
  any: "person",
};

/**
 * يوسّع وصف المستخدم لـ prompt بصري مفصّل مناسب لتوليد صورة وجه.
 * ويرجع وصف نصي للشخصية بالعربي والإنجليزي.
 */
async function expandCharacterConcept(
  userPrompt: string,
  style: string,
  gender: string,
  lang: "ar" | "en"
): Promise<{ imagePrompt: string; descriptionAr: string; descriptionEn: string }> {
  const zai = await ZAI.create();
  const styleLabel = STYLE_PRESETS[style]?.label || STYLE_PRESETS.realistic.label;

  const systemPrompt = `You are a character designer for an AI talking-avatar app.
The user gives you a short concept. You must output ONLY a single JSON object (no markdown, no \`\`\` fences) with three fields:

{
  "visual_prompt": "an English prompt for an image generation model describing a single front-facing portrait. It MUST start with: 'front-facing portrait photo of <subject>, looking directly at camera, head and shoulders centered, plain solid background, even soft studio lighting, sharp focus'. Then add specific visual details: hair, eyes, skin tone, clothing, accessories, expression, atmosphere. Do NOT include any text/watermark/caption in the image.",
  "description_ar": "وصف الشخصية بالعربية في 2-4 جمل كاملة، ذاكر فيه الاسم المقترح، الشخصية، المظهر، ولهجة الصوت المناسبة. اكتبه كأنك تقدم الشخصية للمستخدم.",
  "description_en": "An English description of the character in 2-4 complete sentences, including suggested name, personality, appearance, and a suitable voice/accent hint."
}

CRITICAL RULES:
- The description MUST describe the SPECIFIC character the user asked for ("${userPrompt}").
- Do NOT output generic filler text like "بيئة الاختبار" / "test environment" / "this is a generic character" / "you can use this to test the app".
- Do NOT mention that the character is for testing or that this is a test environment.
- The subject MUST be a ${GENDER_HINT[gender] || "person"}.
- Visual style direction: ${styleLabel}.
- Keep it strictly valid JSON. No trailing commas. No comments. No code fences.`;

  const userMessage = `User concept: "${userPrompt}"
Style: ${styleLabel}
Gender: ${gender}
Output language for description_ar: Arabic. For description_en: English.
Return the JSON now.`;

  const completion = await zai.chat.completions.create({
    messages: [
      { role: "assistant", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    thinking: { type: "disabled" },
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || "";

  // استخرج JSON навy لو النموذج لفّه في code fences
  let jsonText = raw;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  } else {
    const braceStart = raw.indexOf("{");
    const braceEnd = raw.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
      jsonText = raw.slice(braceStart, braceEnd + 1);
    }
  }

  let parsed: { visual_prompt?: string; description_ar?: string; description_en?: string };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // fallback: استخدم الـ raw كـ prompt مباشر
    parsed = {
      visual_prompt: `front-facing portrait photo of ${userPrompt}, looking directly at camera, head and shoulders centered, plain solid background, even soft studio lighting, sharp focus`,
      description_ar: `شخصية مولّدة بالذكاء الاصطناعي بناءً على وصف: ${userPrompt}.`,
      description_en: `AI-generated character based on concept: ${userPrompt}.`,
    };
  }

  const styleSuffix = STYLE_PRESETS[style]?.suffix || STYLE_PRESETS.realistic.suffix;
  const imagePrompt = `${parsed.visual_prompt}, ${styleSuffix}`;

  // Sanitize descriptions: لو الـ LLM output filler عام (زي "بيئة الاختبار") اعمله override
  // بنص محدد بطلب المستخدم
  const FILLER_PATTERNS = [
    /بيئة\s*الاختبار/i,
    /test\s*environment/i,
    /generic\s*character/i,
    /this\s*is\s*a\s*test/i,
    /use\s*this\s*(to\s*)?test/i,
  ];
  const isFiller = (s: string | undefined) =>
    !s || s.trim().length < 10 || FILLER_PATTERNS.some((re) => re.test(s));

  const descriptionAr = isFiller(parsed.description_ar)
    ? `شخصية مولّدة بالذكاء الاصطناعي بناءً على وصف: "${userPrompt}".`
    : parsed.description_ar!;
  const descriptionEn = isFiller(parsed.description_en)
    ? `AI-generated character based on concept: "${userPrompt}".`
    : parsed.description_en!;

  return {
    imagePrompt,
    descriptionAr,
    descriptionEn,
  };
}

/**
 * يولّد صورة بالـ z-ai-web-dev-sdk ويرجعها base64 PNG.
 */
async function generateCharacterImage(imagePrompt: string): Promise<string> {
  const zai = await ZAI.create();

  const response = await zai.images.generations.create({
    prompt: imagePrompt,
    size: "1024x1024", // مربع - مناسب لـ Wav2Lip
  });

  const b64 = response.data?.[0]?.base64;
  if (!b64) {
    throw new Error("Image generation returned empty response");
  }
  return b64;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CharacterRequestBody;
    const userPrompt = (body.prompt || "").trim();
    const style = body.style && STYLE_PRESETS[body.style] ? body.style : "realistic";
    const gender = body.gender && GENDER_HINT[body.gender] ? body.gender : "any";
    const lang: "ar" | "en" = body.language === "en" ? "en" : "ar";

    if (!userPrompt) {
      return NextResponse.json(
        {
          error: lang === "ar" ? "اكتب وصف للشخصية الأول" : "Please describe a character first",
        },
        { status: 400 }
      );
    }
    if (userPrompt.length > 1000) {
      return NextResponse.json(
        {
          error: lang === "ar" ? "الوصف طويل جدًا (حد أقصى 1000 حرف)" : "Description too long (max 1000 chars)",
        },
        { status: 400 }
      );
    }

    // 1. وسّع الـ concept لـ prompt بصري + وصف
    const { imagePrompt, descriptionAr, descriptionEn } = await expandCharacterConcept(
      userPrompt,
      style,
      gender,
      lang
    );

    // 2. ولّد الصورة
    let base64Image: string;
    try {
      base64Image = await generateCharacterImage(imagePrompt);
    } catch (imgErr: any) {
      console.error("[generate-character] image generation failed:", imgErr);
      // رجّع الـ description حتى لو فشلت الصورة - الـ UI ممكن يعرضه على الأقل
      return NextResponse.json(
        {
          success: false,
          error: lang === "ar"
            ? "فشل توليد الصورة. حاول تاني بوصف مختلف."
            : "Image generation failed. Try again with a different description.",
          description_ar: descriptionAr,
          description_en: descriptionEn,
          prompt_used: imagePrompt,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      success: true,
      image_base64: base64Image,
      image_mime: "image/png",
      prompt_used: imagePrompt,
      description_ar: descriptionAr,
      description_en: descriptionEn,
      style,
      gender,
    });
  } catch (err: any) {
    console.error("[generate-character] error:", err);
    return NextResponse.json(
      {
        success: false,
        error: err?.message
          ? `${err.message}`
          : "Character generation failed",
      },
      { status: 500 }
    );
  }
}

/**
 * GET metadata - بيرجع الـ styles المتاحة عشان الـ UI يعرضها.
 */
export async function GET() {
  return NextResponse.json({
    styles: Object.entries(STYLE_PRESETS).map(([key, val]) => ({
      id: key,
      label: val.label,
    })),
    genders: [
      { id: "any", label_ar: "أي نوع", label_en: "Any" },
      { id: "male", label_ar: "ذكر", label_en: "Male" },
      { id: "female", label_ar: "أنثى", label_en: "Female" },
    ],
  });
}
