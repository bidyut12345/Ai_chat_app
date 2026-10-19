/**
 * Verifies two server fixes against an ISOLATED database + port so the
 * production data (data/app.db) is never touched:
 *
 *   1. Ordered segments: a tool round persists an interleaved layout on the
 *      rows ({r} reasoning, {tc} tool call, {f} file, {t} text) instead of
 *      clamping everything to the end.
 *   2. Orphan healing: if an assistant tool_calls row is left WITHOUT a
 *      matching tool result (as happens when a turn dies mid-round), the NEXT
 *      request must be healed so a strict upstream does not reject the replay.
 *
 * Usage:  node test/verify-fixes.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const APP_PORT = 3177;
const MOCK_PORT = 3178;
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

let failures = 0;
// Hard watchdog: never let the isolated test hang the runner.
const watchdog = setTimeout(() => {
  console.log ? console.log('WATCHDOG: timed out') : console.error('WATCHDOG: timed out');
  process.exit(2);
}, 60000);
watchdog.unref?.();
function check(name, cond, extra = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

// ── Strict mock: rejects any assistant tool_call lacking a tool result ─────
// Scenario control via magic substrings in the last user message:
//   "TRIGGER_TOOL"  -> emit reasoning + a tool call (round 1), then text (round 2)
//   "TRIGGER_MIDFAIL" -> emit reasoning + partial text, then ABORT the stream
let mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm' }] }));
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    // Strict validation: every assistant tool_calls entry must be followed by a
    // tool message referencing its id, and every tool message must map to an id.
    const problems = [];
    const openIds = new Set();
    const seenResult = new Set();
    for (const m of body.messages || []) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) if (tc?.id) openIds.add(tc.id);
      }
      if (m.role === 'tool') {
        if (!openIds.has(m.tool_call_id)) problems.push(`orphan tool result ${m.tool_call_id}`);
        seenResult.add(m.tool_call_id);
      }
    }
    for (const id of openIds) if (!seenResult.has(id)) problems.push(`missing tool result for ${id}`);
    if (problems.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: problems.join('; ') } }));
    }
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    const txt = lastUser?.content || '';
    const alreadyRan = (body.messages || []).some((m) => m.role === 'tool');
    const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (/TRIGGER_MIDFAIL/i.test(txt)) {
      // Emit reasoning + text, then sever the connection mid-stream.
      sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'partial think ' } }] });
      sse({ choices: [{ index: 0, delta: { content: 'partial answer ' } }] });
      res.write(': keep-alive\n\n');
      setTimeout(() => res.destroy(), 120); // hard abort, like a crashed engine
      return;
    }

    if (/TRIGGER_TOOL/i.test(txt) && Array.isArray(body.tools) && body.tools.length && !alreadyRan) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'I should use the tool. ' } }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'files__write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'hi from test' }) } }] } }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Final text round.
    sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Now I can answer. ' } }] });
    sse({ choices: [{ index: 0, delta: { content: 'Done: the file is written.' } }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route ${url.pathname}` } }));
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

// ── Isolated app instance ──────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fixes-'));
const dbPath = path.join(tmp, 'test.db');
const workdir = path.join(tmp, 'work');
fs.mkdirSync(workdir, { recursive: true });
const app = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: dbPath, PORT: String(APP_PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
app.stdout.resume();
app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${APP}/api/conversations`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('app did not start');
}

async function api(method, p, body) {
  const res = await fetch(`${APP}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const t = await res.text();
  let data; try { data = t ? JSON.parse(t) : null; } catch { data = { raw: t }; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${data?.error || t}`);
  return data;
}

async function chatTurn(payload, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const start = await fetch(`${APP}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!start.ok) { clearTimeout(timer); return { error: `${start.status}`, events: [] }; }
  const res = await fetch(`${APP}/api/chat/stream?conversation_id=${payload.conversation_id}&last_event_id=0`, { signal: ac.signal });
  const events = [];
  if (!res.ok) return { error: `${res.status}`, events };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? '';
      for (const p of parts) {
        let event = 'message'; const data = [];
        for (const line of p.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length) { try { events.push({ event, data: JSON.parse(data.join('\n')) }); } catch {} }
      }
    }
  } catch (e) { /* stream severed by mock or timed out */ }
  finally { clearTimeout(timer); }
  return { events };
}

