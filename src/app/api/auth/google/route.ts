/**
 * GET /api/auth/google
 *
 * Redirects the user to Google's OAuth 2.0 consent screen. After the user
 * grants permission, Google redirects back to /api/auth/google/callback.
 *
 * Flow:
 *   1. Generate random `state` and store in a short-lived cookie.
 *   2. Build Google consent URL with scopes (openid email profile).
 *   3. 302 redirect to Google.
 *
 * When Google redirects back, the callback route checks the `state` cookie
 * matches the `state` query param to prevent CSRF.
 */
import { NextResponse, NextRequest } from "next/server";
import { randomBytes } from "crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = ["openid", "email", "profile"].join(" ");
const STATE_COOKIE = "google_oauth_state";

function getRedirectUri(req: NextRequest): string {
  // Build the absolute callback URL from the request origin so it works
  // both on Vercel (https://talking-characters-studio.vercel.app) and
  // locally (http://localhost:3000).
  const url = new URL(req.url);
  return `${url.origin}/api/auth/google/callback`;
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      {
        success: false,
        error: "Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.",
      },
      { status: 500 }
    );
  }

  const redirectUri = getRedirectUri(req);
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
    access_type: "online", // we don't need refresh tokens
    prompt: "select_account", // let the user pick which Google account
  });

  const googleUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

  const res = NextResponse.redirect(googleUrl);
  // Store state in a short-lived cookie (10 min) — sameSite=lax so it survives
  // the cross-site redirect from Google back to us.
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60, // 10 minutes
  });
  return res;
}
