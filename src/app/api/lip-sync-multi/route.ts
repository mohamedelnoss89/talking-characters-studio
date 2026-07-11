/**
 * Proxy: POST /api/lip-sync-multi → backend http://localhost:8000/lip-sync-multi
 *
 * بينشئ فيديو حوار متعدد المتحدثين — كل وجه في الصورة يقول سكربت مختلف.
 * البيانات: multipart/form-data فيه file (الصورة) + scripts (JSON array).
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const res = await fetch("http://localhost:8000/lip-sync-multi", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Backend unreachable", status: "error" },
      { status: 503 }
    );
  }
}
