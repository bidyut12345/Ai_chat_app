/**
 * Authentication: password hashing (scrypt), opaque session tokens stored in
 * SQLite, HttpOnly cookies, and the middleware that guards every API route.
 *
 * No external dependencies — everything is Node's built-in `crypto`. Sessions
 * are random 256-bit tokens kept in the `sessions` table (so they can be
 * revoked server-side) and shipped to the browser as a signed-by-existence
 * HttpOnly cookie. Passwords are never stored, only an scrypt hash + salt.
 */
import crypto from 'node:crypto';
import { db } from '../db.js';

// Test-only escape hatch. When AUTH_DISABLED=1 every request is treated as a
// signed-in default user, so the API test suites (which send no cookies) keep
// working. Production never sets this, so auth is always enforced there.
export const AUTH_DISABLED = process.env.AUTH_DISABLED === '1';

export const SESSION_COOKIE = 'aic_session';
export const SESSION_TTL_DAYS = 30;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/**
 * Derive a key with scrypt. Async on purpose: `scryptSync` blocks the single
 * event loop for ~100ms per call, which stalls every streaming chat while a
 * login is being checked. Both helpers below are promise-returning.
 */
function derive(password, salt, keyLen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hash a password into a self-describing string (salt + params + digest). */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await derive(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Constant-time verify a password against a stored hash. */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = await derive(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Create a session row for a user and return the raw token. */
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))"
  ).run(token, userId, `+${SESSION_TTL_DAYS} days`);
  return token;
}

/** Return the user for a valid, unexpired token, or null. Slides expiry. */
export function getUserByToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')`
    )
    .get(token);
  if (!row) return null;
  // Slide the expiry so active users are not logged out mid-use.
  db.prepare("UPDATE sessions SET expires_at = datetime('now', ?) WHERE token = ?").run(`+${SESSION_TTL_DAYS} days`, token);
  return publicUser(row);
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Strip secrets from a user row before it leaves the server. */
export function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, is_admin: !!u.is_admin, created_at: u.created_at };
}

export function hasAnyUser() {
  return db.prepare('SELECT 1 FROM users LIMIT 1').get() != null;
}

/* ───────────────────────── Cookies ───────────────────────── */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponentSafe(v);
  }
  return out;
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function readSessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

/** Serialize the session cookie. HttpOnly + SameSite=Lax; Secure only if https. */
export function sessionCookie(token, { maxAgeDays = SESSION_TTL_DAYS, secure = false, clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(maxAgeDays * 86400)}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ───────────────────────── Middleware ───────────────────────── */

// A single default user used only when AUTH_DISABLED=1, so conversations still
// have an owner in the API test suites.
async function bootstrapUser() {
  const existing = db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();
  if (existing) return publicUser(existing);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)')
    .run('_local', await hashPassword(crypto.randomBytes(16).toString('hex')));
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
}

/**
 * Populate req.user from the session cookie (no auth required). Used to scope
 * reads even on optional-auth routes.
 */
export async function attachUser(req, res, next) {
  if (AUTH_DISABLED) {
    req.cookiesToken = null;
    try {
      req.user = await bootstrapUser();
    } catch (e) {
      return next(e);
    }
    return next();
  }
  req.cookiesToken = readSessionToken(req);
  req.user = getUserByToken(req.cookiesToken);
  next();
}

/** Reject the request with 401 unless a valid session is present. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in', auth: true });
  next();
}

/** Reject unless the signed-in user is an admin. */
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in', auth: true });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}
