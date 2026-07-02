/**
 * Proxy: POST /api/tts → backend http://localhost:8000/tts
 * يحوّل نص إلى ملف صوتي MP3 (للمعاينة).
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const res = await fetch("http://localhost:8000/tts", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: errText || "TTS failed" },
        { status: res.status }
      );
    }
    // MP3 binary response
    const audioBuffer = await res.arrayBuffer();
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'inline; filename="tts.mp3"',
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Backend unreachable" },
      { status: 503 }
    );
  }
}
