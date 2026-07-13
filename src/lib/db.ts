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
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        email         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
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
  password_hash: string;
  display_name: string | null;
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

  const ok = bcrypt.compareSync(password, user.password_hash);
  return ok ? toSafe(user) : null;
}

export async function countUsers(): Promise<number> {
  await ensureSchema();
  const rows = await sql()`SELECT COUNT(*)::int AS c FROM users`;
  return (rows[0] as { c: number })?.c ?? 0;
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
