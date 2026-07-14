/**
 * POST /api/logout
 * Clears the session cookie AND invalidates the token server-side.
 *
 * Three-layer defense:
 * 1. Set-Cookie with Max-Age=0 + matching attributes (Secure, HttpOnly,
 *    SameSite=lax, Path=/) — tells the browser to delete the cookie.
 * 2. Clear-Site-Data: "cookies" — a second browser-level directive that
 *    force-clears ALL cookies for the origin, regardless of attributes.
 *    This catches cases where the cookie attributes somehow don't match
 *    (e.g. an old cookie set by an older build with different options).
 * 3. Server-side token blocklist — marks the user's tokens issued before
 *    NOW() as invalid. Even if the browser keeps sending the old cookie
 *    (bfcache, aggressive caching, broken browser, etc.), the middleware
 *    will reject it because jwt.iat < users.token_invalid_before.
 */
import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { invalidateUserTokens } from "@/lib/db";

export async function POST(req: NextRequest) {
  const isProduction = process.env.NODE_ENV === "production";

  // --- Layer 3: server-side token invalidation -----------------------------
  // Extract user ID from the JWT so we can mark all their tokens as invalid.
  // We do this BEFORE clearing the cookie, while we can still read it.
  try {
    const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
    const session = await verifySessionToken(token);
    if (session && typeof session.userId === "number") {
      await invalidateUserTokens(session.userId);
    }
  } catch (e) {
    // If token verification or DB update fails, we still clear the cookie
    // below — logout should never fail just because the blocklist update failed.
    console.error("[logout] token invalidation failed:", e);
  }

  const res = NextResponse.json({ success: true, message: "Logged out" });

  // --- Layer 1: delete the session cookie with matching attributes ---------
  res.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  // --- Layer 2: Clear-Site-Data — force-clear all cookies for the origin ---
  // This is the nuclear option. Even if our cookie attributes don't exactly
  // match what was set during login, this header tells the browser to drop
  // every cookie for talking-characters-studio.vercel.app.
  // We only clear "cookies" (not "cache" or "storage") so we don't wipe the
  // user's UI preferences or force a full page reload of static assets.
  if (isProduction) {
    res.headers.set("Clear-Site-Data", '"cookies"');
  }

  // Don't let any intermediate cache store this response.
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");

  return res;
}
