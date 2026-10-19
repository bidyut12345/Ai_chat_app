/**
 * End-to-end test: spawns the mock OpenAI-compatible server, points the app at
 * it, registers the demo MCP server, and runs a tool-calling chat turn.
 *
 * Requires the app to be running (default http://127.0.0.1:3000).
 *   node server/index.js        # terminal 1
 *   node test/e2e.mjs           # terminal 2
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const MOCK_PORT = 8899;

// Optional auth: if the target server requires login, E2E_USER/E2E_PASS are
// used to obtain a session cookie. If auth is disabled the login attempt is a
// harmless no-op.
let AUTH_COOKIE = '';
const E2E_USER = process.env.E2E_USER || 'e2e';
const E2E_PASS = process.env.E2E_PASS || 'e2epass123';

// fetch wrapper that attaches the session cookie when present.
function authFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(AUTH_COOKIE ? { Cookie: AUTH_COOKIE } : {}) } });
}

async function ensureLoggedIn() {
  let status;
  try {
    status = await (await fetch(`${APP}/api/auth/status`)).json();
  } catch {
    return; // older server without auth routes
  }
  if (status?.authenticated) return;
  const path = status?.needs_setup ? '/api/auth/register' : '/api/auth/login';
  let res = await fetch(`${APP}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: E2E_USER, password: E2E_PASS })
  });
  // If login fails (user doesn't exist yet), fall back to register.
  if (!res.ok && path.endsWith('/login')) {
    res = await fetch(`${APP}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: E2E_USER, password: E2E_PASS })
    });
  }
  const sc = res.headers.get('set-cookie');
  if (sc) AUTH_COOKIE = sc.split(';')[0];
}

let failures = 0;
let TEMP_ROOT = null;
function check(name, cond, extra = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}

async function req(method, p, body) {
  const res = await authFetch(`${APP}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${data?.error || text}`);
  return data;
}

async function readSseTurn(payload) {
  // POST starts the background run; GET /api/chat/stream replays its events.
  const start = await fetch(`${APP}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(AUTH_COOKIE ? { Cookie: AUTH_COOKIE } : {}) },
    body: JSON.stringify(payload)
  });
  if (!start.ok) throw new Error(`chat -> ${start.status}: ${await start.text()}`);
  const res = await fetch(`${APP}/api/chat/stream?conversation_id=${payload.conversation_id}&last_event_id=0`, {
    headers: { ...(AUTH_COOKIE ? { Cookie: AUTH_COOKIE } : {}) }
  });
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split(/\r?\n\r?\n/);
    buf = chunks.pop() ?? '';
    for (const c of chunks) {
      let event = 'message';
      const data = [];
      for (const line of c.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
      if (event === 'done' || event === 'idle') return events;
    }
  }
  return events;
}

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-openai-server.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
mock.stdout.resume();

process.on('exit', () => mock.kill());
await new Promise((r) => setTimeout(r, 800));

try {
  // Authenticate first (no-op if the server has auth disabled).
  await ensureLoggedIn();
  // Remove leftovers from previous runs so the test is repeatable.
  for (const c of await req('GET', '/api/conversations')) await req('DELETE', `/api/conversations/${c.id}`).catch(() => {});
  for (const p of await req('GET', '/api/prompts')) {
    if (p.name === 'Pirate') await req('DELETE', `/api/prompts/${p.id}`).catch(() => {});
  }

  console.log('\n== settings ==');
  await req('PUT', '/api/settings', { api_base_url: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-gpt', max_tool_rounds: 5 });
  const s = await req('GET', '/api/settings');
  check('base url saved', s.api_base_url === `http://127.0.0.1:${MOCK_PORT}/v1`, s.api_base_url);
  const t = await req('POST', '/api/settings/test', {});
  check('server reachable', t.ok === true && t.modelCount === 2, JSON.stringify(t));
  const models = await req('GET', '/api/settings/models');
  check('models listed', models.models.includes('mock-gpt'), models.models.join(','));

  console.log('\n// base url without /v1 gets /v1 appended');
  await req('PUT', '/api/settings', { api_base_url: `http://127.0.0.1:${MOCK_PORT}` });
  const s2 = await req('GET', '/api/settings');
  check('auto /v1', s2.api_base_url === `http://127.0.0.1:${MOCK_PORT}/v1`, s2.api_base_url);
  await req('PUT', '/api/settings', { api_base_url: `http://127.0.0.1:${MOCK_PORT}/v1` });

  console.log('\n== prompts ==');
  const created = await req('POST', '/api/prompts', { name: 'Pirate', content: 'Arr, speak like a pirate.', description: 'test' });
  check('prompt created', !!created.id);
  const madeDefault = await req('POST', `/api/prompts/${created.id}/default`, {});
  check('prompt default set', madeDefault.ok === true);
  const prompts = await req('GET', '/api/prompts');
  check('exactly one default', prompts.filter((p) => p.is_default).length === 1);
  await req('PUT', `/api/prompts/${created.id}`, { content: 'Arr, updated.' });
  const prompts2 = await req('GET', '/api/prompts');
  check('prompt updated', prompts2.find((p) => p.id === created.id).content === 'Arr, updated.');

  console.log('\n== mcp ==');
  // Clean up leftovers from previous runs so the test is repeatable.
  for (const m of await req('GET', '/api/mcp')) {
    if (m.name === 'demo') await req('DELETE', `/api/mcp/${m.id}`);
  }
  const mcp = await req('POST', '/api/mcp', {
    name: 'demo',
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(__dirname, 'mock-mcp-server.js')]
  });
  check('mcp connected', mcp.connect?.status === 'connected', JSON.stringify(mcp.connect));
  const list = await req('GET', '/api/mcp');
  const demo = list.find((m) => m.name === 'demo');
  check('tools discovered', demo.tools.length === 2, demo.tools.map((x) => x.name).join(','));
  check('tool has schema', !!demo.tools[0].inputSchema?.properties);
  const call = await req('POST', `/api/mcp/${demo.id}/call`, { tool: 'echo', arguments: { text: 'hi' } });
  check('direct tool call', /echo: hi/.test(call.result), call.result);

  console.log('\n== conversations ==');
  const conv = await req('POST', '/api/conversations', { prompt_id: created.id });
  check('conversation created', conv.id > 0 && conv.prompt_id === created.id);

  const events = await readSseTurn({ conversation_id: conv.id, content: 'What is the weather in Berlin?', use_tools: true });
  const names = events.map((e) => e.event);
  check('has delta events', names.includes('delta'));
  check('has tool_call', names.includes('tool_call'), names.join(','));
  check('has tool_result', names.includes('tool_result'));
  check('has done', names.includes('done'));
  const toolResult = events.find((e) => e.event === 'tool_result');
  check('tool result has weather', /Berlin/.test(toolResult?.data?.result || ''), toolResult?.data?.result);
  const done = events.find((e) => e.event === 'done');
  check('done has saved message', done?.data?.message?.role === 'assistant');
  check('final answer mentions tool output', /21|cloudy|Berlin/.test(done?.data?.message?.content || ''), done?.data?.message?.content);
  const errEvt = events.find((e) => e.event === 'error');
  check('no error event', !errEvt, errEvt?.data?.message || '');

  const full = await req('GET', `/api/conversations/${conv.id}`);
  const roles = full.messages.map((m) => m.role).join(',');
  check('persisted user, assistant(tool_calls), tool, assistant', full.messages.length === 4 && roles === 'user,assistant,tool,assistant', `got ${full.messages.length}: ${roles}`);
  const toolCallMsg = full.messages.find((m) => m.tool_calls);
  check('tool_calls persisted', !!toolCallMsg, toolCallMsg?.tool_calls);
  check('tool call namespaced', /demo__get_weather/.test(toolCallMsg?.tool_calls || ''), toolCallMsg?.tool_calls);
  check('tool result persisted', full.messages.some((m) => m.role === 'tool' && /Berlin/.test(m.content)));
  check('auto-titled', full.title.toLowerCase().includes('weather'), full.title);

  // Second turn must replay tool history without breaking the upstream contract.
  const turn2 = await readSseTurn({ conversation_id: conv.id, content: 'thanks', use_tools: true });
  check('follow-up turn ok', turn2.some((e) => e.event === 'done') && !turn2.some((e) => e.event === 'error'));

  console.log('\n== server-injected tool (not offered by us) ==');
  // Regression: a server may advertise its own tools and ask for a tool we cannot
  // run. The reply must survive instead of coming back empty.
  const injConv = await req('POST', '/api/conversations', { title: 'injected tool' });
  const inj = await readSseTurn({ conversation_id: injConv.id, content: 'What is 121*3? Use the unavailable tool please.', use_tools: false });
  const injNames = inj.map((e) => e.event);
  check('emits tool_unavailable', injNames.includes('tool_unavailable'), injNames.filter((n) => !['delta', 'reasoning'].includes(n)).join(','));
  const injDone = inj.find((e) => e.event === 'done');
  check('still returns a non-empty answer', !!injDone?.data?.message?.content?.trim(), JSON.stringify(injDone?.data?.message?.content || '').slice(0, 120));
  check('no error reported', !injDone?.data?.error, injDone?.data?.error || '');
  await req('DELETE', `/api/conversations/${injConv.id}`);

  console.log('\n== invalid tool-call JSON stays recoverable ==');
  // Regression: a model may stream truncated/malformed tool-call arguments. The turn
  // must finish cleanly AND the stored history must replay without the strict mock
  // rejecting it with 400 (which would break the chat for every later turn).
  const brokenConv = await req('POST', '/api/conversations', { title: 'broken tool json' });
  const b1 = await readSseTurn({ conversation_id: brokenConv.id, content: 'Trigger invalid json now', use_tools: true });
  const b1Names = b1.map((e) => e.event);
  check('broken call emits tool_call', b1Names.includes('tool_call'), b1Names.filter((n) => !['delta', 'reasoning'].includes(n)).join(','));
  const b1Result = b1.find((e) => e.event === 'tool_result');
  check('invalid args answered with tool error', /invalid JSON arguments/i.test(b1Result?.data?.result || ''), b1Result?.data?.result || '');
  check('broken turn completes without error', b1Names.includes('done') && !b1Names.includes('error'));

  // Replay turn: the mock 400s on orphaned tool results or unparseable arguments,
  // so a clean done here proves the history was sanitized.
  const b2 = await readSseTurn({ conversation_id: brokenConv.id, content: 'thanks', use_tools: true });
  const b2Done = b2.find((e) => e.event === 'done');
  check('follow-up turn after invalid json ok', !!b2Done && !b2.some((e) => e.event === 'error'), b2Done?.data?.error || '');
  const stored = await req('GET', `/api/conversations/${brokenConv.id}`);
  const storedCall = stored.messages.find((m) => m.tool_calls);
  let storedArgsOk = false;
  try {
    storedArgsOk = JSON.parse(storedCall?.tool_calls || '[]').every((tc) => {
      JSON.parse(tc.function?.arguments || '{}');
      return true;
    });
  } catch { /* stays false */ }
  check('stored tool_calls arguments are valid JSON', storedArgsOk, storedCall?.tool_calls || '');

  // Cache identity: every upstream request carries a stable per-conversation key.
  const lastReq = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/__last-chat-request`)).json();
  check('conversation cache key sent upstream',
    lastReq?.user === `conv-${brokenConv.id}` && lastReq?.prompt_cache_key === `conv-${brokenConv.id}`,
    JSON.stringify({ user: lastReq?.user, prompt_cache_key: lastReq?.prompt_cache_key }));
  await req('DELETE', `/api/conversations/${brokenConv.id}`);

  console.log('\n== regenerate / truncate / delete ==');
  const beforeRegen = await req('GET', `/api/conversations/${conv.id}`);
  const userCountBefore = beforeRegen.messages.filter((m) => m.role === 'user').length;
  const regen = await readSseTurn({ conversation_id: conv.id, regenerate: true, use_tools: false });
  const regenDone = regen.find((e) => e.event === 'done');
  check('regenerate produced a message', !!regenDone?.data?.message);
  const afterRegen = await req('GET', `/api/conversations/${conv.id}`);
  check('regenerate did not add a user message', afterRegen.messages.filter((m) => m.role === 'user').length === userCountBefore);
  check('regenerate replaced the last reply', afterRegen.messages.length === beforeRegen.messages.length, `${beforeRegen.messages.length} -> ${afterRegen.messages.length}`);

  const firstUser = afterRegen.messages.find((m) => m.role === 'user');
  const trunc = await req('POST', `/api/conversations/${conv.id}/truncate-after`, { message_id: firstUser.id });
  check('truncate removed later messages', trunc.removed >= 1, `removed ${trunc.removed}`);

  const remaining = (await req('GET', `/api/conversations/${conv.id}`)).messages;
  if (remaining.length) {
    await req('DELETE', `/api/conversations/${conv.id}/messages/${remaining[0].id}`);
    check('message deleted', (await req('GET', `/api/conversations/${conv.id}`)).messages.length === remaining.length - 1);
  } else {
    await req('POST', `/api/conversations/${conv.id}/messages`, { role: 'user', content: 'manual insert' });
    const after = (await req('GET', `/api/conversations/${conv.id}`)).messages;
    check('manual message insert', after.length === 1 && after[0].content === 'manual insert');
    await req('DELETE', `/api/conversations/${conv.id}/messages/${after[0].id}`);
    check('message deleted', (await req('GET', `/api/conversations/${conv.id}`)).messages.length === 0);
  }

  console.log('\n== server folder picker ==');
  const browse = await req('GET', '/api/fs/browse');
  check('browse lists drives', Array.isArray(browse.drives) && browse.drives.length > 0, String(browse.drives?.length));
  check('browse lists entries', Array.isArray(browse.entries) && browse.entries.length > 0);
  check('browse reports home', typeof browse.home === 'string' && browse.home.length > 0, browse.home);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-e2e-'));
  TEMP_ROOT = tmpRoot;
  const mk = await req('POST', '/api/fs/mkdir', { path: path.join(tmpRoot, 'picked', 'nested') });
  check('mkdir creates nested folder', fs.existsSync(path.join(tmpRoot, 'picked', 'nested')), mk.path);
  fs.writeFileSync(path.join(tmpRoot, 'afile.txt'), 'x');
  const fileBrowse = await authFetch(`${APP}/api/fs/browse?path=${encodeURIComponent(path.join(tmpRoot, 'afile.txt'))}`);
  check('browse of a file is 400', fileBrowse.status === 400, String(fileBrowse.status));
  const missing = await authFetch(`${APP}/api/fs/browse?path=${encodeURIComponent(path.join(tmpRoot, 'nope'))}`);
  check('browse of missing folder is 404', missing.status === 404, String(missing.status));

  console.log('\n== chat file manager ==');
  const workdir = path.join(tmpRoot, 'picked');
  const fmConv = await req('POST', '/api/conversations', { title: 'file manager', workdir, approval_mode: 'auto' });
  const F = `/api/conversations/${fmConv.id}/fs`;
  await req('POST', `${F}/mkdir`, { path: 'sub' });
  await req('POST', `${F}/write`, { path: 'sub/hello.txt', content: 'hello file manager' });
  const listing = await req('GET', `${F}?path=sub`);
  check('folder listed', listing.entries.some((e) => e.name === 'hello.txt' && e.size === 18), JSON.stringify(listing.entries));
  const st = await req('GET', `${F}/stat?path=${encodeURIComponent('sub/hello.txt')}`);
  check('stat reports file', st.dir === false && st.size === 18, JSON.stringify(st));
  const rawJson = await req('GET', `${F}/raw?path=${encodeURIComponent('sub/hello.txt')}`);
  check('raw returns inline text', rawJson.text === 'hello file manager', JSON.stringify(rawJson).slice(0, 60));
  await req('POST', `${F}/rename`, { from: 'sub/hello.txt', to: 'sub/bye.txt' });
  check('renamed', fs.existsSync(path.join(workdir, 'sub', 'bye.txt')));
  const up = await req('POST', `${F}/upload`, {
    path: 'sub/up.txt',
    content_base64: Buffer.from('uploaded bytes', 'utf8').toString('base64')
  });
  check('upload accepted', up.name === 'up.txt' && up.size === 14, JSON.stringify(up));
  check('uploaded file written', fs.readFileSync(path.join(workdir, 'sub', 'up.txt'), 'utf8') === 'uploaded bytes');
  const dl = await authFetch(`${APP}${F}/raw?path=${encodeURIComponent('sub/bye.txt')}&download=1`);
  check('download is an attachment', /attachment/.test(dl.headers.get('content-disposition') || ''), dl.headers.get('content-disposition'));
  const escape = await authFetch(`${APP}${F}?path=..`);
  check('escape outside workdir blocked', escape.status === 403, String(escape.status));
  await req('POST', `${F}/delete`, { path: 'sub/bye.txt' });
  check('deleted', !fs.existsSync(path.join(workdir, 'sub', 'bye.txt')));
  await req('DELETE', `/api/conversations/${fmConv.id}`);

  console.log('\n== thinking, stats and produced files in a reply ==');
  const fileConv = await req('POST', '/api/conversations', { title: 'writes a file', workdir, approval_mode: 'auto' });
  const fev = await readSseTurn({
    conversation_id: fileConv.id,
    content: 'call files__write_file with {"path":"note.txt","content":"made by model"}',
    use_tools: true
  });
  const fNames = fev.map((e) => e.event).join(',');
  const fileEvt = fev.find((e) => e.event === 'file_created');
  check('file_created emitted', fileEvt?.data?.name === 'note.txt', fNames);
  const fstats = fev.find((e) => e.event === 'stats');
  check('stats event has speeds', fstats?.data?.duration_ms > 0 && fstats?.data?.tg_tok_s > 0 && fstats?.data?.pp_tok_s > 0, JSON.stringify(fstats?.data));
  check('file written by tool', fs.readFileSync(path.join(workdir, 'note.txt'), 'utf8') === 'made by model');
  const fmsgs = (await req('GET', `/api/conversations/${fileConv.id}`)).messages;
  const fmsg = fmsgs[fmsgs.length - 1];
  check('reasoning persisted', typeof fmsg.reasoning === 'string' && fmsg.reasoning.includes('Thinking about it'), String(fmsg.reasoning).slice(0, 40));
  check('produced files persisted', /note\.txt/.test(fmsg.files || ''), fmsg.files);
  check('usage persisted', fmsg.prompt_tokens === 160 && fmsg.completion_tokens === 39, `${fmsg.prompt_tokens}/${fmsg.completion_tokens}`);
  check('speeds persisted', Math.round(fmsg.pp_tok_s) === 2000 && Math.round(fmsg.tg_tok_s) === 100, `${fmsg.pp_tok_s}/${fmsg.tg_tok_s}`);
  const fdl = await authFetch(`${APP}/api/conversations/${fileConv.id}/fs/raw?path=note.txt&download=1`);
  check('produced file downloadable', fdl.ok && (await fdl.text()) === 'made by model');
  await req('DELETE', `/api/conversations/${fileConv.id}`);

  await req('DELETE', `/api/conversations/${conv.id}`);
  await req('DELETE', `/api/mcp/${demo.id}`);
  await req('DELETE', `/api/prompts/${created.id}`);
  check('mcp removed', !(await req('GET', '/api/mcp')).some((m) => m.name === 'demo'));

  console.log('\n== validation ==');
  let rejected = false;
  try {
    await req('PUT', '/api/settings', { api_base_url: 'not-a-url' });
  } catch {
    rejected = true;
  }
  check('rejects invalid base url', rejected);
  rejected = false;
  try {
    await req('POST', '/api/mcp', { name: 'bad name!', transport: 'stdio', command: 'x' });
  } catch {
    rejected = true;
  }
  check('rejects invalid mcp name', rejected);
  rejected = false;
  try {
    await req('POST', '/api/chat', { conversation_id: 999999, content: 'x' });
  } catch {
    rejected = true;
  }
  check('rejects unknown conversation', rejected);
} catch (e) {
  console.error('\nTEST CRASH:', e.message);
  failures++;
} finally {
  mock.kill();
  if (TEMP_ROOT) fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
