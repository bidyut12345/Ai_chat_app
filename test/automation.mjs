/**
 * End-to-end checks for the built-in automation MCP servers: `windows`,
 * `chrome` and `edge`. Run with: node test/automation.mjs
 *
 * Starts its own app server on scratch ports with a throwaway database, so it
 * never touches your real data. The browser checks are skipped when a browser
 * is not installed; the Windows checks that need an interactive desktop (typing,
 * focusing) are skipped when nothing has the focus, e.g. on a locked screen.
 *
 * Nothing here touches your own browser profile or your own documents: the
 * browsers run headless with a private profile, and the desktop checks only
 * read (window list, clipboard, screenshots) or open and close our own window.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_PORT = 4331;
const MOCK_PORT = 4332;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const IS_WINDOWS = process.platform === 'win32';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-check-'));
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
  child.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`[${name}:e] ${d}`));
  children.push(child);
  return child;
}

let passed = 0;
let failed = 0;
let skipped = 0;
function check(label, ok, extra = '') {
  if (ok) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.log(`  \u2717 ${label}${extra ? `\n      ${String(extra).split('\n').join('\n      ')}` : ''}`);
  }
}
function skip(label, why) {
  skipped++;
  console.log(`  - ${label} (skipped: ${why})`);
}

async function waitFor(fn, ms = 20000) {
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

/** Call one built-in tool directly, scoped to the test workspace. */
const callTool = (server, tool, args = {}, policy = {}) =>
  api(`/mcp/${server.id}/call`, {
    method: 'POST',
    body: {
      tool,
      arguments: args,
      policy: { workdir: workDir, file_access: 'restricted', shell_access: 'restricted', approval_mode: 'auto', ...policy }
    }
  });

/** The text of a tool result, or the error the app reported. */
const textOf = (res) => (res.ok ? res.data.result ?? '' : `[${res.status}] ${res.data.error ?? ''}`);

