/**
 * GET /api/auth/google/callback
 *
 * Handles the OAuth 2.0 callback from Google.
 *
 * Flow:
 *   1. Verify `state` query param matches the `google_oauth_state` cookie
 *      set by /api/auth/google. If not, 400 (CSRF protection).
 *   2. Exchange the `code` query param for an access token at Google's
 *      token endpoint.
 *   3. Use the access token to call Google's userinfo endpoint and get
 *      the user's email + name.
 *   4. findOrCreateGoogleUser({ email, displayName }) — creates a user
 *      row if they don't already exist (or returns the existing one).
 *   5. Sign our own JWT session cookie (tcs_session), same as /api/login.
 *   6. Redirect to "/" (home) on success.
 *   7. On any error, redirect to /login?error=google_auth_failed.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  AUTH_COOKIE_NAME,
  AUTH_SESSION_DURATION,
} from "@/lib/auth";
import { findOrCreateGoogleUser } from "@/lib/db";

const STATE_COOKIE = "google_oauth_state";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

function getRedirectUri(req: NextRequest): string {
  const url = new URL(req.url);
  return `${url.origin}/api/auth/google/callback`;
}

interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const errorParam = searchParams.get("error");

  // User cancelled or Google returned an error
  if (errorParam) {
    return NextResponse.redirect(new URL("/login?error=google_cancelled", req.url));
  }
  if (!code || !stateParam) {
    return NextResponse.redirect(new URL("/login?error=google_missing_params", req.url));
  }

  // CSRF check
  const stateCookie = req.cookies.get(STATE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== stateParam) {
    return NextResponse.redirect(new URL("/login?error=google_state_mismatch", req.url));
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/login?error=google_not_configured", req.url));
  }

  // Step 1: exchange code for access token
  const tokenBody = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(req),
    grant_type: "authorization_code",
  });

  let accessToken: string | undefined;
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    const tokenJson = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error("[google] token exchange failed:", tokenJson);
      return NextResponse.redirect(new URL("/login?error=google_token_failed", req.url));
    }
    accessToken = tokenJson.access_token;
  } catch (e: any) {
    console.error("[google] token exchange error:", e?.message);
    return NextResponse.redirect(new URL("/login?error=google_token_error", req.url));
  }

  // Step 2: fetch user info
  let userInfo: GoogleUserInfo;
  try {
    const uiRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!uiRes.ok) {
      console.error("[google] userinfo failed:", uiRes.status);
      return NextResponse.redirect(new URL("/login?error=google_userinfo_failed", req.url));
    }
    userInfo = (await uiRes.json()) as GoogleUserInfo;
  } catch (e: any) {
    console.error("[google] userinfo error:", e?.message);
    return NextResponse.redirect(new URL("/login?error=google_userinfo_error", req.url));
  }

  if (!userInfo.email || !userInfo.email_verified) {
    return NextResponse.redirect(new URL("/login?error=google_no_verified_email", req.url));
  }

  // Step 3: find-or-create user in our DB
  let user;
  try {
    user = await findOrCreateGoogleUser({
      email: userInfo.email,
      displayName: userInfo.name || userInfo.given_name || null,
    });
  } catch (e: any) {
    console.error("[google] findOrCreate failed:", e?.message);
    return NextResponse.redirect(new URL("/login?error=google_create_failed", req.url));
  }

  // Step 4: issue our own session JWT (same as /api/login)
  const token = await createSessionToken({
    id: user.id,
    username: user.username,
    email: user.email,
  });

  // Step 5: redirect home with cookie set
  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_SESSION_DURATION,
  });
  // Clear the state cookie now that we used it
  res.cookies.delete(STATE_COOKIE);
  return res;
}
