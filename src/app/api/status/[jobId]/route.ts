/**
 * Proxy: GET /api/status/[jobId] → backend http://localhost:8000/status/[jobId]
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const res = await fetch(`http://localhost:8000/status/${jobId}`, {
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json(
      {
        job_id: jobId,
        status: "error",
        progress: 0,
        message: e?.message || "Backend unreachable",
        error: e?.message || "Backend unreachable",
        has_video: false,
      },
      { status: 503 }
    );
  }
}
