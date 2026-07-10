/**
 * Auth utilities — JWT-based admin login.
 *
 * Configuration:
 *   - ADMIN_USERNAME (env, default "admin")
 *   - ADMIN_PASSWORD (env, plain text, default "admin123" — change in production!)
 *   - AUTH_SECRET (env, JWT signing secret — auto-generated fallback for dev only)
 *
 * The session cookie "tcs_session" contains a signed JWT with the username
 * and an expiry timestamp. The middleware verifies it on protected routes.
 */
import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "tcs_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Lazily-computed secret — falls back to a dev-only secret if env is missing.
// This is intentional: we want the app to work in dev without manual setup,
// but warn loudly. In production, AUTH_SECRET must be set.
function getSecret(): Uint8Array {
  const secret =
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "DEV_ONLY_INSECURE_SECRET_please_set_AUTH_SECRET_in_production_env_var_xxxxxxxxxxxxxx";
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] ⚠️ AUTH_SECRET not set — using insecure dev-only secret. Set AUTH_SECRET in production!"
    );
  }
  return new TextEncoder().encode(secret);
}

export interface SessionPayload {
  username: string;
  // ISO string — informational, the JWT exp claim is authoritative
  issuedAt?: string;
}

/**
 * Returns the admin username (from env or default).
 */
export function getAdminUsername(): string {
  return process.env.ADMIN_USERNAME || "admin";
}

/**
 * Returns the admin password (from env or default).
 * NOTE: For a simple admin-only setup we store the password in env as plain text.
 * If you want multiple users with hashed passwords, switch to a DB-backed store.
 */
export function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD || "admin123";
}

/**
 * Verify the given username/password against the admin credentials.
 */
export function verifyCredentials(
  username: string,
  password: string
): { ok: boolean; reason?: string } {
  const expectedUser = getAdminUsername();
  const expectedPass = getAdminPassword();

  // Constant-time-ish comparison (not strictly necessary for plain-text env creds,
  // but good hygiene).
  if (
    username.length !== expectedUser.length ||
    password.length !== expectedPass.length
  ) {
    return { ok: false, reason: "invalid_credentials" };
  }

  let userMatch = 0;
  let passMatch = 0;
  for (let i = 0; i < Math.max(username.length, expectedUser.length); i++) {
    if ((username.charCodeAt(i) || 0) === (expectedUser.charCodeAt(i) || 0)) userMatch++;
  }
  for (let i = 0; i < Math.max(password.length, expectedPass.length); i++) {
    if ((password.charCodeAt(i) || 0) === (expectedPass.charCodeAt(i) || 0)) passMatch++;
  }

  if (userMatch !== expectedUser.length || passMatch !== expectedPass.length) {
    return { ok: false, reason: "invalid_credentials" };
  }
  return { ok: true };
}

/**
 * Sign a JWT for the given username. Used by /api/login.
 */
export async function createSessionToken(username: string): Promise<string> {
  const now = new Date();
  return await new SignJWT({
    username,
    issuedAt: now.toISOString(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .setIssuer("talking-characters-studio")
    .setSubject(username)
    .sign(getSecret());
}

/**
 * Verify a JWT. Returns the payload if valid, null otherwise.
 * Used by middleware + /api/logout + any server component that needs the user.
 */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  if (!token || typeof token !== "string" || token.length < 10) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: "talking-characters-studio",
    });
    if (!payload || typeof payload.username !== "string") return null;
    return {
      username: payload.username,
      issuedAt: typeof payload.issuedAt === "string" ? payload.issuedAt : undefined,
    };
  } catch {
    return null;
  }
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_SESSION_DURATION = SESSION_DURATION_SECONDS;
