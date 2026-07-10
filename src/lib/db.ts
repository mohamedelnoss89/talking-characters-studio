/**
 * SQLite-backed user store for multi-user auth.
 *
 * Stores users in a single table with bcrypt-hashed passwords.
 * The DB file lives at <project_root>/data/auth.db (configurable via AUTH_DB_PATH env).
 *
 * Schema:
 *   - id            INTEGER PRIMARY KEY
 *   - username      TEXT UNIQUE COLLATE NOCASE  (auto-generated from email prefix)
 *   - email         TEXT UNIQUE COLLATE NOCASE  (primary login identifier)
 *   - password_hash TEXT                        (bcrypt)
 *   - display_name  TEXT                        (human-readable name, allows any language)
 *   - created_at, updated_at  TEXT
 *
 * This module is server-only — never import from client components.
 */
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";

// --- DB path resolution -----------------------------------------------------
const DB_DIR = process.env.AUTH_DB_PATH
  ? path.dirname(process.env.AUTH_DB_PATH)
  : path.join(process.cwd(), "data");
const DB_PATH =
  process.env.AUTH_DB_PATH || path.join(DB_DIR, "auth.db");

// Ensure the directory exists (idempotent)
try {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.error("[db] Failed to create auth DB dir:", DB_DIR, e);
}

// --- DB connection ----------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Schema -----------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
`);

// --- Migration: add email column if missing --------------------------------
// (Backward-compatible: existing rows get NULL email; new rows require email.)
//
// NOTE: SQLite's ALTER TABLE ADD COLUMN does NOT support UNIQUE inline.
// We add the column without UNIQUE, then create a unique index on it.
// SQLite allows multiple NULLs in a unique index, so existing rows (with NULL
// email) are fine. New rows must have a non-NULL email — enforced by the
// application layer (createUser validates).
{
  const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  const hasEmail = cols.some((c) => c.name === "email");
  if (!hasEmail) {
    db.exec(`ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE;`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;`
    );
    // eslint-disable-next-line no-console
    console.log("[db] Added `email` column to users table (migration)");
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

// --- Prepared statements ----------------------------------------------------
const stmtFindByUsername = db.prepare<unknown[], UserRecord>(
  "SELECT * FROM users WHERE username = ? LIMIT 1"
);
const stmtFindByEmail = db.prepare<unknown[], UserRecord>(
  "SELECT * FROM users WHERE email = ? LIMIT 1"
);
const stmtFindById = db.prepare<unknown[], UserRecord>(
  "SELECT * FROM users WHERE id = ? LIMIT 1"
);
const stmtInsertUser = db.prepare(
  "INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)"
);
const stmtCountUsers = db.prepare<unknown[], { c: number }>(
  "SELECT COUNT(*) AS c FROM users"
);

// --- Helpers ----------------------------------------------------------------
const BCRYPT_ROUNDS = 10;

function toSafe(u: UserRecord): SafeUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    createdAt: u.created_at,
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
function deriveUniqueUsername(emailPrefix: string): string {
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
    const existing = stmtFindByUsername.get(candidate) as UserRecord | undefined;
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
export function findUserByUsername(username: string): UserRecord | null {
  const row = stmtFindByUsername.get(username) as UserRecord | undefined;
  return row || null;
}

/**
 * Find a user by email (case-insensitive). Returns null if not found.
 */
export function findUserByEmail(email: string): UserRecord | null {
  const row = stmtFindByEmail.get(email) as UserRecord | undefined;
  return row || null;
}

/**
 * Find a user by id. Returns null if not found.
 */
export function findUserById(id: number): UserRecord | null {
  const row = stmtFindById.get(id) as UserRecord | undefined;
  return row || null;
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
export function createUser(opts: {
  email: string;
  password: string;
  displayName?: string;
  username?: string; // optional override
}): SafeUser {
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
    username = deriveUniqueUsername(prefix);
  }

  // --- Uniqueness checks ----------------------------------------------------
  if (findUserByEmail(email)) {
    const e = new Error("Email already registered") as Error & { code: string };
    e.code = "email_taken";
    throw e;
  }
  // (username uniqueness is already handled by deriveUniqueUsername, but if the
  // user passed one explicitly we still need to check)
  if (opts.username && findUserByUsername(username)) {
    const e = new Error("Username already taken") as Error & { code: string };
    e.code = "username_taken";
    throw e;
  }

  // --- Insert ---------------------------------------------------------------
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  const info = stmtInsertUser.run(username, email, passwordHash, displayName);
  const id = Number(info.lastInsertRowid);
  const created = findUserById(id);
  if (!created) {
    throw new Error("Failed to create user (insert returned no row)");
  }
  return toSafe(created);
}

/**
 * Verify credentials by email OR username + password.
 * Returns the safe user record on success, null otherwise.
 */
export function verifyUser(
  identifier: string,
  password: string
): SafeUser | null {
  if (!identifier) return null;
  const id = identifier.trim();

  // Try email first (most common login flow)
  let user = findUserByEmail(id.toLowerCase());
  // Fallback: try as username
  if (!user) {
    user = findUserByUsername(id);
  }
  if (!user) return null;

  const ok = bcrypt.compareSync(password, user.password_hash);
  return ok ? toSafe(user) : null;
}

/**
 * Total user count. Useful for stats / first-run setup.
 */
export function countUsers(): number {
  const row = stmtCountUsers.get() as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Get safe (no password hash) user record by id.
 */
export function getSafeUserById(id: number): SafeUser | null {
  const u = findUserById(id);
  return u ? toSafe(u) : null;
}

/**
 * Get safe user record by username.
 */
export function getSafeUserByUsername(username: string): SafeUser | null {
  const u = findUserByUsername(username);
  return u ? toSafe(u) : null;
}

/**
 * Get safe user record by email.
 */
export function getSafeUserByEmail(email: string): SafeUser | null {
  const u = findUserByEmail(email);
  return u ? toSafe(u) : null;
}

// Expose the DB path for diagnostics / health endpoints
export const AUTH_DB_PATH_RESOLVED = DB_PATH;
