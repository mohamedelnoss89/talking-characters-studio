/**
 * Proxy: GET /api/health → backend http://localhost:8000/health
 * If backend is down, attempts to auto-start it.
 */
import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";

export const dynamic = "force-dynamic";

let backendStarting = false;
let backendStartTime = 0;

async function checkBackend() {
  try {
    const res = await fetch("http://localhost:8000/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch {
    return null;
  }
}

async function startBackend() {
  if (backendStarting) return;
  if (Date.now() - backendStartTime < 30000) return; // Don't retry within 30s
  
  backendStarting = true;
  backendStartTime = Date.now();
  
  try {
    const serverPath = path.join(process.cwd(), "backend", "server.py");
    const proc = spawn("/home/z/.venv/bin/python", ["-u", serverPath], {
      cwd: path.join(process.cwd(), "backend"),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    
    proc.stdout?.on("data", (data) => {
      console.log(`[Backend] ${data.toString().trim()}`);
    });
    proc.stderr?.on("data", (data) => {
      console.error(`[Backend] ${data.toString().trim()}`);
    });
    
    proc.unref();
    console.log(`[Health] Backend auto-started with PID ${proc.pid}`);
  } catch (err) {
    console.error("[Health] Failed to auto-start backend:", err);
  } finally {
    backendStarting = false;
  }
}

export async function GET() {
  // Try to reach backend
  const data = await checkBackend();
  if (data) {
    return NextResponse.json(data, { status: 200 });
  }
  
  // Backend is down - try to start it
  await startBackend();
  
  // Wait a bit and check again (model takes ~10s to load)
  return NextResponse.json(
    { 
      status: "starting", 
      message: "Backend is starting. Please retry in ~15 seconds.",
      retry_after_ms: 15000 
    },
    { status: 503 }
  );
}
