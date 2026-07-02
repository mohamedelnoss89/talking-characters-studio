/**
 * Proxy: GET /api/voices → backend http://localhost:8000/voices
 * يرجع قائمة الأصوات المتاحة للـ TTS.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch("http://localhost:8000/voices", {
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Backend unreachable", voices: [], default: "ar-EG-SalmaNeural" },
      { status: 503 }
    );
  }
}
