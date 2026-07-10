/**
 * POST /api/register
 * Body: { username, password, displayName?, lang?: "ar" | "en" }
 * Creates a new user account, then immediately issues a session cookie
 * (so the user is logged in after registering).
 *
 * Response: { success: true, user } on success,
 *           { success: false, error, code? } with HTTP 400/409 on failure.
 */
import { NextRequest, NextResponse } from "next/server";
import { createUser } from "@/lib/db";
import {
  createSessionToken,
  AUTH_COOKIE_NAME,
  AUTH_SESSION_DURATION,
} from "@/lib/auth";

interface ErrorWithCode extends Error {
  code?: string;
}

export async function POST(req: NextRequest) {
  let body: {
    username?: string;
    password?: string;
    displayName?: string;
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
  const username = (body.username || "").trim();
  const password = body.password || "";
  const displayName = (body.displayName || "").trim();

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

  let user;
  try {
    user = createUser({ username, password, displayName });
  } catch (e) {
    const err = e as ErrorWithCode;
    const code = err.code || "unknown";

    let msgAr = "فشل التسجيل";
    let msgEn = "Registration failed";
    let status = 400;

    if (code === "username_taken") {
      msgAr = "اسم المستخدم مستخدم بالفعل — جرّب اسم تاني";
      msgEn = "Username already taken — try another";
      status = 409;
    } else if (code === "invalid_username") {
      msgAr =
        "اسم المستخدم لازم 3–32 حرف، حروف وأرقام و _ و - بس";
      msgEn =
        "Username must be 3–32 chars, only letters, digits, _ and -";
    } else if (code === "invalid_password") {
      msgAr = "كلمة المرور لازم 6 حروف على الأقل";
      msgEn = "Password must be at least 6 characters";
    }

    return NextResponse.json(
      {
        success: false,
        error: lang === "ar" ? msgAr : msgEn,
        code,
      },
      { status }
    );
  }

  // Issue JWT session cookie
  const token = await createSessionToken({
    id: user.id,
    username: user.username,
  });

  const isProduction = process.env.NODE_ENV === "production";
  const res = NextResponse.json({
    success: true,
    user,
    message: lang === "ar" ? "تم إنشاء الحساب" : "Account created",
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
