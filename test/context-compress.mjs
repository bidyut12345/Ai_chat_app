/**
 * Auto-compress context checks.
 *
 * Seeds a conversation with many long turns (including an assistant tool-call
 * group), then verifies:
 *   - estimateTokens grows with content,
 *   - chooseCompressCutoff keeps the recent window verbatim and never cuts
 *     between an assistant tool-call and its tool results,
 *   - maybeCompress writes a rolling summary, advances summarized_upto, shrinks
 *     the estimated prompt, and emits a `compressed` event,
 *   - the messages built AFTER compression are valid (no orphaned tool results).
 *
 * Run with: node test/context-compress.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 4393;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxcompress-'));
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
let dbRef = null;
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

async function main() {
  start('mock', ['test/mock-openai-server.js'], { MOCK_PORT: String(MOCK_PORT) });
  const up = await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, { method: 'POST', body: '{}' }); return true; } catch { return false; }
  });
  if (!up) throw new Error('mock server did not start');

  // Point the DB + upstream at temp/mock, then import the modules under test.
  process.env.DB_PATH = dbPath;
  const { db, initDb } = await import('../server/db.js');
  dbRef = db;
  initDb();
  const ctx = await import('../server/services/context.js');
  const { buildMessages } = await import('../server/services/chatService.js');

  const info = db.prepare("INSERT INTO conversations (title) VALUES ('compress test')").run();
  const conversationId = Number(info.lastInsertRowid);

  const big = (n) => `turn ${n} ` + 'x'.repeat(4000);
  const insert = db.prepare('INSERT INTO messages (conversation_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 12; i++) {
    insert.run(conversationId, 'user', big(i), null, null);
    insert.run(conversationId, 'assistant', big(i + 100), null, null);
  }
  insert.run(conversationId, 'user', 'please run the tool', null, null);
  insert.run(conversationId, 'assistant', 'calling now', JSON.stringify([{ id: 'call_1', type: 'function', function: { name: 'demo', arguments: '{}' } }]), null);
  insert.run(conversationId, 'tool', 'a'.repeat(8000), null, 'call_1');
  insert.run(conversationId, 'user', 'the latest question', null, null);
  insert.run(conversationId, 'assistant', 'the latest answer', null, null);

  const loadConv = () => db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);

  console.log('\n== estimateTokens ==');
  const est = ctx.estimateTokens([{ role: 'user', content: 'x'.repeat(4000) }]);
  check('estimate scales with length (~1000 for 4000 chars)', est >= 900 && est <= 1100, String(est));

  console.log('\n== chooseCompressCutoff ==');
  const cutoff = ctx.chooseCompressCutoff(conversationId, { summarizedUpto: 0, keepTokens: 3000 });
  check('a cutoff id is chosen', Number.isFinite(cutoff) && cutoff > 0, String(cutoff));
  const firstKept = db.prepare('SELECT role, tool_call_id FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 1').get(conversationId, cutoff);
  check('kept region does not open on an orphaned tool result', firstKept?.role !== 'tool', JSON.stringify(firstKept));

  console.log('\n== maybeCompress ==');
  const cfg = {
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: '', model: 'mock-gpt',
    contextCompressAt: 0, // window drives it
    contextKeep: 3000
  };
  const events = [];
  const conv0 = loadConv();
  const beforeTokens = ctx.estimateTokens(buildMessages(conversationId, {}));
  const result = await ctx.maybeCompress(conv0, cfg, (ev, data) => events.push({ ev, data }));
  check('compression reported success', result.compressed === true, JSON.stringify(result));
  check('tokensAfter < tokensBefore', result.tokensAfter < result.tokensBefore, `${result.tokensBefore} → ${result.tokensAfter}`);
  const compressedEvt = events.find((e) => e.ev === 'compressed');
  check('compressed event emitted', !!compressedEvt, JSON.stringify(events.map((e) => e.ev)));

  const after = loadConv();
  check('summary persisted', typeof after.summary === 'string' && after.summary.length > 0, JSON.stringify(after.summary));
  check('summarized_upto advanced', (after.summarized_upto || 0) > 0, String(after.summarized_upto));

  const afterTokens = ctx.estimateTokens(buildMessages(conversationId, { summary: after.summary, summarizedUpto: after.summarized_upto }));
  check('prompt shrank after compression', afterTokens < beforeTokens, `${beforeTokens} → ${afterTokens}`);

  console.log('\n== history validity after compression ==');
  const msgs = buildMessages(conversationId, { summary: after.summary, summarizedUpto: after.summarized_upto });
  const callIds = new Set();
  let orphan = null;
  for (const m of msgs) {
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) callIds.add(tc.id);
    if (m.role === 'tool' && !callIds.has(m.tool_call_id)) orphan = m.tool_call_id;
  }
  check('no orphaned tool results in built messages', orphan == null, `orphan=${orphan}`);

  console.log('\n== disabled ==');
  const conv1 = loadConv();
  const noop = await ctx.maybeCompress(conv1, { ...cfg, contextKeep: 0 }, () => {});
  check('disabled (window 0) does nothing', noop.compressed === false, JSON.stringify ? String(noop.compressed) : String(noop));
}

main().then(() => {
  console.log(`\n${failed === 0 ? '\u2713' : '\u2717'} ${passed} passed, ${failed} failed`);
  cleanup();
  try { dbRef?.close?.(); } catch { /* ignore */ }
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => { console.error ? console.error(e) : console.error(e); cleanup(); process.exit(1); });
