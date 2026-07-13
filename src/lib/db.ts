/**
 * PostgreSQL-backed user store for multi-user auth (Neon / Supabase / etc.).
 *
 * Stores users in a `users` table with bcrypt-hashed passwords.
 * Connection string is read from DATABASE_URL env var.
 *
 * Schema:
 *   - id            SERIAL PRIMARY KEY
 *   - username      TEXT UNIQUE (case-insensitive via LOWER index)
 *   - email         TEXT UNIQUE (case-insensitive via LOWER index)
 *   - password_hash TEXT                        (bcrypt)
 *   - display_name  TEXT                        (human-readable name, allows any language)
 *   - created_at, updated_at  TIMESTAMPTZ
 *
 * This module is server-only — never import from client components.
 *
 * API is identical to the previous SQLite version so that auth.ts and the
 * /api/login + /api/register routes do not need to change.
 */
import bcrypt from "bcryptjs";
import { Pool, type PoolClient } from "pg";

// --- Connection pool (lazy) -------------------------------------------------
// Lazy initialization so DATABASE_URL can be set after imports (useful for tests
// and so the module doesn't crash on import if DATABASE_URL is missing).
let _pool: Pool | null = null;
function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    _pool = new Pool({
      connectionString,
      // Neon requires SSL
      ssl: connectionString.includes("sslmode=require")
        ? { rejectUnauthorized: false }
        : undefined,
      // Small pool — serverless functions don't need many concurrent connections
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    // eslint-disable-next-line no-console
    console.log("[db] PostgreSQL pool created");
  }
  return _pool;
}

// --- Schema initialization (runs once per cold start) ----------------------
let schemaInitialized = false;
async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return;
  let client: PoolClient | null = null;
  try {
    client = await getPool().connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        email         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Case-insensitive unique indexes (emulates SQLite's COLLATE NOCASE)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
      ON users (LOWER(username));
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
      ON users (LOWER(email))
      WHERE email IS NOT NULL;
    `);
    // Helpful non-unique index for lookups (the unique ones cover this too)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
    `);
    schemaInitialized = true;
    // eslint-disable-next-line no-console
    console.log("[db] Schema ensured (PostgreSQL)");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[db] Failed to ensure schema:", e);
    throw e;
  } finally {
    if (client) client.release();
  }
}

// --- Types ------------------------------------------------------------------
export interface UserRecord {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
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
  // pg returns TIMESTAMPTZ as Date objects; convert to ISO string for JSON
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

/**
 * Derive a unique username from an email prefix. If the prefix is already
 * taken, append -2, -3, ... until we find a free slot.
 *
 * The username only needs to be URL-safe-ish — we use it for default routing
 * and as a fallback login identifier. It's NOT shown to the user (display_name
 * is).
 */
async function deriveUniqueUsername(emailPrefix: string): Promise<string> {
  // Sanitize: keep ASCII letters/digits/_/- only, lowercase
  let base = emailPrefix
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[^a-z0-9]+/, "") // strip leading non-alphanumerics
    .slice(0, 28) || "user";

  let candidate = base;
  let suffix = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await findUserByUsername(candidate);
    if (!existing) return candidate;
    candidate = `${base}-${suffix++}`;
    if (suffix > 9999) {
      // Fallback — append a random-ish suffix
      candidate = `${base}-${Date.now().toString(36)}`;
      return candidate;
    }
  }
}

// Simple email validation regex — not RFC-perfect but good enough.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Public API -------------------------------------------------------------

/**
 * Find a user by username (case-insensitive). Returns null if not found.
 */
export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  await ensureSchema();
  const res = await getPool().query<UserRecord>(
    `SELECT id, username, email, password_hash, display_name, created_at, updated_at
     FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
    [username]
  );
  return res.rows[0] || null;
}

/**
 * Find a user by email (case-insensitive). Returns null if not found.
 */
export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  await ensureSchema();
  const res = await getPool().query<UserRecord>(
    `SELECT id, username, email, password_hash, display_name, created_at, updated_at
     FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  return res.rows[0] || null;
}

