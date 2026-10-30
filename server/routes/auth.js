/**
 * Auth routes. Public: status, register, login. Everything else requires a
 * signed-in session. The first account ever created becomes the admin and is
 * handed all pre-existing (ownerless) conversations. After that, registration
 * is closed unless an admin turns on "Allow new sign-ups" in Settings.
 *
 * Both public credential endpoints are rate limited in memory so a LAN
 * attacker cannot brute-force passwords.
 */
import { Router } from 'express';
import { db, getSetting } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  publicUser, hasAnyUser, sessionCookie, requireAuth, requireAdmin
} from '../services/auth.js';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;
const MIN_PASSWORD_LENGTH = 8;

function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

/** New accounts are opt-in once the first admin exists (set in Settings). */
function registrationOpen() {
  return String(getSetting('allow_registration') || '') === '1';
}

/* ───────────────── In-memory rate limiting for public auth endpoints ───────────────── */

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
const MAX_RATE_KEYS = 5000;
const attempts = new Map(); // `${bucket}|${ip}` -> [timestamps]

function rateKey(bucket, req) {
  return `${bucket}|${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

/**
 * Allow `RATE_MAX_ATTEMPTS` tries per IP per 15 minutes. Successful sign-ins
 * clear the bucket, so a legitimate user is never locked out by their own
 * correct password.
 */
function rateLimit(bucket) {
  return (req, res, next) => {
    const now = Date.now();
    const key = rateKey(bucket, req);
    const recent = (attempts.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX_ATTEMPTS) {
      const retrySec = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000));
      res.setHeader('Retry-After', String(retrySec));
      return res.status(429).json({
        error: `Too many attempts. Try again in ${Math.ceil(retrySec / 60)} minute(s).`
      });
    }
    recent.push(now);
    if (attempts.size > MAX_RATE_KEYS) attempts.clear();
    attempts.set(key, recent);
    next();
  };
}

function clearRateLimit(bucket, req) {
  attempts.delete(rateKey(bucket, req));
}

/** Count conversations a user owns (for the status/me payload). */
function conversationCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM conversations WHERE user_id = ?').get(userId).c;
}

// GET /api/auth/status  (public)
// Tells the frontend whether the first admin account still needs to be made.
router.get('/status', (req, res) => {
  res.json({
    authenticated: !!req.user,
    user: req.user ? { ...req.user, conversation_count: conversationCount(req.user.id) } : null,
    needs_setup: !hasAnyUser(),
    open_registration: !hasAnyUser() || registrationOpen()
  });
});

// POST /api/auth/register { username, password }
router.post('/register', rateLimit('register'), async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!validUsername(username)) {
    return res.status(400).json({ error: 'Username must be 2-32 chars: letters, numbers, dot, underscore or dash.' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  const first = !hasAnyUser();
  // The very first account is always allowed (setup); after that an admin must
  // switch registration on in Settings.
  if (!first && !registrationOpen()) {
    return res.status(403).json({ error: 'Registration is closed. Ask an admin to create an account for you.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  // Hash before opening the transaction: scrypt is async and must not hold the
  // write lock. Re-check "first user" inside the transaction so two simultaneous
  // first registrations cannot both become admin.
  const passwordHash = await hashPassword(password);
  const register = db.transaction(() => {
    const isFirst = !hasAnyUser();
    if (!isFirst && !registrationOpen()) {
      return { closed: true };
    }
    const info = db
      .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
      .run(username, passwordHash, isFirst ? 1 : 0);
    const userId = Number(info.lastInsertRowid);
    // Hand every pre-existing (ownerless) chat to the first account.
    const claimed = isFirst
      ? db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL').run(userId).changes
      : 0;
    return { userId, claimed };
  });

  let result;
  try {
    result = register();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    throw e;
  }
  if (result.closed) {
    return res.status(403).json({ error: 'Registration is closed. Ask an admin to create an account for you.' });
  }

  clearRateLimit('register', req);
  const token = createSession(result.userId);
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecure(req) }));
  res.status(201).json({
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(result.userId)),
    claimed_conversations: result.claimed
  });
});

// POST /api/auth/login { username, password }
router.post('/login', rateLimit('login'), async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  clearRateLimit('login', req);
  const token = createSession(user.id);
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecure(req) }));
  res.json({ user: publicUser(user) });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  destroySession(req.cookiesToken);
  res.setHeader('Set-Cookie', sessionCookie('', { clear: true, secure: isSecure(req) }));
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, conversation_count: conversationCount(req.user.id) } });
});

// POST /api/auth/change-password { current, next }  (any signed-in user)
router.post('/change-password', requireAuth, async (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(current, user.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
  // Force other devices to sign in again.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, req.cookiesToken);
  res.json({ ok: true });
});

/* ───────────────────────── Admin: user management ───────────────────────── */

// GET /api/auth/users  (admin)
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser);
  for (const u of rows) u.conversation_count = conversationCount(u.id);
  res.json({ users: rows });
});

// POST /api/auth/users { username, password, is_admin? }  (admin creates a user)
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const makeAdmin = !!req.body?.is_admin;
  if (!validUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const hash = await hashPassword(password);
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hash, makeAdmin ? 1 : 0);
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That username is already taken.' });
    throw e;
  }
});

// DELETE /api/auth/users/:id  (admin; cannot delete yourself)
router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'user not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // cascades sessions + conversations
  res.json({ ok: true });
});

// PATCH /api/auth/users/:id { is_admin? }  (admin toggles admin rights)
router.patch('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (id === req.user.id && req.body?.is_admin === false) {
    return res.status(400).json({ error: 'You cannot remove your own admin rights.' });
  }
  if (req.body?.is_admin !== undefined) {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(req.body.is_admin ? 1 : 0, id);
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
});

export default router;