async function main() {
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

  console.log('\nBuilt-in automation servers are registered');
  for (const [name, count] of [
    ['windows', 11],
    ['chrome', 11],
    ['edge', 11]
  ]) {
    const entry = byName[name];
    check(`${name} is listed with ${count} tools`, !!entry && entry.builtin && entry.tools?.length === count, JSON.stringify(entry?.tools?.length ?? entry));
  }
  check(
    'the automation tools are namespaced like any other server',
    ['windows__list_windows', 'chrome__navigate', 'edge__page_text'].every((t) =>
      servers.some((s) => (s.tools || []).some((tool) => `${s.name}__${tool.name}` === t))
    )
  );
  const readOnly = byName.windows?.tools?.find((t) => t.name === 'list_windows');
  check('read-only tools are annotated (no approval prompt in ask mode)', readOnly?.annotations?.readOnlyHint === true, JSON.stringify(readOnly));
  const destructive = byName.windows?.tools?.find((t) => t.name === 'type_text');
  check('state-changing tools are annotated destructive', destructive?.annotations?.destructiveHint === true, JSON.stringify(destructive));

  console.log('\nPer-chat switches cover the new servers');
  const conv = await api('/conversations', { method: 'POST', body: { title: 'automation test', workdir: workDir } });
  const convId = conv.data.id;
  let patched = await api(`/conversations/${convId}`, { method: 'PATCH', body: { mcp_disabled: ['chrome', 'edge'] } });
  check('a chat can switch chrome and edge off', patched.ok, JSON.stringify(patched.data));
  let fetched = await api(`/conversations/${convId}`);
  // Stored as JSON text on the row, like the other list-valued chat columns.
  const stored = typeof fetched.data.mcp_disabled === 'string' ? JSON.parse(fetched.data.mcp_disabled) : fetched.data.mcp_disabled;
  check('the switches are stored', JSON.stringify(stored) === JSON.stringify(['chrome', 'edge']), JSON.stringify(fetched.data.mcp_disabled));
  patched = await api(`/conversations/${convId}`, { method: 'PATCH', body: { mcp_disabled: ['not-a-server'] } });
  check('an unknown server name is rejected', patched.status === 400, JSON.stringify(patched.data));
  patched = await api(`/conversations/${convId}`, { method: 'PATCH', body: { mcp_disabled: null } });
  check('the switches can be cleared', patched.ok, JSON.stringify(patched.data));

  // A chat that switched a server off must not advertise its tools upstream.
  await api(`/conversations/${convId}`, { method: 'PATCH', body: { mcp_disabled: ['chrome', 'edge', 'windows'] } });
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content: 'hello there', use_tools: true })
  });
  await waitFor(async () => {
    const r = await fetch(`${MOCK}/v1/__last-chat-request`);
    const body = await r.json();
    return Array.isArray(body.tools);
  });
  const lastRequest = await (await fetch(`${MOCK}/v1/__last-chat-request`)).json();
  const offered = (lastRequest.tools || []).map((t) => t.function?.name || t.name || '');
  check(
    'a switched-off server offers no tools to the model',
    !offered.some((n) => n.startsWith('chrome__') || n.startsWith('edge__') || n.startsWith('windows__')),
    offered.filter((n) => /^(chrome|edge|windows)__/.test(n)).join(', ')
  );
  check('the other built-ins are still offered', offered.some((n) => n.startsWith('files__')), offered.join(', '));

  if (IS_WINDOWS) {
    console.log('\nWindows desktop automation');
    const windows = byName.windows;

    const info = await callTool(windows, 'system_info');
    check('system_info describes the machine', /Computer:/.test(textOf(info)) && /Screens \(\d+\)/.test(textOf(info)), textOf(info));

    const list = await callTool(windows, 'list_windows');
    check('list_windows answers', /window\(s\):|No visible windows/.test(textOf(list)), textOf(list));

    const setClip = await callTool(windows, 'clipboard_set', { text: 'rirsigpt automation check' });
    check('clipboard_set', /Clipboard set to 25 character/.test(textOf(setClip)), textOf(setClip));
    const getClip = await callTool(windows, 'clipboard_get');
    check('clipboard_get round-trips', textOf(getClip).includes('rirsigpt automation check'), textOf(getClip));

    const shot = await callTool(windows, 'screenshot', { path: 'screen.png' });
    const shotText = textOf(shot);
    if (/desktop is locked|screen is off/.test(shotText)) {
      skip('screenshot of the screen', 'the desktop is locked');
    } else {
      const shotPath = path.join(workDir, 'screen.png');
      check('screenshot of the screen writes a PNG', /Saved \d+x\d+ PNG/.test(shotText) && fs.existsSync(shotPath), shotText);
      check('the PNG is a real image', fs.existsSync(shotPath) && fs.statSync(shotPath).size > 1000);
    }

    const stale = await callTool(windows, 'type_text', { handle: 123456789, text: 'must not be typed' });
    check('a stale window handle is refused, not typed into another window', /No window with handle/.test(textOf(stale)), textOf(stale));

    const noTarget = await callTool(windows, 'window_action', { action: 'minimize' });
    check('window_action without a target is rejected', /Give a window handle or a title/.test(textOf(noTarget)), textOf(noTarget));

    const badAction = await callTool(windows, 'window_action', { action: 'explode', handle: 1 });
    check('an unknown action is rejected', /action must be one of/.test(textOf(badAction)), textOf(badAction));

    // Typing needs a real foreground window. On a locked screen nothing can be
    // focused, and the tools must refuse rather than type into the void.
    const probe = await callTool(windows, 'focus_window', { title: 'no such window 12345' });
    check('an unknown window title is rejected', /No window matching/.test(textOf(probe)), textOf(probe));

    const mine = await callTool(windows, 'launch_app', { target: 'notepad.exe' });
    const launched = /handle (\d+)/.exec(textOf(mine));
    const closed = launched
      ? await callTool(windows, 'window_action', { handle: Number(launched[1]), action: 'close' })
      : null;
    check('launch_app starts a program', /Started notepad|Started Notepad|Opened notepad/.test(textOf(mine)), textOf(mine));
    if (launched) check('the launched window can be closed again', /close ->/.test(textOf(closed)), textOf(closed));
    else skip('closing the launched window', 'no window handle was reported');
  } else {
    skip('Windows desktop automation', 'not running on Windows');
  }

  for (const kind of ['chrome', 'edge']) {
    const server = byName[kind];
    const label = kind === 'chrome' ? 'Chrome' : 'Edge';
    console.log(`\n${label} automation (headless, private profile)`);

    const opened = await callTool(server, 'open', {
      headless: true,
      url: 'data:text/html,<title>Automation</title><h1>Hello</h1><button id="b">Press</button><input id="i"><p id="out"></p><script>b.onclick=()=>{out.textContent="clicked"}</script>'
    });
    const openedText = textOf(opened);
    if (/is not installed/.test(openedText)) {
      skip(`${label} automation`, 'browser not installed');
      continue;
    }
    check(`${label} starts and opens a page`, /started|already running/.test(openedText), openedText);

    const pages = await callTool(server, 'list_pages');
    check(`${label} list_pages`, /tab\(s\):/.test(textOf(pages)), textOf(pages));

    const text = await callTool(server, 'page_text');
    check(`${label} page_text`, /Hello/.test(textOf(text)), textOf(text));

    const clicked = await callTool(server, 'click', { selector: '#b' });
    check(`${label} click`, /Clicked <button>/.test(textOf(clicked)), textOf(clicked));
    const afterClick = await callTool(server, 'evaluate_js', { expression: 'document.querySelector("#out").textContent' });
    check(`${label} click changed the page`, /clicked/.test(textOf(afterClick)), textOf(afterClick));

    const filled = await callTool(server, 'fill', { selector: '#i', text: 'typed text' });
    check(`${label} fill`, /Filled <input>/.test(textOf(filled)), textOf(filled));
    const value = await callTool(server, 'evaluate_js', { expression: 'document.querySelector("#i").value' });
    check(`${label} evaluate_js`, /typed text/.test(textOf(value)), textOf(value));

    const pressed = await callTool(server, 'press_key', { key: 'Enter' });
    check(`${label} press_key`, /Pressed Enter/.test(textOf(pressed)), textOf(pressed));

    const waited = await callTool(server, 'wait_for_selector', { selector: '#b' });
    check(`${label} wait_for_selector`, /is on the page/.test(textOf(waited)), textOf(waited));
    const timeout = await callTool(server, 'wait_for_selector', { selector: '#nope', timeout_seconds: 1 });
    check(`${label} wait_for_selector times out`, /did not appear/.test(textOf(timeout)), textOf(timeout));

    const shot = await callTool(server, 'screenshot', { path: `${kind}.png` });
    check(`${label} screenshot writes a PNG`, /Saved .*screenshot/.test(textOf(shot)) && fs.existsSync(path.join(workDir, `${kind}.png`)), textOf(shot));

    const navigated = await callTool(server, 'navigate', {
      url: 'data:text/html,<title>Second</title><h1>Second page</h1>',
      wait_seconds: 5
    });
    check(`${label} navigate`, /Second page/.test(textOf(navigated)), textOf(navigated));
    const afterNav = await callTool(server, 'page_text');
    check(`${label} page_text after navigate`, /Second page/.test(textOf(afterNav)), textOf(afterNav));

    const closedPage = await callTool(server, 'close_page');
    check(`${label} close_page`, /Closed tab/.test(textOf(closedPage)), textOf(closedPage));
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`\n${e.stack || e.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
