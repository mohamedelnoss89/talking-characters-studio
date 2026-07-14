/**
 * POST /api/logout
 * Clears the session cookie.
 *
 * IMPORTANT: cookie options must match the ones used in /api/login and
 * /api/auth/google/callback (secure + sameSite) — otherwise the browser
 * treats the delete as a different cookie and the user stays logged in.
 */
import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth";

export async function POST() {
  const isProduction = process.env.NODE_ENV === "production";
  const res = NextResponse.json({ success: true, message: "Logged out" });
  res.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