/**
 * Find a user by id. Returns null if not found.
 */
export async function findUserById(id: number): Promise<UserRecord | null> {
  await ensureSchema();
  const res = await getPool().query<UserRecord>(
    `SELECT id, username, email, password_hash, display_name, created_at, updated_at
     FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Create a new user.
 *
 * Required: email + password
 * Optional: displayName (any language — Arabic, English, etc.),
 *           username (auto-derived from email if omitted)
 *
 * Throws an Error with a `code` property on validation / uniqueness failures:
 *   - code "email_taken"     — email already registered
 *   - code "invalid_email"   — bad email format
 *   - code "invalid_password"— too short
 *   - code "invalid_username"— bad format (only if you pass one explicitly)
 */
export async function createUser(opts: {
  email: string;
  password: string;
  displayName?: string;
  username?: string; // optional override
}): Promise<SafeUser> {
  await ensureSchema();
  const email = (opts.email || "").trim().toLowerCase();
  const password = opts.password || "";
  const displayName = (opts.displayName || "").trim() || null;

  // --- Email validation -----------------------------------------------------
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

  // --- Password validation --------------------------------------------------
  if (password.length < 6) {
    const e = new Error("Password must be at least 6 characters") as Error & {
      code: string;
    };
    e.code = "invalid_password";
    throw e;
  }

  // --- Username resolution --------------------------------------------------
  let username: string;
  if (opts.username && opts.username.trim()) {
    username = opts.username.trim();
    // Validate format if user provided one explicitly
    if (username.length < 3 || username.length > 32) {
      const e = new Error("Username must be 3–32 characters") as Error & {
        code: string;
      };
      e.code = "invalid_username";
      throw e;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(username)) {
      const e = new Error(
        "Username can only contain letters, numbers, _ and -"
      ) as Error & { code: string };
      e.code = "invalid_username";
      throw e;
    }
  } else {
    // Auto-derive from email prefix (before the @)
    const prefix = email.split("@")[0] || "user";
    username = await deriveUniqueUsername(prefix);
  }

  // --- Uniqueness checks ----------------------------------------------------
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

  // --- Insert ---------------------------------------------------------------
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  const res = await getPool().query<UserRecord>(
    `INSERT INTO users (username, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, password_hash, display_name, created_at, updated_at`,
    [username, email, passwordHash, displayName]
  );
  const created = res.rows[0];
  if (!created) {
    throw new Error("Failed to create user (insert returned no row)");
  }
  return toSafe(created);
}

/**
 * Verify credentials by email OR username + password.
 * Returns the safe user record on success, null otherwise.
 */
export async function verifyUser(
  identifier: string,
  password: string
): Promise<SafeUser | null> {
  if (!identifier) return null;
  const id = identifier.trim();

  // Try email first (most common login flow)
  let user = await findUserByEmail(id.toLowerCase());
  // Fallback: try as username
  if (!user) {
    user = await findUserByUsername(id);
  }
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  return ok ? toSafe(user) : null;
}

/**
 * Total user count. Useful for stats / first-run setup.
 */
export async function countUsers(): Promise<number> {
  await ensureSchema();
  const res = await getPool().query<{ c: number }>("SELECT COUNT(*)::int AS c FROM users");
  return res.rows[0]?.c ?? 0;
}

/**
 * Get safe (no password hash) user record by id.
 */
export async function getSafeUserById(id: number): Promise<SafeUser | null> {
  const u = await findUserById(id);
  return u ? toSafe(u) : null;
}

/**
 * Get safe user record by username.
 */
export async function getSafeUserByUsername(username: string): Promise<SafeUser | null> {
  const u = await findUserByUsername(username);
  return u ? toSafe(u) : null;
}

/**
 * Get safe user record by email.
 */
export async function getSafeUserByEmail(email: string): Promise<SafeUser | null> {
  const u = await findUserByEmail(email);
  return u ? toSafe(u) : null;
}

// Expose the resolved connection string for diagnostics
export const AUTH_DB_PATH_RESOLVED = process.env.DATABASE_URL || "(DATABASE_URL not set)";
