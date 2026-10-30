/**
 * Minimal Chrome DevTools Protocol driver used by the built-in `chrome` and
 * `edge` automation servers.
 *
 * The browser is started with `--remote-debugging-port` and a private profile
 * directory, so the tools never touch the profile you browse with (and Chrome
 * refuses remote debugging on a profile that is already in use anyway). Both
 * browsers speak the same protocol, so one driver serves both.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyError } from './policy.js';

const IS_WINDOWS = process.platform === 'win32';

const BROWSERS = {
  chrome: {
    label: 'Google Chrome',
    envPath: 'RISPRIGPT_CHROME_PATH',
    defaultPort: 9222,
    exe: 'chrome.exe',
    candidates: {
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
      ],
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    }
  },
  edge: {
    label: 'Microsoft Edge',
    envPath: 'RISPRIGPT_EDGE_PATH',
    defaultPort: 9223,
    exe: 'msedge.exe',
    candidates: {
      win32: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe')
      ],
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
    }
  }
};

/** kind -> { port, child, profile, headless, reused } */
const running = new Map();

export function browserLabel(kind) {
  return BROWSERS[kind]?.label || kind;
}

export function browserPort(kind) {
  return BROWSERS[kind]?.defaultPort || 9222;
}

/** Locate the browser executable, or null when it is not installed. */
export function findBrowserExe(kind) {
  const def = BROWSERS[kind];
  if (!def) return null;
  const override = process.env[def.envPath];
  if (override && fs.existsSync(override)) return override;
  const list = def.candidates[process.platform] || [];
  for (const p of list) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** Private profile directory for the automation browser of this kind/port. */
function profileDir(kind, port) {
  const base =
    IS_WINDOWS && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'RiSriGPT', 'browser')
      : path.join(os.homedir(), '.local', 'share', 'rirsigpt', 'browser');
  return path.join(base, `${kind}-${port}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(port, route, { method = 'GET', timeout = 1500 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`${route} -> ${res.status}`);
  return res.json();
}

/** DevTools version info, or null when nothing is listening on that port. */
export async function devtoolsVersion(port) {
  try {
    return await getJson(port, '/json/version', { timeout: 1200 });
  } catch {
    return null;
  }
}

/** All targets (tabs, workers, pages) of a running browser. */
export async function listTargets(port) {
  try {
    const list = await getJson(port, '/json/list', { timeout: 3000 });
    return Array.isArray(list) ? list : [];
  } catch {
    throw new PolicyError(
      `Cannot reach the browser on port ${port}. Start it with the "open" tool first.`
    );
  }
}

/** Open a new tab and return its target record. */
export async function newTab(port, url = 'about:blank') {
  // Chrome >= 111 wants PUT; older builds answer GET.
  let res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5000)
  }).catch(() => null);
  if (!res || !res.ok) {
    res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);
  }
  if (!res || !res.ok) throw new PolicyError(`Could not open a new tab (${res ? res.status : 'no response'}).`);
  return await res.json();
}

/** Close one tab by target id. */
export async function closeTab(port, targetId) {
  const res = await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(5000)
  }).catch(() => null);
  if (!res || !res.ok) throw new PolicyError(`Could not close tab ${targetId}.`);
  return true;
}

/**
 * Start the browser (once) with a debugging port and a private profile, and
 * wait until the DevTools endpoint answers. Reuses a browser that is already
 * listening on the port.
 */
export async function ensureBrowser(kind, { port, headless = false } = {}) {
  const def = BROWSERS[kind];
  if (!def) throw new PolicyError(`Unknown browser "${kind}".`);
  const usePort = Number(port) || def.defaultPort;

  const existing = await devtoolsVersion(usePort);
  if (existing) {
    const cur = running.get(kind);
    if (!cur || cur.port !== usePort) {
      running.set(kind, { port: usePort, child: cur?.port === usePort ? cur.child : null, profile: cur?.profile || '', headless, reused: true });
    }
    return { ...running.get(kind), label: def.label, browser: existing.Browser, reused: true };
  }

  const exe = findBrowserExe(kind);
  if (!exe) {
    throw new PolicyError(
      `${def.label} is not installed (or not in a known location). Set ${def.envPath} to the executable path.`
    );
  }
  const profile = profileDir(kind, usePort);
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${usePort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1360,900',
    '--remote-allow-origins=*'
  ];
  if (headless) args.push('--headless=new');
  args.push('about:blank');

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  child.on('error', () => {});

  const entry = { port: usePort, child, profile, headless, reused: false };
  running.set(kind, entry);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const v = await devtoolsVersion(usePort);
    if (v) return { ...entry, label: def.label, browser: v.Browser, reused: false };
    await sleep(300);
  }
  throw new PolicyError(`${def.label} did not open its debugging port ${usePort} in time.`);
}

/** Stop the automation browsers this process started (shutdown only). */
export function stopBrowsers() {
  for (const [, entry] of running) {
    if (!entry.child || entry.reused) continue;
    try {
      if (IS_WINDOWS) {
        spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        entry.child.kill('SIGTERM');
      }
    } catch {
      /* already gone */
    }
  }
  running.clear();
}

/** One WebSocket connection to a page target. */
class PageSession {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  static async open(wsUrl, timeoutMs = 10000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new PolicyError('Timed out connecting to the page.')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new PolicyError('Could not connect to the page (it may have closed).'));
      });
    });
    return new PageSession(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new PolicyError(`${method} timed out.`));
        }
      }, timeoutMs);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Pick the page target to work on (or open one) and run `fn` against it. */
export async function withPage(port, pageId, fn) {
  const pages = (await listTargets(port)).filter((t) => t.type === 'page');
  let target;
  if (pageId) {
    target = pages.find((t) => t.id === pageId);
    if (!target) {
      const open = pages.map((p) => `${p.id} (${p.url})`).join(', ') || 'none';
      throw new PolicyError(`No page with id ${pageId}. Open pages: ${open}`);
    }
  } else {
    target = pages.find((t) => !/^devtools:/.test(t.url || '')) || pages[0];
    if (!target) target = await newTab(port, 'about:blank');
  }
  const session = await PageSession.open(target.webSocketDebuggerUrl);
  try {
    return await fn(session, target);
  } finally {
    session.close();
  }
}

/** Evaluate an expression in the page and return its value. */
export async function evaluate(session, expression) {
  const res = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new PolicyError(d.exception?.description || d.text || 'The page threw an error.');
  }
  return res.result?.value;
}

/** Wait until the page reports readyState complete (best effort). */
export async function waitForReady(session, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(session, 'document.readyState');
      if (state === 'complete') return true;
    } catch {
      /* navigation in progress */
    }
    await sleep(200);
  }
  return false;
}

/** Fetch the current title/url of a target without attaching. */
export async function pageSummary(port) {
  const pages = (await listTargets(port)).filter((t) => t.type === 'page');
  return pages.map((p) => ({ id: p.id, title: p.title || '', url: p.url || '' }));
}
