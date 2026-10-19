/**
 * End-to-end checks for the built-in `files` and `shell` MCP servers and the
 * tool-approval flow. Run with: node test/builtin-tools.mjs
 *
 * Starts its own mock OpenAI server and app server on scratch ports with a
 * throwaway database, so it never touches your real data.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 4321;
const MOCK_PORT = 4322;
const BASE = `http://127.0.0.1:${APP_PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-check-'));
const dbPath = path.join(tmp, 'test.db');
const workDir = path.join(tmp, 'workspace');
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(path.join(workDir, 'notes.txt'), 'alpha\nbravo\ncharlie\n');

const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`[${name}:e] ${d}`));
  children.push(child);
  return child;
}

let passed = 0;
let failed = 0;
function check(label, ok, extra = '') {
  if (ok) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.log(`  \u2717 ${label}${extra ? `\n      ${String(extra).split('\n').join('\n      ')}` : ''}`);
  }
}

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const api = async (p, opts = {}) => {
  const res = await fetch(`${BASE}/api${p}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
};

/** Call one built-in tool directly, scoped to a policy (default: the workspace). */
const callTool = (server, tool, args = {}, policy = {}) =>
  api(`/mcp/${server.id}/call`, {
    method: 'POST',
    body: { tool, arguments: args, policy: { workdir: workDir, file_access: 'restricted', shell_access: 'restricted', ...policy } }
  });

/** Parse an SSE response body into { event, data } records. */
async function* sseEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split(/\r?\n\r?\n/);
    buf = chunks.pop() ?? '';
    for (const chunk of chunks) {
      let event = 'message';
      const lines = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) lines.push(line.slice(5).trim());
      }
      if (!lines.length) continue;
      try {
        yield { event, data: JSON.parse(lines.join('\n')) };
      } catch {
        yield { event, data: { raw: lines.join('\n') } };
      }
    }
  }
}

/**
 * Drive one chat turn in a fresh conversation, answering approval prompts with
 * `onApproval`. `policy` overrides the chat's own tool policy.
 */
async function chatTurn(content, onApproval, policy = {}) {
  const conv = await api('/conversations', {
    method: 'POST',
    body: { title: 'builtin test', workdir: workDir, ...policy }
  });
  const events = [];
  const start = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conv.data.id, content, use_tools: true })
  });
  if (!start.ok) throw new Error(`chat ${start.status}: ${await start.text()}`);
  const res = await fetch(`${BASE}/api/chat/stream?conversation_id=${conv.data.id}&last_event_id=0`);
  const pending = [];
  for await (const evt of sseEvents(res.body)) {
    events.push(evt);
    if (evt.event === 'done' || evt.event === 'idle') break;
    if (evt.event === 'approval_request' && onApproval) {
      pending.push(
        (async () => {
          const scope = await onApproval(evt.data);
          await api(`/approvals/${evt.data.id}`, { method: 'POST', body: { allowed: scope !== 'deny', scope: scope === 'deny' ? 'once' : scope } });
        })()
      );
    }
  }
  await Promise.all(pending);
  return { conversationId: conv.data.id, events };
}

const find = (events, name) => events.find((e) => e.event === name)?.data;
const all = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);
const toolResults = (events) => all(events, 'tool_result').map((d) => d.result).join('\n');

