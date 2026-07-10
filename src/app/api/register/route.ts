/**
 * POST /api/register
 * Body: { name, email, password, lang?: "ar" | "en" }
 *   - name:     display name (any language — Arabic, English, etc.)
 *   - email:    primary login identifier (required, unique)
 *   - password: min 6 chars
 *
 * Username is auto-derived from the email prefix — the user never types it.
 *
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
    name?: string;
    displayName?: string; // legacy alias
    email?: string;
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
  const email = (body.email || "").trim();
  const password = body.password || "";
  // Accept both `name` and `displayName` for the display name field
  const displayName = (body.name || body.displayName || "").trim();

  if (!email || !password) {
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

  let user;
  try {
    user = createUser({ email, password, displayName });
  } catch (e) {
    const err = e as ErrorWithCode;
    const code = err.code || "unknown";

    let msgAr = "فشل التسجيل";
    let msgEn = "Registration failed";
    let status = 400;

    if (code === "email_taken") {
      msgAr = "البريد الإلكتروني ده مسجّل قبل كده — استخدم بريد تاني أو سجّل دخول";
      msgEn = "Email already registered — use another or sign in";
      status = 409;
    } else if (code === "invalid_email") {
      msgAr = "البريد الإلكتروني مش صحيح — اتأكد من كتابته";
      msgEn = "Invalid email format — please check it";
    } else if (code === "invalid_password") {
      msgAr = "رقم السر لازم 6 حروف على الأقل";
      msgEn = "Password must be at least 6 characters";
    } else if (code === "invalid_username") {
      msgAr = "اسم المستخدم لازم 3–32 حرف، حروف وأرقام و _ و - بس";
      msgEn = "Username must be 3–32 chars, only letters, digits, _ and -";
    } else if (code === "username_taken") {
      msgAr = "اسم المستخدم مستخدم بالفعل — جرّب اسم تاني";
      msgEn = "Username already taken — try another";
      status = 409;
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
    email: user.email,
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
