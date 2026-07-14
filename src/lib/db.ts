/**
 * PostgreSQL-backed user store for multi-user auth (Neon).
 *
 * Uses @neondatabase/serverless (HTTP-based, perfect for Vercel serverless).
 *
 * API is identical to the previous SQLite version so that auth.ts and the
 * /api/login + /api/register routes do not need to change.
 */
import bcrypt from "bcryptjs";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// --- SQL query function (lazy) ---------------------------------------------
let _sql: NeonQueryFunction<false, false> | null = null;
function sql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    _sql = neon(connectionString);
    console.log("[db] Neon serverless SQL client created");
  }
  return _sql;
}

// --- Schema initialization (runs once per cold start) ----------------------
let schemaInitialized = false;
async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return;
  const s = sql();
  try {
    await s`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT NOT NULL,
        password_hash TEXT,
        display_name  TEXT,
        email         TEXT,
        auth_provider TEXT DEFAULT 'local',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // Make password_hash nullable for Google OAuth users (idempotent — no-op if already nullable)
    await s`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`;
    // Add auth_provider column if it doesn't exist (for databases that already had the users table before Google OAuth)
    await s`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'local'`;
    // Add token_invalid_before column for server-side logout (JWT blocklist).
    // When a user logs out, we set this to NOW(). The middleware then rejects
    // any JWT whose iat (issued-at) is older than this timestamp — so even if
    // the browser keeps sending the old cookie, it won't be honored.
    await s`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_invalid_before TIMESTAMPTZ`;
    await s`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
      ON users (LOWER(username))
    `;
    await s`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
      ON users (LOWER(email))
      WHERE email IS NOT NULL
    `;
    await s`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users (username)
    `;
    schemaInitialized = true;
    console.log("[db] Schema ensured (PostgreSQL)");
  } catch (e) {
    console.error("[db] Failed to ensure schema:", e);
    throw e;
  }
}

// --- Types ------------------------------------------------------------------
export interface UserRecord {
  id: number;
  username: string;
  email: string | null;
  password_hash: string | null;
  display_name: string | null;
  auth_provider: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface SafeUser {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
}

// --- Helpers ----------------------------------------------------------------
const BCRYPT_ROUNDS = 10;

function toSafe(u: UserRecord): SafeUser {
  // pg/Neon returns TIMESTAMPTZ as Date objects or ISO strings depending on driver
  const createdAt: any = u.created_at;
  const createdAtStr =
    createdAt && typeof createdAt === "object" && typeof createdAt.toISOString === "function"
      ? createdAt.toISOString()
      : String(createdAt);
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    createdAt: createdAtStr,
  };
}

async function deriveUniqueUsername(emailPrefix: string): Promise<string> {
  let base = emailPrefix
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 28) || "user";

  let candidate = base;
  let suffix = 2;
  while (true) {
    const existing = await findUserByUsername(candidate);
    if (!existing) return candidate;
    candidate = `${base}-${suffix++}`;
    if (suffix > 9999) {
      candidate = `${base}-${Date.now().toString(36)}`;
      return candidate;
    }
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Public API -------------------------------------------------------------

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  await ensureSchema();
  const rows = await sql()`
    SELECT id, username, email, password_hash, display_name, created_at, updated_at
    FROM users WHERE LOWER(username) = LOWER(${username}) LIMIT 1
  `;
  return (rows[0] as UserRecord) || null;
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  await ensureSchema();
  const rows = await sql()`
    SELECT id, username, email, password_hash, display_name, created_at, updated_at
    FROM users WHERE LOWER(email) = LOWER(${email}) LIMIT 1
  `;
  return (rows[0] as UserRecord) || null;
}

export async function findUserById(id: number): Promise<UserRecord | null> {
  await ensureSchema();
  const rows = await sql()`
    SELECT id, username, email, password_hash, display_name, created_at, updated_at
    FROM users WHERE id = ${id} LIMIT 1
  `;
  return (rows[0] as UserRecord) || null;
}

export async function createUser(opts: {
  email: string;
  password: string;
  displayName?: string;
  username?: string;
}): Promise<SafeUser> {
  await ensureSchema();
  const email = (opts.email || "").trim().toLowerCase();
  const password = opts.password || "";
  const displayName = (opts.displayName || "").trim() || null;

  if (!email) {
    const e = new Error("Email is required") as Error & { code: string };
    e.code = "invalid_email";
    throw e;
  }
  if (!EMAIL_RE.test(email)) {
    const e = new Error("Invalid email format") as Error & { code: string };
    e.code = "invalid_email";
    throw e;
  }
  if (password.length < 6) {
    const e = new Error("Password must be at least 6 characters") as Error & { code: string };
    e.code = "invalid_password";
    throw e;
  }

  let username: string;
  if (opts.username && opts.username.trim()) {
    username = opts.username.trim();
    if (username.length < 3 || username.length > 32) {
      const e = new Error("Username must be 3–32 characters") as Error & { code: string };
      e.code = "invalid_username";
      throw e;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(username)) {
      const e = new Error("Username can only contain letters, numbers, _ and -") as Error & { code: string };
      e.code = "invalid_username";
      throw e;
    }
  } else {
    const prefix = email.split("@")[0] || "user";
    username = await deriveUniqueUsername(prefix);
  }

  if (await findUserByEmail(email)) {
    const e = new Error("Email already registered") as Error & { code: string };
    e.code = "email_taken";
    throw e;
  }
  if (opts.username && (await findUserByUsername(username))) {
    const e = new Error("Username already taken") as Error & { code: string };
    e.code = "username_taken";
    throw e;
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  const rows = await sql()`
    INSERT INTO users (username, email, password_hash, display_name)
    VALUES (${username}, ${email}, ${passwordHash}, ${displayName})
    RETURNING id, username, email, password_hash, display_name, created_at, updated_at
  `;
  const created = rows[0] as UserRecord | undefined;
  if (!created) {
    throw new Error("Failed to create user (insert returned no row)");
  }
  return toSafe(created);
}

export async function verifyUser(
  identifier: string,
  password: string
): Promise<SafeUser | null> {
  if (!identifier) return null;
  const id = identifier.trim();

  let user = await findUserByEmail(id.toLowerCase());
  if (!user) {
    user = await findUserByUsername(id);
  }
  if (!user) return null;

  // Google OAuth users don't have a password hash — they can't log in via /api/login
  if (!user.password_hash) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  return ok ? toSafe(user) : null;
}

/**
 * Find or create a user from a Google OAuth profile.
 * Called by /api/auth/google/callback after a successful Google sign-in.
 *
 * - If a user with the same email already exists (whether local or Google),
 *   we return that user (account linking by email).
 * - Otherwise we create a new user with auth_provider='google' and a NULL
 *   password_hash (so they can never log in via /api/login — only via Google).
 */
export async function findOrCreateGoogleUser(opts: {
  email: string;
  displayName?: string | null;
}): Promise<SafeUser> {
  await ensureSchema();
  const email = (opts.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new Error("Invalid email from Google: " + email);
  }

  // 1) Try existing user (by email — covers both local and Google accounts)
  const existing = await findUserByEmail(email);
  if (existing) {
    // If this is the first Google login for a previously-local account, mark it
    if (!existing.auth_provider || existing.auth_provider === "local") {
      await sql()`UPDATE users SET auth_provider = 'google_local', updated_at = NOW() WHERE id = ${existing.id}`;
    }
    return toSafe(existing);
  }

  // 2) Create a new Google-only user
  const prefix = email.split("@")[0] || "user";
  const username = await deriveUniqueUsername(prefix);
  const displayName = (opts.displayName || "").trim() || null;

  const rows = await sql()`
    INSERT INTO users (username, email, password_hash, display_name, auth_provider)
    VALUES (${username}, ${email}, NULL, ${displayName}, 'google')
    RETURNING id, username, email, password_hash, display_name, auth_provider, created_at, updated_at
  `;
  const created = rows[0] as UserRecord | undefined;
  if (!created) {
    throw new Error("Failed to create Google user (insert returned no row)");
  }
  return toSafe(created);
}

export async function countUsers(): Promise<number> {
  await ensureSchema();
  const rows = await sql()`SELECT COUNT(*)::int AS c FROM users`;
  return (rows[0] as { c: number })?.c ?? 0;
}

/**
 * Mark all of a user's currently-issued JWTs as invalid by setting
 * `token_invalid_before = NOW()`. Any JWT with `iat < NOW()` will be
 * rejected by the middleware on the next request.
 *
 * Used by /api/logout to implement server-side token revocation.
 * Returns the new token_invalid_before value (ISO string) on success.
 */
export async function invalidateUserTokens(userId: number): Promise<string | null> {
  await ensureSchema();
  const rows = await sql()`
    UPDATE users
    SET token_invalid_before = NOW(), updated_at = NOW()
    WHERE id = ${userId}
    RETURNING token_invalid_before
  `;
  const row = rows[0] as { token_invalid_before?: string | Date } | undefined;
  if (!row || !row.token_invalid_before) return null;
  const v: any = row.token_invalid_before;
  return typeof v === "object" && typeof v.toISOString === "function"
    ? v.toISOString()
    : String(v);
}

/**
 * Get the user's `token_invalid_before` timestamp (if any).
 * Returns null if the user has never logged out (or if the user doesn't exist).
 *
 * Used by the middleware to check whether a JWT is still valid.
 */
export async function getUserTokenInvalidBefore(userId: number): Promise<string | null> {
  await ensureSchema();
  const rows = await sql()`
    SELECT token_invalid_before FROM users WHERE id = ${userId} LIMIT 1
  `;
  const row = rows[0] as { token_invalid_before?: string | Date | null } | undefined;
  if (!row || !row.token_invalid_before) return null;
  const v: any = row.token_invalid_before;
  return typeof v === "object" && typeof v.toISOString === "function"
    ? v.toISOString()
    : String(v);
}

export async function getSafeUserById(id: number): Promise<SafeUser | null> {
  const u = await findUserById(id);
  return u ? toSafe(u) : null;
}

export async function getSafeUserByUsername(username: string): Promise<SafeUser | null> {
  const u = await findUserByUsername(username);
  return u ? toSafe(u) : null;
}

export async function getSafeUserByEmail(email: string): Promise<SafeUser | null> {
  const u = await findUserByEmail(email);
  return u ? toSafe(u) : null;
}

export const AUTH_DB_PATH_RESOLVED = process.env.DATABASE_URL || "(DATABASE_URL not set)";
