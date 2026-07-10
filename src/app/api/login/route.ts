/**
 * POST /api/login
 * Body: { username, password, lang?: "ar" | "en" }
 * Verifies credentials against the user DB, sets an httpOnly cookie with a
 * signed JWT on success.
 *
 * Response: { success: true, username, displayName? } on success,
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
  let body: { username?: string; password?: string; lang?: "ar" | "en" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const lang: "ar" | "en" = body.lang === "en" ? "en" : "ar";
  const username = (body.username || "").trim();
  const password = body.password || "";

  if (!username || !password) {
    return NextResponse.json(
      {
        success: false,
        error:
          lang === "ar"
            ? "اكتب اسم المستخدم وكلمة المرور"
            : "Enter username and password",
      },
      { status: 400 }
    );
  }

  const user = await verifyCredentials(username, password);
  if (!user) {
    return NextResponse.json(
      {
        success: false,
        error:
          lang === "ar"
            ? "اسم المستخدم أو كلمة المرور غير صحيحة"
            : "Invalid credentials",
      },
      { status: 401 }
    );
  }

  // Issue JWT
  const token = await createSessionToken({
    id: user.id,
    username: user.username,
  });

  // Build the response and set the cookie.
  // NOTE: httpOnly so client-side JS can't read it (XSS protection).
  //       secure=true in production — in dev over http we still want it to work,
  //       so we set secure based on NODE_ENV.
  const isProduction = process.env.NODE_ENV === "production";
  const res = NextResponse.json({
    success: true,
    username: user.username,
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
    userId: session.userId,
  });
}
