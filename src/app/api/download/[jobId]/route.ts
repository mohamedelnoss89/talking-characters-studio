/**
 * Proxy: GET /api/download/[jobId] → backend http://localhost:8000/download/[jobId]
 * Returns the generated MP4 video file as a binary stream.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const res = await fetch(`http://localhost:8000/download/${jobId}`, {
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      return new NextResponse(text, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Stream the MP4 back to the client
    const blob = await res.blob();
    const headers = new Headers();
    headers.set("Content-Type", "video/mp4");
    headers.set(
      "Content-Disposition",
      `attachment; filename="talking-character-${jobId}.mp4"`
    );
    headers.set("Cache-Control", "no-store");

    return new NextResponse(blob, { status: 200, headers });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Backend unreachable" },
      { status: 503 }
    );
  }
}
