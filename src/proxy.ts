/**
 * Next.js proxy — protects all routes except public auth paths.
 *
 * - Reads the tcs_session cookie.
 * - Verifies the JWT via jose (edge-compatible).
 * - ALSO checks the user's `token_invalid_before` timestamp in the DB,
 *   so that even if the browser keeps sending an old cookie after logout,
 *   the server will reject it. This is the server-side logout blocklist.
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
import { jwtVerify, type JWTPayload } from "jose";

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
    pathname === "/install" ||
    pathname === "/api/login" ||
    pathname === "/api/register" ||
    pathname === "/api/logout" ||
    pathname === "/api/health" ||
    // Google OAuth routes — must be reachable without a session cookie
    pathname === "/api/auth/google" ||
    pathname.startsWith("/api/auth/google/") ||
    // PWA assets — manifest, icons, service worker
    pathname === "/manifest.json" ||
    pathname.startsWith("/icon-") ||
    pathname.startsWith("/maskable-") ||
    pathname.startsWith("/apple-touch-icon") ||
    pathname.startsWith("/favicon-") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/static/") ||
    pathname.startsWith("/fonts/") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg" ||
    pathname === "/robots.txt"
  );
}

/**
 * Edge-compatible Neon SQL query helper.
 *
 * We can't import from @/lib/db because that pulls in bcryptjs (Node-only).
 * Instead, we use the @neondatabase/serverless HTTP driver directly, which
 * works on Edge runtime via fetch().
 */
let _neonSql: ((strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>) | null = null;
async function neonSql() {
  if (!_neonSql) {
    const { neon } = await import("@neondatabase/serverless");
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL not set");
    }
    _neonSql = neon(connectionString);
  }
  return _neonSql!;
}

/**
 * Check if a user's tokens have been invalidated (i.e. they've logged out).
 * Returns true if the token is still valid, false if it's been invalidated.
 *
 * We fetch the user's `token_invalid_before` timestamp. If the JWT's `iat`
 * (issued-at) is older than that timestamp, the token is revoked.
 */
async function isTokenStillValid(payload: JWTPayload): Promise<boolean> {
  const userId = payload.userId;
  if (typeof userId !== "number") return false;

  // JWT `iat` is in seconds; convert to ms for comparison with JS Date
  const iat = payload.iat;
  if (typeof iat !== "number") {
    // No iat claim — can't verify, treat as invalid for safety
    return false;
  }
  const iatMs = iat * 1000;

  try {
    const sql = await neonSql();
    const rows = await sql`SELECT token_invalid_before FROM users WHERE id = ${userId} LIMIT 1`;
    const row = rows[0];
    if (!row || !row.token_invalid_before) {
      // User has never logged out — token is still valid
      return true;
    }
    // token_invalid_before is a TIMESTAMPTZ; Neon returns it as ISO string
    const invalidBeforeMs = new Date(row.token_invalid_before).getTime();
    // Token is valid ONLY if it was issued at or after the invalidation
    // timestamp (i.e. the user logged in AGAIN after logging out).
    // Strict comparison — no grace period — because:
    //   - Login and logout both run on Vercel, clocks are NTP-synced
    //   - Any token issued BEFORE the user clicked logout must be rejected
    //   - Clock skew between Vercel and Neon is irrelevant because we
    //     compare absolute timestamps (iat from Vercel vs. NOW() from Neon,
    //     both in UTC ms since epoch)
    return iatMs >= invalidBeforeMs;
  } catch (e) {
    // If the DB query fails, fail OPEN (allow the request) so we don't
    // lock users out due to transient DB issues. The JWT signature check
    // still provides the primary security boundary.
    console.error("[proxy] token blocklist check failed:", e);
    return true;
  }
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
      const { payload } = await jwtVerify(token, getSecret(), {
        issuer: "talking-characters-studio",
      });
      // JWT signature is valid — now check server-side blocklist
      isAuthed = await isTokenStillValid(payload);
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