async function main() {
  start('mock', ['test/mock-openai-server.js'], { MOCK_PORT: String(MOCK_PORT) });
  start('app', ['server/index.js'], {
    PORT: String(APP_PORT),
    DB_PATH: dbPath,
    OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OPENAI_MODEL: 'mock-gpt'
  });

  const up = await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok);
  if (!up) throw new Error('app server did not start');

  // The built-in tools are scoped per conversation, so the only global knob
  // left is the command timeout.
  await api('/settings', { method: 'PUT', body: { builtin_shell_timeout: '30' } });

  console.log('\nBuilt-in MCP servers');
  const mcp = (await api('/mcp')).data;
  const files = mcp.find((s) => s.builtin_key === 'files');
  const shell = mcp.find((s) => s.builtin_key === 'shell');
  check('files server is built in and connected', files?.builtin === true && files?.status === 'connected');
  check('shell server is built in and connected', shell?.builtin === true && shell?.status === 'connected');
  check('files exposes 10 tools', files?.tools?.length === 10, `got ${files?.tools?.length}`);
  check('shell exposes 6 tools', shell?.tools?.length === 6, `got ${shell?.tools?.length}`);
  check('read-only tools are annotated', files.tools.every((t) => ['list_directory', 'read_file', 'file_info', 'search_files', 'search_text'].includes(t.name) === (t.annotations?.readOnlyHint === true)));

  const del = await api(`/mcp/${files.id}`, { method: 'DELETE' });
  check('built-in server cannot be deleted', del.status === 400, JSON.stringify(del.data));
  const reconfig = await api(`/mcp/${files.id}`, { method: 'PUT', body: { name: 'hacked' } });
  check('built-in server cannot be renamed', reconfig.status === 400);
  const off = await api(`/mcp/${files.id}`, { method: 'PUT', body: { enabled: false } });
  check('built-in server can be switched off', off.data?.enabled === false);
  const on = await api(`/mcp/${files.id}`, { method: 'PUT', body: { enabled: true } });
  check('built-in server can be switched back on', on.data?.enabled === true && on.data?.connect?.status === 'connected');

  console.log('\nDirect tool calls (bypass approval, as the MCP test button does)');
  const ls = await callTool(files, 'list_directory', { path: '.' });
  check('list_directory sees the workspace', ls.data?.result?.includes('notes.txt'), ls.data?.result);
  const rd = await callTool(files, 'read_file', { path: 'notes.txt' });
  check('read_file returns numbered lines', rd.data?.result?.includes('2: bravo'), rd.data?.result);
  const st = await callTool(shell, 'run_command', { command: 'echo builtin-ok' });
  check('run_command executes and captures stdout', st.data?.result?.includes('builtin-ok') && st.data?.result?.includes('exit: 0'), st.data?.result);
  const esc = await callTool(files, 'read_file', { path: path.join(os.tmpdir(), '..', 'etc', 'passwd') });
  check('restricted mode blocks paths outside the chat folder', /Access denied/.test(esc.data?.result || ''), JSON.stringify(esc.data));
  const escCmd = await callTool(shell, 'run_command', { command: 'cd', cwd: process.env.SystemRoot || 'C:\\Windows' });
  check('restricted mode blocks a foreign working directory', /Access denied/.test(escCmd.data?.result || ''), JSON.stringify(escCmd.data));

  console.log('\nApproval mode: ask');
  let asked = null;
  const allowRun = await chatTurn(`call shell__run_command with ${JSON.stringify({ command: 'echo approved-run' }).replace(/"/g, '"')}`, async (req) => {
    asked = req;
    return 'once';
  });
  check('approval was requested', !!find(allowRun.events, 'approval_request'), JSON.stringify(all(allowRun.events, 'approval_request')));
  check('approval describes the command', asked?.detail === 'echo approved-run', JSON.stringify(asked));
  check('approval names the tool', asked?.name === 'shell__run_command', asked?.name);
  check('approved command ran', toolResults(allowRun.events).includes('approved-run'), toolResults(allowRun.events).slice(0, 300));

  const denyRun = await chatTurn('call shell__run_command with {"command":"echo should-not-run"}', async () => 'deny');
  check('denial emits tool_denied', !!find(denyRun.events, 'tool_denied'));
  check('denied command never ran', !toolResults(denyRun.events).includes('should-not-run'), toolResults(denyRun.events).slice(0, 300));
  check('model is told the user declined', /declined/i.test(toolResults(denyRun.events)), toolResults(denyRun.events).slice(0, 300));

  const roRun = await chatTurn('call files__read_file with {"path":"notes.txt"}', async () => {
    throw new Error('read-only tool should not ask for approval');
  });
  check('read-only tool runs without approval', !find(roRun.events, 'approval_request') && toolResults(roRun.events).includes('bravo'), toolResults(roRun.events).slice(0, 200));

  console.log('\nRemembered allowances');
  await api('/approvals/grants/clear', { method: 'POST' });
  const alwaysRun = await chatTurn('call shell__run_command with {"command":"echo first-ask"}', async () => 'always');
  check('first call still asks', !!find(alwaysRun.events, 'approval_request'));
  const secondRun = await chatTurn('call shell__run_command with {"command":"echo second-no-ask"}', async () => 'deny');
  check('after "always allow" no prompt appears', !find(secondRun.events, 'approval_request'), JSON.stringify(all(secondRun.events, 'approval_request')));
  check('second call ran automatically', toolResults(secondRun.events).includes('second-no-ask'));
  await api('/approvals/grants/clear', { method: 'POST' });

  console.log('\nApproval mode: auto (this chat only)');
  const autoRun = await chatTurn('call shell__run_command with {"command":"echo auto-mode"}', async () => 'deny', { approval_mode: 'auto' });
  check('auto mode never asks', !find(autoRun.events, 'approval_request'));
  check('auto mode runs the command', toolResults(autoRun.events).includes('auto-mode'), toolResults(autoRun.events).slice(0, 200));
  const otherChat = await chatTurn('call shell__run_command with {"command":"echo other-chat"}', async () => 'deny');
  check('another chat still asks for approval', !!find(otherChat.events, 'approval_request'), JSON.stringify(all(otherChat.events, 'approval_request')));

  console.log('\nAccess scope per chat');
  const outsideFile = path.join(tmp, 'outside.txt');
  fs.writeFileSync(outsideFile, 'outside-content\n');
  const relOutside = path.relative(workDir, outsideFile);
  const restrictedRead = await chatTurn(`call files__read_file with ${JSON.stringify({ path: relOutside })}`, () => {
    throw new Error('read-only tool should not ask for approval');
  });
  check('restricted chat cannot leave its folder', /Access denied/.test(toolResults(restrictedRead.events)), toolResults(restrictedRead.events).slice(0, 200));
  const fullRead = await chatTurn(`call files__read_file with ${JSON.stringify({ path: relOutside })}`, () => {
    throw new Error('read-only tool should not ask for approval');
  }, { file_access: 'full' });
  check('full-access chat can read outside its folder', toolResults(fullRead.events).includes('outside-content'), toolResults(fullRead.events).slice(0, 200));
  const winIni = await callTool(files, 'file_info', { path: process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '/etc' }, { file_access: 'full' });
  check('full access reaches outside the chat folder', /type:\s+directory/.test(winIni.data?.result || ''), JSON.stringify(winIni.data));

  console.log('\nTool sets per chat');
  const noShell = await chatTurn('call shell__run_command with {"command":"echo hidden"}', async () => 'deny', { shell_enabled: false });
  check('shell tools are hidden when switched off for the chat', find(noShell.events, 'tool_unavailable')?.name === 'shell__run_command', JSON.stringify(all(noShell.events, 'tool_unavailable')));
  check('the switched-off command never ran', !toolResults(noShell.events).includes('hidden'), toolResults(noShell.events).slice(0, 200));
  const noFiles = await chatTurn('call files__read_file with {"path":"notes.txt"}', async () => 'deny', { files_enabled: false });
  check('file tools are hidden when switched off for the chat', find(noFiles.events, 'tool_unavailable')?.name === 'files__read_file', JSON.stringify(all(noFiles.events, 'tool_unavailable')));

  console.log('\nFile tools round-trip through the model');
  const writeRun = await chatTurn(`call files__write_file with ${JSON.stringify({ path: 'generated/report.md', content: '# written by test\n' })}`, async () => 'once');
  check('write_file was approved and ran', /Wrote \d+ B/.test(toolResults(writeRun.events)), toolResults(writeRun.events).slice(0, 200));
  check('file really exists on disk', fs.existsSync(path.join(workDir, 'generated', 'report.md')));
  const rmRun = await chatTurn('call files__delete_path with {"path":"generated","recursive":true}', async () => 'once');
  check('delete_path removed it', !fs.existsSync(path.join(workDir, 'generated')), toolResults(rmRun.events).slice(0, 200));

  console.log('\nBackground jobs');
  const bg = await callTool(shell, 'start_command', { command: process.platform === 'win32' ? 'ping -n 4 127.0.0.1' : 'sleep 2' });
  const jobId = /job ([0-9a-f]{8})/.exec(bg.data?.result || '')?.[1];
  check('start_command returns a job id', !!jobId, bg.data?.result);
  await new Promise((r) => setTimeout(r, 1200));
  const jobs = await callTool(shell, 'list_jobs');
  check('list_jobs shows the job', jobs.data?.result?.includes(jobId), jobs.data?.result);
  const killed = await callTool(shell, 'kill_process', { job_id: jobId });
  check('kill_process stops it', /Stopped job|had already exited/.test(killed.data?.result || ''), killed.data?.result);

  console.log('\nPer-server approval policy (external servers)');
  const demo = (await api('/mcp', {
    method: 'POST',
    body: { name: 'demo', transport: 'stdio', command: process.execPath, args: [path.join(ROOT, 'test', 'mock-mcp-server.js')], approval: 'always' }
  })).data;
  check('external server registered with approval=always', demo?.approval === 'always', JSON.stringify(demo?.connect));
  const askExt = await chatTurn('what is the weather in Berlin', async () => 'once');
  check('approval=always prompts for an external tool', find(askExt.events, 'approval_request')?.name === 'demo__get_weather', JSON.stringify(all(askExt.events, 'approval_request')));
  check('approved external tool ran', /Berlin/.test(toolResults(askExt.events)), toolResults(askExt.events).slice(0, 200));

  await api(`/mcp/${demo.id}`, { method: 'PUT', body: { approval: 'never', enabled: true } });
  const quietExt = await chatTurn('what is the weather in Paris', async () => 'deny');
  check('approval=never never prompts', !find(quietExt.events, 'approval_request'));
  check('external tool ran without a prompt', /Paris|Berlin/.test(toolResults(quietExt.events)), toolResults(quietExt.events).slice(0, 200));

  await api(`/mcp/${shell.id}`, { method: 'PUT', body: { approval: 'never', enabled: true } });
  const quietBuiltin = await chatTurn('call shell__run_command with {"command":"echo policy-override"}', async () => 'deny');
  check('a built-in server can be set to never ask', !find(quietBuiltin.events, 'approval_request') && toolResults(quietBuiltin.events).includes('policy-override'), toolResults(quietBuiltin.events).slice(0, 200));
  await api(`/mcp/${shell.id}`, { method: 'PUT', body: { approval: 'auto', enabled: true } });
  await api(`/mcp/${demo.id}`, { method: 'DELETE' });

  console.log('\nPer-chat policy defaults and validation');
  // Point the auto-created per-chat folder parent at the temp dir for this test.
  await api('/settings', { method: 'PUT', body: { aitemp_root: path.join(tmp, 'aitemp') } });
  const fresh = (await api('/conversations', { method: 'POST', body: { title: 'defaults' } })).data;
  const expectedDir = path.join(tmp, 'aitemp', String(fresh?.id));
  check(
    'a new chat starts in its own auto-created aitemp folder, ask + restricted, both sets on',
    fresh?.workdir === expectedDir &&
      fresh?.approval_mode === 'ask' &&
      fresh?.file_access === 'restricted' &&
      fresh?.shell_access === 'restricted' &&
      fresh?.files_enabled === 1 &&
      fresh?.shell_enabled === 1,
    JSON.stringify(fresh)
  );
  const badMode = await api(`/conversations/${fresh.id}`, { method: 'PATCH', body: { approval_mode: 'yolo' } });
  check('rejects an unknown approval mode', badMode.status === 400, JSON.stringify(badMode.data));
  const badAccess = await api(`/conversations/${fresh.id}`, { method: 'PATCH', body: { file_access: 'kinda' } });
  check('rejects an unknown access mode', badAccess.status === 400, JSON.stringify(badAccess.data));
  const badDir = await api(`/conversations/${fresh.id}`, { method: 'PATCH', body: { workdir: 'Z:\\definitely-not-here' } });
  check('rejects a missing working folder', badDir.status === 400, JSON.stringify(badDir.data));
  const goodDir = await api(`/conversations/${fresh.id}`, { method: 'PATCH', body: { workdir: workDir, shell_access: 'full' } });
  check('accepts a real working folder', goodDir.data?.workdir === workDir && goodDir.data?.shell_access === 'full', JSON.stringify(goodDir.data));
  const untouched = await api(`/conversations/${fresh.id}`);
  check('changing an option does not bump the chat activity time', untouched.data?.updated_at === fresh.updated_at, `${fresh.updated_at} -> ${untouched.data?.updated_at}`);
  await api(`/conversations/${fresh.id}`, { method: 'DELETE' });

  const badTimeout = await api('/settings', { method: 'PUT', body: { builtin_shell_timeout: '99999' } });
  check('rejects an absurd timeout', badTimeout.status === 400);
  const policy = (await api('/settings/tool-policy')).data;
  check(
    'tool-policy endpoint reports the defaults for a new chat',
    policy?.approval_mode === 'ask' && policy?.file_access === 'restricted' && policy?.default_workdir === path.join(tmp, 'aitemp'),
    JSON.stringify(policy)
  );

  console.log(`\n${failed ? '\u2717' : '\u2713'} ${passed} passed, ${failed} failed\n`);
}

main()
  .catch((e) => {
    failed++;
    console.error('\nFATAL:', e);
  })
  .finally(async () => {
    for (const c of children) c.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 800));
    // Windows keeps SQLite WAL files locked briefly after the child dies.
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    process.exit(failed ? 1 : 0);
  });
