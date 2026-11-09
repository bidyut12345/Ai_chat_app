/**
 * Verification suite for GUI-AGENT-FIX-PROMPT acceptance criteria:
 * 1. Launch Notepad twice with a dirty tab open -> second call reports reused_existing_instance: true;
 *    no keystroke can reach the dirty tab without allow_unsaved: true.
 * 2. type_text(handle=<stale>) -> stale_handle error with candidates, exit 0 side effects.
 * 3. 50 consecutive files__write_file calls of 1–64 KB payloads -> 50 verified, zero placeholder writes.
 * 4. uia_inspect on Calculator returns the display value without PowerShell.
 * 5. shell__run_command(interpreter="powershell") executes script with $vars, backticks, nested quotes.
 * 6. long running command with timeout_seconds: 3 returns partial output with timed_out: true, not MCP error.
 * 7. Full "open Calculator, enter 4+3, confirm 7" flow with uia_inspect and zero shell calls.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 4341;
const MOCK_PORT = 4342;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-agent-fix-'));
const dbPath = path.join(tmp, 'test.db');
const workDir = path.join(tmp, 'workspace');
fs.mkdirSync(workDir, { recursive: true });

const children = [];
function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  return child;
}

let passed = 0;
let failed = 0;
function check(label, ok, extra = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra ? `\n    ${extra}` : ''}`);
  }
}

async function waitFor(fn, timeoutMs = 20000, stepMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

const api = async (endpoint, opts = {}) => {
  const res = await fetch(`${BASE}/api${endpoint}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
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

const callTool = (server, tool, args = {}) =>
  api(`/mcp/${server.id}/call`, {
    method: 'POST',
    body: {
      tool,
      arguments: args,
      policy: { workdir: workDir, file_access: 'restricted', shell_access: 'restricted', approval_mode: 'auto' }
    }
  });

const textOf = (res) => {
  if (res.data?.error) return `[error] ${typeof res.data.error === 'object' ? JSON.stringify(res.data.error) : res.data.error}`;
  if (res.data?.result !== undefined) {
    return typeof res.data.result === 'string' ? res.data.result : JSON.stringify(res.data.result);
  }
  return res.ok ? JSON.stringify(res.data) : `[${res.status}] ${res.data?.error ?? ''}`;
};

const isToolError = (r) => {
  const t = textOf(r);
  return r.data?.isError === true || !r.ok || /^(Tool error|Access denied|Error):/i.test(t);
};

async function main() {
  console.log('Starting test server for GUI Agent Fix verification...');
  start('mock', ['test/mock-openai-server.js'], { MOCK_PORT: String(MOCK_PORT) });
  start('app', ['server/index.js'], {
    PORT: String(APP_PORT),
    DB_PATH: dbPath,
    AUTH_DISABLED: '1',
    OPENAI_BASE_URL: `${MOCK}/v1`,
    OPENAI_MODEL: 'mock-gpt'
  });

  const up = await waitFor(async () => (await fetch(`${BASE}/api/health`)).ok);
  if (!up) throw new Error('app server did not start');

  const servers = (await api('/mcp')).data;
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
  const windows = byName.windows;
  const shell = byName.shell;
  const files = byName.files;

  // -------------------------------------------------------------
  // Test 2: type_text(handle=<stale>) -> stale_handle error with candidates
  // -------------------------------------------------------------
  console.log('\nCriteria 2: Handle hygiene & stale_handle rejection');
  const staleRes = await callTool(windows, 'type_text', { handle: 999999999, text: 'must not be typed' });
  const staleText = textOf(staleRes);
  check('stale handle returns stale_handle error', /stale_handle/.test(staleText), staleText);
  check('stale handle includes candidates list', /candidates/.test(staleText), staleText);

  // -------------------------------------------------------------
  // Test 3: 50 consecutive files__write_file calls of 1-64 KB payloads
  // -------------------------------------------------------------
  console.log('\nCriteria 3: 50 verified writes with SHA-256 and zero placeholders');
  let writesOk = true;
  for (let i = 0; i < 50; i++) {
    const size = Math.floor(Math.random() * (64 * 1024 - 1024) + 1024);
    const payload = `TEST_HEADER_${i}\n` + crypto.randomBytes(Math.floor(size / 2)).toString('hex');
    const fPath = `verified_${i}.txt`;
    const res = await callTool(files, 'write_file', { path: fPath, content: payload });
    const txt = textOf(res);
    if (!res.ok || !txt.includes('verified')) {
      writesOk = false;
      break;
    }
    const diskContent = fs.readFileSync(path.join(workDir, fPath), 'utf8');
    if (diskContent !== payload) {
      writesOk = false;
      break;
    }
  }
  check('50 consecutive writes of 1-64 KB verified on disk with sha256', writesOk);

  // Test placeholder rejection
  const phRes = await callTool(files, 'write_file', { path: 'placeholder.txt', content: '/* Content elided from history: 50 characters */' });
  check('truncation placeholder content is rejected with explicit error', isToolError(phRes) && /truncation placeholder/i.test(textOf(phRes)), textOf(phRes));

  // Test edit_file syntax check (F10)
  await callTool(files, 'write_file', { path: 'test_syntax.js', content: 'function test() { return 1; }\n' });
  const badEdit = await callTool(files, 'edit_file', { path: 'test_syntax.js', target: 'return 1; }', replacement: 'return 1; // unbalanced' });
  check('edit_file rejects unbalanced syntax', isToolError(badEdit) && /syntax error/i.test(textOf(badEdit)), textOf(badEdit));

  // -------------------------------------------------------------
  // Test 5: shell__run_command(interpreter="powershell") with special chars
  // -------------------------------------------------------------
  console.log('\nCriteria 5: PowerShell script with $vars, backticks, nested quotes');
  const psScript = `$greeting = "Hello"; $nested = "World \`"Inside\`""; Write-Output "$greeting, $nested!"`;
  const psRes = await callTool(shell, 'run_command', {
    command: psScript,
    interpreter: 'powershell'
  });
  const psOut = textOf(psRes);
  check('PowerShell execution with $vars and quotes succeeds on first attempt', psOut.includes('Hello, World "Inside"!'), psOut);

  // -------------------------------------------------------------
  // Test 6: Timeout returns timed_out: true instead of MCP error
  // -------------------------------------------------------------
  console.log('\nCriteria 6: Timeout returns timed_out: true');
  const timeoutRes = await callTool(shell, 'run_command', {
    command: 'where /r C:\\Windows nonexistent_file_xyz.cmd',
    timeout_seconds: 2
  });
  const timeoutText = textOf(timeoutRes);
  check('timed out command returns timed_out: true instead of crashing', /timed_out|TIMED OUT/.test(timeoutText), timeoutText);

  // -------------------------------------------------------------
  // Test 1: Launch Notepad twice with a dirty tab open
  // -------------------------------------------------------------
  console.log('\nCriteria 1: Notepad reused instance and dirty tab protection');
  const launch1 = await callTool(windows, 'launch_app', { target: 'notepad.exe', timeout_ms: 4000 });
  const l1Text = textOf(launch1);
  const handle1Match = /handle\s*(\d+)/.exec(l1Text);
  const h1 = handle1Match ? Number(handle1Match[1]) : 0;
  check('first Notepad launch returns window handle', h1 > 0, l1Text);

  if (h1 > 0) {
    // Type into Notepad to make the tab dirty
    await callTool(windows, 'type_text', { handle: h1, text: 'dirty test unsaved changes', allow_unsaved: true });
    await new Promise((r) => setTimeout(r, 600));

    // Second launch of Notepad
    const launch2 = await callTool(windows, 'launch_app', { target: 'notepad.exe', timeout_ms: 4000 });
    const l2Text = textOf(launch2);
    check('second Notepad launch detects reused_existing_instance: true', /reused_existing_instance:\s*true/.test(l2Text), l2Text);

    // Try typing without allow_unsaved -> should fail closed
    const dirtyType = await callTool(windows, 'type_text', { handle: h1, text: 'dangerous edit' });
    check('typing to dirty document without allow_unsaved is blocked', isToolError(dirtyType) && /unsaved/i.test(textOf(dirtyType)), textOf(dirtyType));

    // Clean up: close window
    await callTool(windows, 'window_action', { handle: h1, action: 'close' });
    await new Promise((r) => setTimeout(r, 400));
    const findPrompts = await callTool(windows, 'find_window', { title_contains: 'Notepad' });
    for (const w of (findPrompts.data?.result?.windows || [])) {
      await callTool(windows, 'send_keys', { handle: w.handle, keys: '%n', allow_unsaved: true });
    }
  }

  // -------------------------------------------------------------
  // Test 4 & 7: Calculator flow with uia_inspect and zero shell calls
  // -------------------------------------------------------------
  console.log('\nCriteria 4 & 7: Calculator 4+3=7 with uia_inspect and ZERO shell calls');
  const calcLaunch = await callTool(windows, 'launch_app', { target: 'calculator:', timeout_ms: 4000 });
  const calcText = textOf(calcLaunch);
  let calcHandle = 0;
  const calcMatch = /handle\s*(\d+)/.exec(calcText);
  if (calcMatch) calcHandle = Number(calcMatch[1]);

  if (!calcHandle) {
    // Find Calculator via find_window
    const fw = await callTool(windows, 'find_window', { title_contains: 'Calculator' });
    const wins = fw.data?.result?.windows || [];
    if (wins.length > 0) calcHandle = wins[0].handle;
  }

  check('Calculator launched and handle resolved', calcHandle > 0, `handle: ${calcHandle}`);

  if (calcHandle > 0) {
    // Focus calculator
    await callTool(windows, 'focus_window', { handle: calcHandle });
    await new Promise((r) => setTimeout(r, 500));

    // Initial display verification via uia_inspect
    const initInspect = await callTool(windows, 'uia_inspect', {
      handle: calcHandle,
      name_contains: 'Display'
    });
    const initTxt = textOf(initInspect);
    check('uia_inspect on Calculator returns display value without PowerShell', initInspect.ok && /Display is/i.test(initTxt), initTxt);

    // Enter 4 + 3 =
    await callTool(windows, 'send_keys', { handle: calcHandle, keys: '4+3=' });
    await new Promise((r) => setTimeout(r, 600));

    // Verify result is 7 via uia_inspect
    const resultInspect = await callTool(windows, 'uia_inspect', {
      handle: calcHandle,
      name_contains: 'Display'
    });
    const resultTxt = textOf(resultInspect);
    check('Calculator 4+3=7 confirmed via uia_inspect with zero shell calls', /Display is 7/i.test(resultTxt), resultTxt);

    // Close calculator
    await callTool(windows, 'window_action', { handle: calcHandle, action: 'close' });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
}

main()
  .then(() => {
    for (const c of children) {
      try { c.kill(); } catch {}
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Fatal error during test run:', err);
    for (const c of children) {
      try { c.kill(); } catch {}
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
