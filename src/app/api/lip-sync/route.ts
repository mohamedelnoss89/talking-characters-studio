/**
 * Proxy: POST /api/lip-sync → backend http://localhost:8000/lip-sync
 * يمرر multipart/form-data للـ backend
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const res = await fetch("http://localhost:8000/lip-sync", {
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
