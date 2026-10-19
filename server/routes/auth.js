/**
 * Auth routes. Public: status, register, login. Everything else requires a
 * signed-in session. The first account ever created becomes the admin and is
 * handed all pre-existing (ownerless) conversations. After that, registration
 * stays open but new accounts are ordinary, empty users.
 */
import { Router } from 'express';
import { db } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  publicUser, hasAnyUser, sessionCookie, requireAuth, requireAdmin,
  SESSION_COOKIE
} from '../services/auth.js';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
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
    open_registration: true
  });
});

// POST /api/auth/register { username, password }
router.post('/register', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!validUsername(username)) {
    return res.status(400).json({ error: 'Username must be 2-32 chars: letters, numbers, dot, underscore or dash.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const first = !hasAnyUser();
  const info = db
    .prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), first ? 1 : 0);
  const userId = Number(info.lastInsertRowid);

  let claimed = 0;
  if (first) {
    // Hand every pre-existing (ownerless) chat to the first account.
    claimed = db.prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL').run(userId).changes;
  }

  const token = createSession(userId);
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecure(req) }));
  res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)), claimed_conversations: claimed });
});

// POST /api/auth/login { username, password }
router.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
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
router.post('/change-password', requireAuth, (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.next || '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
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
router.post('/users', requireAuth, requireAdmin, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const makeAdmin = !!req.body?.is_admin;
  if (!validUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }
  const info = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, hashPassword(password), makeAdmin ? 1 : 0);
  res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
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
