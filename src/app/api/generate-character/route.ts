/**
 * Generate Character API Route
 * Proxy to the Python backend, which runs the actual generation in a background thread.
 * This avoids any Next.js/proxy timeout issues — POST returns job_id immediately,
 * client polls GET for status.
 */

import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

// ============================================================
// POST — start a generation job (proxies to Python backend)
// ============================================================
export async function POST(req: NextRequest) {
  let body: { prompt?: string; style?: string; gender?: string; language?: "ar" | "en" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const userPrompt = (body.prompt || "").trim();
  const lang: "ar" | "en" = body.language === "en" ? "en" : "ar";

  if (!userPrompt) {
    return NextResponse.json(
      { success: false, error: lang === "ar" ? "اكتب وصف للشخصية الأول" : "Please describe a character first" },
      { status: 400 }
    );
  }
  if (userPrompt.length > 1000) {
    return NextResponse.json(
      { success: false, error: lang === "ar" ? "الوصف طويل جدًا (حد أقصى 1000 حرف)" : "Description too long (max 1000 chars)" },
      { status: 400 }
    );
  }

  try {
    const backendRes = await fetch(`${BACKEND_URL}/generate-character`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: userPrompt,
        style: body.style || "realistic",
        gender: body.gender || "any",
        language: lang,
      }),
    });

    if (!backendRes.ok) {
      const errText = await backendRes.text().catch(() => "");
      return NextResponse.json(
        { success: false, error: errText.slice(0, 200) || `Backend error ${backendRes.status}` },
        { status: backendRes.status }
      );
    }

    const data = await backendRes.json();
    return NextResponse.json(data);
  } catch (err: any) {
    console.error("[generate-character] POST proxy error:", err);
    return NextResponse.json(
      { success: false, error: lang === "ar" ? "السيرفر مش متاح" : "Server unavailable" },
      { status: 503 }
    );
  }
}

// ============================================================
// GET — poll job status, or return style list if no id
// ============================================================
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("id");

  if (!jobId) {
    // Return metadata from backend
    try {
      const res = await fetch(`${BACKEND_URL}/character-styles`, { cache: "no-store" });
      if (res.ok) return NextResponse.json(await res.json());
    } catch {}
    // fallback
    return NextResponse.json({
      styles: [
        { id: "realistic", label: "واقعي / Realistic" },
        { id: "anime", label: "أنمي / Anime" },
        { id: "cartoon", label: "كرتون / Cartoon" },
        { id: "3d", label: "3D" },
        { id: "oil", label: "زيت / Oil" },
        { id: "watercolor", label: "ألوان مائية / Watercolor" },
      ],
      genders: [
        { id: "any", label_ar: "أي نوع", label_en: "Any" },
        { id: "male", label_ar: "ذكر", label_en: "Male" },
        { id: "female", label_ar: "أنثى", label_en: "Female" },
      ],
    });
  }

  try {
    const backendRes = await fetch(`${BACKEND_URL}/generate-character/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });

    if (!backendRes.ok) {
      if (backendRes.status === 404) {
        return NextResponse.json(
          { success: false, status: "error", error: "Job not found or expired" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { success: false, status: "error", error: `Backend error ${backendRes.status}` },
        { status: 502 }
      );
    }

    const data = await backendRes.json();
    return NextResponse.json(data);
  } catch (err: any) {
    console.error("[generate-character] GET proxy error:", err);
    return NextResponse.json(
      { success: false, status: "error", error: "Server unavailable" },
      { status: 503 }
    );
  }
}
