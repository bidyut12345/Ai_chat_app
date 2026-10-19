/**
 * Checks for cancellable tool calls + per-call duration + merged result.
 *
 * A long-running built-in shell command is started by the model; the test
 * cancels just that tool call and asserts:
 *   - a `tool_cancelled` event fires,
 *   - the `tool_result` carries cancelled=true and a duration_ms,
 *   - the turn continues to a normal `done` (the model is told, not aborted),
 *   - the persisted tool row records the cancellation and duration.
 *
 * Run with: node test/tool-cancel.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 4391;
const MOCK_PORT = 4392;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toolcancel-'));
const dbPath = path.join(tmp, 'test.db');
const workDir = path.join(tmp, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

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
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 200)); }
  return false;
}
const api = async (p, opts = {}) => {
  const res = await fetch(`${BASE}/api${p}`, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
};
async function* sseEvents(body) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split(/\r?\n\r?\n/); buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let event = 'message'; const lines = [];
      for (const line of chunk.split(/\r?\n/)) { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) lines.push(line.slice(5).trim()); }
      if (!lines.length) continue;
      try { yield { event, data: JSON.parse(lines.join('\n')) }; } catch { yield { event, data: { raw: lines.join('\n') } }; }
    }
  }
}

async function main() {
  start('mock', ['test/mock-openai-server.js'], { MOCK_PORT: String(MOCK_PORT) });
  start('app', ['server/index.js'], {
    PORT: String(APP_PORT), DB_PATH: dbPath,
    OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`, OPENAI_MODEL: 'mock-gpt'
  });
  const up = await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok);
  if (!up) throw new Error('app server did not start');
  await api('/settings', { method: 'PUT', body: { builtin_shell_timeout: '30' } });

  console.log('\n== Cancelling a running tool call ==');
  const conv = await api('/conversations', { method: 'POST', body: { title: 'cancel test', workdir: workDir, approval_mode: 'auto' } });
  const convId = conv.data.id;
  // A ~3s blocking command gives us a window to cancel mid-flight.
  const cmd = process.platform === 'win32' ? 'ping -n 5 127.0.0.1' : 'sleep 4';
  const kick = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: `call shell__run_command with ${JSON.stringify({ command: cmd })}`, use_tools: true })
  });
  if (!kick.ok) throw new Error(`chat ${kick.status}: ${await kick.text()}`);
  const res = await fetch(`${BASE}/api/chat/stream?conversation_id=${convId}&last_event_id=0`);

  const events = [];
  let cancelled = false;
  for await (const evt of sseEvents(res.body)) {
    events.push(evt);
    if (evt.event === 'tool_call' && !cancelled) {
      cancelled = true;
      // Cancel just this call; the turn should keep going.
      const r = await api('/chat/stop-tool', { method: 'POST', body: { conversation_id: convId, call_id: evt.data.id } });
      check('stop-tool accepted', r.ok && r.data?.cancelled === true, JSON.stringify(r.data));
    }
    if (evt.event === 'done' || evt.event === 'idle') break;
  }

  const cancelledEvt = events.find((e) => e.event === 'tool_cancelled')?.data;
  const resultEvt = events.find((e) => e.event === 'tool_result')?.data;
  check('tool_cancelled event emitted', !!cancelledEvt, JSON.stringify(events.map((e) => e.event)));
  check('tool_result marked cancelled', resultEvt?.cancelled === true, JSON.stringify(resultEvt));
  check('tool_result carries a duration_ms', Number.isFinite(resultEvt?.duration_ms), JSON.stringify(resultEvt));
  check('turn continued to done', events.some((e) => e.event === 'done'), JSON.stringify(events.map((e) => e.event)));

  // Persisted row records the cancellation + duration for reload rendering.
  const fresh = await api(`/conversations/${convId}`);
  const toolRow = (fresh.data.messages || []).find((m) => m.role === 'tool');
  check('persisted tool row marked cancelled', toolRow?.tool_cancelled === 1, JSON.stringify(toolRow));
  check('persisted tool row has duration', Number.isFinite(toolRow?.tool_duration_ms), JSON.stringify(toolRow));
}

main().then(() => {
  console.log(`\n${failed === 0 ? '\u2713' : '\u2717'} ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error(e); cleanup(); process.exit(1); });
