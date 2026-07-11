/**
 * Proxy: DELETE /api/jobs/[jobId] → backend http://localhost:8000/jobs/[jobId]
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  try {
    const res = await fetch(`http://localhost:8000/jobs/${jobId}`, {
      method: "DELETE",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json(
      { status: "cleaned", error: e?.message },
      { status: 200 }
    );
  }
}
