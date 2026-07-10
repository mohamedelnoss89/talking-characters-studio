/**
 * Edit Character API Route
 * Proxy to the Python backend for AI image-to-image editing.
 * Same job-based pattern as generate-character (avoids proxy timeouts).
 */

import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export async function POST(req: NextRequest) {
  let body: { image_base64?: string; edit_prompt?: string; language?: "ar" | "en" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const lang: "ar" | "en" = body.language === "en" ? "en" : "ar";

  if (!body.image_base64 || body.image_base64.length < 1000) {
    return NextResponse.json(
      { success: false, error: lang === "ar" ? "صورة غير صالحة" : "Invalid image" },
      { status: 400 }
    );
  }
  if (!body.edit_prompt || !body.edit_prompt.trim()) {
    return NextResponse.json(
      { success: false, error: lang === "ar" ? "اكتب التعديل المطلوب" : "Describe the edit" },
      { status: 400 }
    );
  }

  try {
    const backendRes = await fetch(`${BACKEND_URL}/edit-character`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: body.image_base64,
        edit_prompt: body.edit_prompt.trim(),
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
    console.error("[edit-character] POST proxy error:", err);
    return NextResponse.json(
      { success: false, error: lang === "ar" ? "السيرفر مش متاح" : "Server unavailable" },
      { status: 503 }
    );
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("id");

  if (!jobId) {
    return NextResponse.json(
      { success: false, error: "Missing job id" },
      { status: 400 }
    );
  }

  try {
    const backendRes = await fetch(`${BACKEND_URL}/edit-character/${encodeURIComponent(jobId)}`, {
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
    console.error("[edit-character] GET proxy error:", err);
    return NextResponse.json(
      { success: false, status: "error", error: "Server unavailable" },
      { status: 503 }
    );
  }
}
