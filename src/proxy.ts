/**
 * Next.js proxy — protects all routes except public auth paths.
 *
 * - Reads the tcs_session cookie.
 * - Verifies the JWT via jose (edge-compatible).
 * - If invalid/missing, redirects to /login (for pages) or returns 401 (for APIs).
 *
 * Public paths:
 *   - /login (the login page)
 *   - /register (the signup page)
 *   - /api/login (POST to authenticate)
 *   - /api/register (POST to create a new account)
 *   - /api/logout (POST to clear session)
 *   - /api/health (so external probes don't need auth)
 *   - /_next/* (Next.js internals)
 *   - /static/*, /favicon.ico (static assets)
 */
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "tcs_session";
const LOGIN_PATH = "/login";

function getSecret(): Uint8Array {
  const secret =
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "DEV_ONLY_INSECURE_SECRET_please_set_AUTH_SECRET_in_production_env_var_xxxxxxxxxxxxxx";
  return new TextEncoder().encode(secret);
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === LOGIN_PATH ||
    pathname === "/register" ||
    pathname === "/api/login" ||
    pathname === "/api/register" ||
    pathname === "/api/logout" ||
    pathname === "/api/health" ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/static/") ||
    pathname.startsWith("/fonts/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  );
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Always allow public paths
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Verify the session cookie
  const token = req.cookies.get(COOKIE_NAME)?.value;
  let isAuthed = false;

  if (token) {
    try {
      await jwtVerify(token, getSecret(), {
        issuer: "talking-characters-studio",
      });
      isAuthed = true;
    } catch {
      isAuthed = false;
    }
  }

  if (isAuthed) {
    return NextResponse.next();
  }

  // Not authenticated — handle differently for API vs pages
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { success: false, error: "Unauthorized", authenticated: false },
      { status: 401 }
    );
  }

  // Page route — redirect to /login with a `next` param
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = LOGIN_PATH;
  loginUrl.search = "";
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", pathname + (req.nextUrl.search || ""));
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Run middleware on all routes except Next.js internals and static files.
   */
  matcher: [
    /*
     * Match all paths except:
     * - _next/static, _next/image, favicon.ico (handled by isPublicPath too)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
