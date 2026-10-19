/**
 * Authentication + per-user isolation checks (auth ENABLED, real flow).
 *
 * Seeds an ownerless conversation directly in the DB (simulating pre-auth data),
 * then verifies:
 *   - unauthenticated requests are rejected (401),
 *   - the first registered user becomes admin and claims the orphan chat,
 *   - a second user is non-admin, sees an empty list, and cannot touch the
 *     first user's conversation (404),
 *   - login/logout and cookie scoping work,
 *   - admin can create/delete users; non-admin cannot.
 *
 * Run with: node test/auth.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 4398;
const MOCK_PORT = 4399;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'authtest-'));
const dbPath = path.join(tmp, 'test.db');

const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`[${name}:e] ${d}`));
  children.push(child);
  return child;
}
function cleanup() { for (const c of children) { try { c.kill(); } catch { /* ignore */ } } }
process.on('exit', cleanup);

let passed = 0, failed = 0;
function check(label, ok, extra = '') {
  if (ok) { passed++; console.log(`  \u2713 ${label}`); }
  else { failed++; console.log(`  \u2717 ${label}${extra ? `\n      ${String(extra).split('\n').join('\n      ')}` : ''}`); }
}
async function waitFor(fn, ms = 15000) {
  const t0 = Date.now ? Date.now() : Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
}
// A tiny cookie jar per "browser" so we can test session scoping.
function makeClient() {
  let cookie = '';
  return {
    async req(p, { method = 'GET', body } = {}) {
      const res = await fetch(`${BASE}/api${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body != null ? JSON.stringify(body) : undefined
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      return { ok: res.ok, status: res.status, data };
    }
  };
}

async function main() {
  // Seed a pre-auth (ownerless) conversation into a fresh DB BEFORE the server
  // starts, using a throwaway import so it exists when the first user registers.
  process.env.DB_PATH = dbPath;
  const { db, initDb } = await import('../server/db.js');
  initDb();
  db.prepare("INSERT INTO conversations (title, user_id) VALUES ('orphan chat', NULL)").run();

  start('mock', ['test/mock-openai-server.js'], { MOCK_PORT: String(MOCK_PORT) });
  // App starts WITHOUT AUTH_DISABLED so the real auth flow is exercised.
  start('app', ['server/index.js'], {
    PORT: String(APP_PORT), DB_PATH: dbPath,
    OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, OPENAI_MODEL: 'mock-gpt'
  });
  const up = await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok);
  if (!up) throw new Error('app server did not start');

  console.log('\n== Unauthenticated access is blocked ==');
  const anon = makeClient();
  const anonConv = await anon.req('/conversations');
  check('GET /conversations without login -> 401', anonConv.status === 401, JSON.stringify(anonConv));
  const status = await anon.req('/auth/status');
  check('status: not authenticated', status.data?.authenticated === false, JSON.stringify(status.data));
  check('status: needs_setup true (no users yet)', status.data?.needs_setup === true, JSON.stringify(status.data));

  console.log('\n== First user becomes admin and claims orphan chats ==');
  const alice = makeClient();
  const reg1 = await alice.req('/auth/register', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
  check('register first user OK', reg1.status === 201, JSON.stringify(reg1.data));
  check('first user is admin', reg1.data?.user?.is_admin === true, JSON.stringify(reg1.data));
  check('claimed the orphan chat', reg1.data?.claimed_conversations === 1, JSON.stringify(reg1.data));
  const aliceList = await alice.req('/conversations');
  check('alice sees the claimed chat', Array.isArray(aliceList.data) && aliceList.data.length === 1, JSON.stringify(aliceList.data));
  const aliceConvId = aliceList.data?.[0]?.id;

  console.log('\n== Second user is isolated and non-admin ==');
  const bob = makeClient();
  const reg2 = await bob.req('/auth/register', { method: 'POST', body: { username: 'bob', password: 'hunter2!!' } });
  check('register second user OK', reg2.status === 201, JSON.stringify(reg2.data));
  check('second user NOT admin', reg2.data?.user?.is_admin === false, JSON.stringify ? JSON.stringify(reg2.data) : '');
  check('second user claimed nothing', reg2.data?.claimed_conversations === 0, JSON.stringify(reg2.data));
  const bobList = await bob.req('/conversations');
  check('bob sees an empty list', Array.isArray(bobList.data) && bobList.data.length === 0, JSON.stringify(bobList.data));
  const bobTouch = await bob.req(`/conversations/${aliceConvId}`);
  check('bob cannot read alice chat (404)', bobTouch.status === 404, `status=${bobTouch.status}`);
  const bobAdmin = await bob.req('/auth/users');
  check('bob cannot list users (403)', bobAdmin.status === 403, `status=${bobAdmin.status}`);
  const bobCreate = await bob.req('/auth/users', { method: 'POST', body: { username: 'mallory', password: 'abc1234' } });
  check('bob cannot create users (403)', bobCreate.status === 403, `status=${bobCreate.status}`);

  console.log('\n== Login / logout / passwords ==');
  const badLogin = await makeClient().req('/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
  check('wrong password rejected', badLogin.status === 401, JSON.stringify(badLogin.data));
  const carol = makeClient();
  const relogin = await carol.req('/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
  check('alice can log in again', relogin.status === 200 && relogin.data?.user?.is_admin === true, JSON.stringify(relogin.data));
  const meAfter = await carol.req('/auth/me');
  check('me returns alice', meAfter.data?.user?.username === 'alice', JSON.stringify(meAfter.data));
  const logout = await carol.req('/auth/logout', { method: 'POST' });
  check('logout ok', logout.ok === true, JSON.stringify(logout.data));
  const afterLogout = await carol.req('/auth/me');
  check('me after logout -> 401', afterLogout.status === 401, `status=${afterLogout.status}`);

  console.log('\n== Admin user management ==');
  const adminCreate = await alice.req('/auth/users', { method: 'POST', body: { username: 'dave', password: 'davepw123' } });
  check('admin creates a user', adminCreate.status === 201, JSON.stringify(adminCreate.data));
  const adminList = await alice.req('/auth/users');
  check('admin lists all users', Array.isArray(adminList.data?.users) && adminList.data.users.length >= 3, JSON.stringify(adminList.data?.users?.map((u) => u.username)));
  const dave = adminList.data.users.find((u) => u.username === 'dave');
  const adminDelete = await alice.req(`/auth/users/${dave.id}`, { method: 'DELETE' });
  check('admin deletes a user', adminDelete.ok === true, JSON.stringify(adminDelete.data));
  console.log('\n== Duplicate username rejected ==');
  const dup = await makeClient().req('/auth/register', { method: 'POST', body: { username: 'ALICE', password: 'whatever1' } });
  check('case-insensitive duplicate rejected', dup.status === 409 || dup.status === 400, `status=${dup.status}`);
}

main().then(() => {
  console.log(`\n${failed === 0 ? '\u2713' : '\u2717'} ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error(e); cleanup(); process.exit(1); });
