/**
 * POST /api/login
 * Body: { email?, identifier?, password, lang?: "ar" | "en" }
 *
 * The login identifier can be either an email or a username — the server
 * tries email first, then falls back to username. This is friendly to both
 * new users (who only know their email) and any legacy users.
 *
 * Verifies credentials against the user DB, sets an httpOnly cookie with a
 * signed JWT on success.
 *
 * Response: { success: true, username, displayName?, email? } on success,
 *           { success: false, error } with HTTP 401 on failure.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  verifyCredentials,
  createSessionToken,
  AUTH_COOKIE_NAME,
  AUTH_SESSION_DURATION,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  let body: {
    email?: string;
    identifier?: string;
    username?: string; // legacy fallback
    password?: string;
    lang?: "ar" | "en";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const lang: "ar" | "en" = body.lang === "en" ? "en" : "ar";
  // Accept email, identifier, or username (legacy) — in that order of preference
  const identifier = (
    body.email ||
    body.identifier ||
    body.username ||
    ""
  ).trim();
  const password = body.password || "";

  if (!identifier || !password) {
    return NextResponse.json(
      {
        success: false,
        error:
          lang === "ar"
            ? "اكتب البريد الإلكتروني ورقم السر"
            : "Enter email and password",
      },
      { status: 400 }
    );
  }

  const user = await verifyCredentials(identifier, password);
  if (!user) {
    return NextResponse.json(
      {
        success: false,
        error:
          lang === "ar"
            ? "البريد الإلكتروني أو رقم السر غير صحيح"
            : "Invalid email or password",
      },
      { status: 401 }
    );
  }

  // Issue JWT
  const token = await createSessionToken({
    id: user.id,
    username: user.username,
    email: user.email,
  });

  const isProduction = process.env.NODE_ENV === "production";
  const res = NextResponse.json({
    success: true,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    message: lang === "ar" ? "تم تسجيل الدخول" : "Logged in",
  });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_SESSION_DURATION,
  });
  return res;
}

/**
 * GET /api/login — returns whether the current session is valid.
 * Useful for client-side auth checks without going through middleware.
 */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE_NAME)?.value;
  const { verifySessionToken } = await import("@/lib/auth");
  const session = await verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
  return NextResponse.json({
    authenticated: true,
    username: session.username,
    email: session.email,
    userId: session.userId,
  });
}
