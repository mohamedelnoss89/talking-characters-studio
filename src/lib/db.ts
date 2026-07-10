/**
 * SQLite-backed user store for multi-user auth.
 *
 * Stores users in a single table with bcrypt-hashed passwords.
 * The DB file lives at <project_root>/data/auth.db (configurable via AUTH_DB_PATH env).
 *
 * This module is server-only — never import from client components.
 */
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";

// --- DB path resolution -----------------------------------------------------
// Default: <project_root>/data/auth.db
// In production this can be overridden via AUTH_DB_PATH env var.
const DB_DIR =
  process.env.AUTH_DB_PATH
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
// better-sqlite3 is synchronous — no async/await needed.
// We use a single shared connection. WAL mode for better concurrency.
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

// --- Types ------------------------------------------------------------------
export interface UserRecord {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafeUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: string;
}

// --- Prepared statements ----------------------------------------------------
const stmtFindByUsername = db.prepare<
  unknown[],
  UserRecord
>("SELECT * FROM users WHERE username = ? LIMIT 1");
const stmtFindById = db.prepare<unknown[], UserRecord>(
  "SELECT * FROM users WHERE id = ? LIMIT 1"
);
const stmtInsertUser = db.prepare(
  "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)"
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
    displayName: u.display_name,
    createdAt: u.created_at,
  };
}

// --- Public API -------------------------------------------------------------

/**
 * Find a user by username (case-insensitive). Returns null if not found.
 */
export function findUserByUsername(username: string): UserRecord | null {
  const row = stmtFindByUsername.get(username) as UserRecord | undefined;
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
 * Throws an Error with a code property on validation / uniqueness failures:
 *   - code "username_taken" — username already exists
 *   - code "invalid_username" — bad format
 *   - code "invalid_password" — too short
 */
export function createUser(opts: {
  username: string;
  password: string;
  displayName?: string;
}): SafeUser {
  const username = (opts.username || "").trim();
  const password = opts.password || "";

  // Username rules: 3–32 chars, letters/digits/_/- only
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
  // Password rules: min 6 chars
  if (password.length < 6) {
    const e = new Error("Password must be at least 6 characters") as Error & {
      code: string;
    };
    e.code = "invalid_password";
    throw e;
  }

  // Check uniqueness
  const existing = findUserByUsername(username);
  if (existing) {
    const e = new Error("Username already taken") as Error & { code: string };
    e.code = "username_taken";
    throw e;
  }

  // Hash password
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const displayName = (opts.displayName || "").trim() || null;

  const info = stmtInsertUser.run(username, passwordHash, displayName);
  const id = Number(info.lastInsertRowid);
  const created = findUserById(id);
  if (!created) {
    throw new Error("Failed to create user (insert returned no row)");
  }
  return toSafe(created);
}

/**
 * Verify a username/password combo. Returns the safe user record on success,
 * null otherwise. Constant-time-ish thanks to bcrypt.
 */
export function verifyUser(
  username: string,
  password: string
): SafeUser | null {
  const user = findUserByUsername(username);
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

// Expose the DB path for diagnostics / health endpoints
export const AUTH_DB_PATH_RESOLVED = DB_PATH;