let convId = null;
try {
  await waitUp();
  await api('PUT', '/settings', { api_base_url: `${MOCK}/v1`, model: 'm', max_tool_rounds: 5, builtin_approval_mode: 'auto', builtin_file_root: workdir, builtin_shell_cwd: workdir });

  console.log('\n== Fix 1: ordered segments on a tool round ==');
  const conv = await api('POST', '/conversations', { title: 'order test', workdir, approval_mode: 'auto' });
  convId = conv.id;
  const t1 = await chatTurn({ conversation_id: convId, content: 'Please TRIGGER_TOOL now', use_tools: true });
  const names = t1.events.map((e) => e.event);
  check('tool round streamed tool_call', names.includes('tool_call'), names.join(','));
  check('tool round streamed reasoning', names.includes('reasoning'));

  // Inspect persisted rows.
  const fresh = await api('GET', `/conversations/${convId}`);
  const msgs = fresh.messages;
  const toolRow = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
  check('tool-call assistant row persisted', !!toolRow);
  const segs = toolRow?.segments ? JSON.parse(toolRow.segments) : null;
  check('tool-call row has segments', !!segs, JSON.stringify(segs));
  // The tool-call row segments should reference the reasoning and the tool call id.
  const hasR = segs?.some((s) => s.t === 'r');
  const hasTc = segs?.some((s) => s.t === 'tc' && s.id === 'c1');
  check('segments include a reasoning run', hasR);
  check('segments include the tool call', hasTc);

  const finalRow = [...msgs].reverse().find((m) => m.role === 'assistant' && !m.tool_calls);
  check('final assistant row persisted', !!finalRow);
  const fsegs = finalRow?.segments ? JSON.parse(finalRow.segments) : null;
  check('final row has segments', !!fsegs, JSON.stringify(fsegs));
  // Ordering sanity: no file/text segment should precede its reasoning in the list.
  if (fsegs && fsegs.length) {
    const firstR = fsegs.findIndex((s) => s.t === 'r');
    const firstT = fsegs.findIndex((s) => s.t === 't');
    check('final row reasoning precedes text', firstR === -1 || firstT === -1 || firstR < firstT, JSON.stringify(fsegs));
  }

  console.log('\n== Fix 2: orphan healing after mid-round failure ==');
  const conv2 = await api('POST', '/conversations', { title: 'heal test', workdir, approval_mode: 'auto' });
  const conv2Id = conv2.id;
  // Round 1: real tool call + result (so history has a completed tool pair).
  await chatTurn({ conversation_id: conv2Id, content: 'First TRIGGER_TOOL please', use_tools: true });
  // Now force a state with an orphan: inject an assistant tool_calls row with no
  // result by asking the mid-fail turn, then manually create the orphan via the
  // messages API if available. Simplest robust check: directly write a tool_calls
  // assistant row into the DB and confirm the next chat request gets a 200 (healed)
  // rather than the strict-mock 400.
  const raw = new Database(dbPath);
  raw.prepare('INSERT INTO messages (conversation_id, role, content, tool_calls) VALUES (?, ?, ?, ?)').run(
    conv2Id, 'assistant', 'I will call a tool',
    JSON.stringify([{ id: 'orphan1', type: 'function', function: { name: 'files__write_file', arguments: '{"path":"x.txt","content":"y"}' } }])
  );
  raw.close();
  // Next turn: buildMessages must heal orphan1 with a synthetic tool result, so the
  // strict mock should NOT reject the replay.
  const t2 = await chatTurn({ conversation_id: conv2Id, content: 'continue please', use_tools: true });
  check('next request not rejected by strict upstream', !t2.error, t2.error || 'ok');
  check('next request produced a reply', t2.events.some((e) => e.event === 'delta'));

  // Verify a synthetic tool result for orphan1 was persisted.
  const after = await api('GET', `/conversations/${conv2Id}`);
  const healed = after.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'orphan1');
  check('orphan healed with a synthetic tool result', !!healed, healed ? healed.content.slice(0, 40) : 'none');
} catch (e) {
  console.error ? console.error('CRASH', e) : console.log('CRASH', e, e?.stack);
  failures++;
} finally {
  app.kill();
  mock.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
