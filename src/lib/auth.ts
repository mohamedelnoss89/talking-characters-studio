/**
 * Auth utilities — JWT-based multi-user login.
 *
 * User accounts are stored in SQLite (see db.ts). Passwords are bcrypt-hashed.
 *
 * Configuration:
 *   - AUTH_SECRET (env, JWT signing secret — auto-generated fallback for dev only)
 *   - AUTH_DB_PATH (env, optional path to SQLite DB; default <cwd>/data/auth.db)
 *
 * The session cookie "tcs_session" contains a signed JWT with the user id +
 * username and an expiry timestamp. The middleware verifies it on protected
 * routes.
 */
import { SignJWT, jwtVerify } from "jose";
import {
  verifyUser,
  getSafeUserById,
  type SafeUser,
} from "@/lib/db";

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
  userId: number;
  username: string;
  // ISO string — informational, the JWT exp claim is authoritative
  issuedAt?: string;
}

/**
 * Verify the given username/password against the user DB.
 * Returns the safe user record on success, null on failure.
 */
export async function verifyCredentials(
  username: string,
  password: string
): Promise<SafeUser | null> {
  return verifyUser(username, password);
}

/**
 * Sign a JWT for the given user. Used by /api/login.
 */
export async function createSessionToken(user: {
  id: number;
  username: string;
}): Promise<string> {
  const now = new Date();
  return await new SignJWT({
    userId: user.id,
    username: user.username,
    issuedAt: now.toISOString(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .setIssuer("talking-characters-studio")
    .setSubject(String(user.id))
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
    if (
      !payload ||
      typeof payload.username !== "string" ||
      typeof payload.userId !== "number"
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      username: payload.username,
      issuedAt:
        typeof payload.issuedAt === "string" ? payload.issuedAt : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a session payload to a full safe user record (re-reads DB).
 * Returns null if the user has been deleted or the session is invalid.
 */
export async function resolveSessionUser(
  token: string | undefined | null
): Promise<SafeUser | null> {
  const session = await verifySessionToken(token);
  if (!session) return null;
  return getSafeUserById(session.userId);
}

export const AUTH_COOKIE_NAME = COOKIE_NAME;
export const AUTH_SESSION_DURATION = SESSION_DURATION_SECONDS;
