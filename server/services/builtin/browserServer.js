/**
 * Built-in MCP servers: `chrome` and `edge` (browser automation).
 *
 * Both browsers expose the same DevTools protocol, so one implementation
 * serves both — the registry in index.js calls `browserTools('chrome')` and
 * `browserTools('edge')`.
 *
 * The browser runs with its own profile and a debugging port; the tools never
 * touch the profile you browse with. Nothing here is a screenshot of pixels:
 * `screenshot` saves a PNG into the chat folder and returns the path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, PolicyError } from './policy.js';
import {
  browserLabel,
  browserPort,
  ensureBrowser,
  listTargets,
  newTab,
  closeTab,
  withPage,
  evaluate,
  waitForReady,
  pageSummary,
  devtoolsVersion
} from './cdp.js';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

const PAGE_ARG = {
  page_id: { type: 'string', description: 'Tab id from list_pages. Defaults to the current tab.' }
};

/** Add a scheme when the model gives a bare host. */
function normalizeUrl(raw) {
  const url = str(raw).trim();
  if (!url) throw new PolicyError('url is required.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^(localhost|127\.|\[::1\])/i.test(url)) return `http://${url}`;
  return `https://${url}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Keys the model can press through Input.dispatchKeyEvent. */
const KEYMAP = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 }
};

/** Make sure the browser is up and return its port. */
async function ensurePort(kind, args = {}) {
  const info = await ensureBrowser(kind, { port: args.port, headless: args.headless === true });
  return info.port;
}

function pageLines(pages, currentId) {
  if (!pages.length) return '  (no tabs)';
  return pages
    .map((p) => `  ${p.id}${p.id === currentId ? ' *' : '  '}  ${p.title || '(untitled)'}\n      ${p.url}`)
    .join('\n');
}

export function browserTools(kind) {
  const label = browserLabel(kind);
  const port = browserPort(kind);

  return [
    {
      name: 'open',
      destructive: true,
      description:
        `Start ${label} with a private automation profile and open a URL in a new tab (or reuse the running instance). ` +
        'The browser stays open between calls; use list_pages to see tabs and close_page to close one.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Page to open. Optional: with no URL the browser just starts.' },
          headless: { type: 'boolean', description: 'Run without a visible window (useful for scraping). Default false.' },
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        }
      },
      async handler(args) {
        const info = await ensureBrowser(kind, { port: args.port, headless: args.headless === true });
        let opened = null;
        const url = str(args.url).trim();
        if (url) opened = await newTab(info.port, normalizeUrl(url));
        const pages = await pageSummary(info.port);
        return [
          `${info.label} ${info.reused ? 'already running' : 'started'} on DevTools port ${info.port}.`,
          info.profile ? `Profile: ${info.profile}` : '',
          opened ? `Opened: ${opened.url || url}` : '',
          `${pages.length} tab(s):`,
          pageLines(pages, opened?.id)
        ]
          .filter(Boolean)
          .join('\n');
      }
    },

    {
      name: 'list_pages',
      readOnly: true,
      description: `List the open ${label} tabs with their ids, titles and URLs. Read-only: it never starts the browser.`,
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const version = await devtoolsVersion(port);
        if (!version) {
          return `${label} is not running for automation. Call open (or navigate) first.`;
        }
        const pages = await pageSummary(port);
        return `${label} on port ${port} — ${pages.length} tab(s):\n${pageLines(pages)}`;
      }
    },

    {
      name: 'navigate',
      destructive: true,
      description: `Go to a URL in the current tab (or a new one) and wait for the page to load. Returns the page title and URL.`,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Address to open.' },
          new_tab: { type: 'boolean', description: 'Open it in a new tab instead of the current one.' },
          wait_seconds: { type: 'number', description: 'How long to wait for the load to finish. Default 15.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        },
        required: ['url']
      },
      async handler(args) {
        const url = normalizeUrl(args.url);
        const p = await ensurePort(kind, args);
        const timeout = Math.min(Math.max(Number(args.wait_seconds) || 15, 1), 120) * 1000;
        if (args.new_tab) {
          const tab = await newTab(p, url);
          const info = await withPage(p, tab.id, async (s) => {
            await waitForReady(s, timeout);
            return evaluate(s, '({ title: document.title, url: location.href })');
          });
          return `Opened a new tab (${tab.id}):\n${info.title}\n${info.url}`;
        }
        const info = await withPage(p, args.page_id, async (s) => {
          const res = await s.send('Page.navigate', { url });
          if (res.errorText) throw new PolicyError(res.errorText);
          await waitForReady(s, timeout);
          return evaluate(s, '({ title: document.title, url: location.href })');
        });
        return `Navigated to:\n${info.title}\n${info.url}`;
      }
    },

    {
      name: 'page_text',
      readOnly: true,
      description: 'Return the visible text of the page (what a reader would see), plus its title and URL.',
      inputSchema: {
        type: 'object',
        properties: {
          max_chars: { type: 'number', description: 'Truncate the text. Default 20000, max 100000.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        }
      },
      async handler(args) {
        const p = await ensurePort(kind, args);
        const max = Math.min(Math.max(Number(args.max_chars) || 20000, 200), 100000);
        const info = await withPage(p, args.page_id, async (s) =>
          evaluate(s, '({ title: document.title, url: location.href, text: document.body ? document.body.innerText : "" })')
        );
        const text = str(info.text).replace(/\n{3,}/g, '\n\n').trim();
        const shown = text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
        return `${info.title}\n${info.url}\n---\n${shown || '(no text)'}`;
      }
    },

    {
      name: 'evaluate_js',
      destructive: true,
      description:
        'Run a JavaScript expression in the page and return its value (objects come back as JSON). The page is the automation tab only.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        },
        required: ['expression']
      },
      async handler(args) {
        const expression = str(args.expression);
        if (!expression.trim()) throw new PolicyError('expression is required.');
        const p = await ensurePort(kind, args);
        const value = await withPage(p, args.page_id, async (s) => evaluate(s, expression));
        let text;
        if (typeof value === 'string') text = value;
        else if (value === undefined) text = 'undefined';
        else text = JSON.stringify(value, null, 2);
        return text.length > 20000 ? `${text.slice(0, 20000)}\n...[truncated]` : text;
      }
    },

    {
      name: 'click',
      destructive: true,
      description:
        'Click an element by CSS selector, or by its visible text when no selector is given. Scrolls it into view first and reports what was clicked.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector, e.g. "#submit" or "a[href*=pricing]".' },
          text: { type: 'string', description: 'Visible text of the element, used when selector is omitted.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        }
      },
      async handler(args) {
        const selector = str(args.selector).trim();
        const text = str(args.text).trim();
        if (!selector && !text) throw new PolicyError('Give a selector or some visible text.');
        const p = await ensurePort(kind, args);
        const res = await withPage(p, args.page_id, async (s) =>
          evaluate(
            s,
            `(() => {
  const sel = ${JSON.stringify(selector)};
  const txt = ${JSON.stringify(text)};
  let el = sel ? document.querySelector(sel) : null;
  if (!el && txt) {
    const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const want = norm(txt);
    const cands = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],label,summary,li,span,div,p,td,th')];
    el = cands.find((n) => norm(n.innerText || n.value) === want) || cands.find((n) => norm(n.innerText || n.value).includes(want));
  }
  if (!el) return { ok: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: String(el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 120) };
})()`
          )
        );
        if (!res || !res.ok) {
          throw new PolicyError(`Nothing matched ${selector ? `selector "${selector}"` : `text "${text}"`} on the page.`);
        }
        return `Clicked <${res.tag}>${res.text ? ` "${res.text}"` : ''}.`;
      }
    },

    {
      name: 'fill',
      destructive: true,
      description:
        'Type into an input, textarea or contenteditable element (replaces its value) and fire the input/change events frameworks listen for.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the field.' },
          text: { type: 'string', description: 'Text to put in the field.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        },
        required: ['selector', 'text']
      },
      async handler(args) {
        const selector = str(args.selector).trim();
        if (!selector) throw new PolicyError('selector is required.');
        const p = await ensurePort(kind, args);
        const res = await withPage(p, args.page_id, async (s) =>
          evaluate(
            s,
            `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const text = ${JSON.stringify(str(args.text))};
  if (el.isContentEditable) {
    el.textContent = text;
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text); else el.value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '').slice(0, 120) };
})()`
          )
        );
        if (!res || !res.ok) throw new PolicyError(`No field matches "${selector}".`);
        return `Filled <${res.tag}> with ${str(args.text).length} character(s): "${res.value}"`;
      }
    },

    {
      name: 'press_key',
      destructive: true,
      description: 'Press one key in the page: Enter, Tab, Escape, Backspace, Delete, Space, the arrow keys, Home/End, PageUp/PageDown, or a single character.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name or single character.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        },
        required: ['key']
      },
      async handler(args) {
        const key = str(args.key).trim();
        if (!key) throw new PolicyError('key is required.');
        const known = KEYMAP[key] || KEYMAP[key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()];
        const spec = known || {
          code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
          text: key.length === 1 ? key : undefined
        };
        const p = await ensurePort(kind, args);
        await withPage(p, args.page_id, async (s) => {
          const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
          await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(spec.text ? { text: spec.text } : {}) });
          await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
          return true;
        });
        return `Pressed ${key}.`;
      }
    },

    {
      name: 'wait_for_selector',
      readOnly: true,
      description: 'Wait until an element matching the CSS selector exists on the page. Returns how long it took, or an error after the timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for.' },
          timeout_seconds: { type: 'number', description: 'Give up after this many seconds. Default 10.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        },
        required: ['selector']
      },
      async handler(args) {
        const selector = str(args.selector).trim();
        if (!selector) throw new PolicyError('selector is required.');
        const timeout = Math.min(Math.max(Number(args.timeout_seconds) || 10, 1), 120) * 1000;
        const p = await ensurePort(kind, args);
        const started = Date.now();
        const found = await withPage(p, args.page_id, async (s) => {
          while (Date.now() - started < timeout) {
            const ok = await evaluate(s, `!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
            if (ok) return true;
            await new Promise((r) => setTimeout(r, 250));
          }
          return false;
        });
        if (!found) throw new PolicyError(`"${selector}" did not appear within ${Math.round(timeout / 1000)}s.`);
        return `"${selector}" is on the page (${Math.round((Date.now() - started) / 100) / 10}s).`;
      }
    },

    {
      name: 'screenshot',
      readOnly: true,
      description: 'Save a PNG of the page (or the whole scrollable page) into the chat folder and return the path. The tool result is text only.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Where to save the PNG, relative to the chat folder.' },
          full_page: { type: 'boolean', description: 'Capture the whole page, not just the viewport.' },
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        }
      },
      async handler(args) {
        const rel = str(args.path).trim() || `screenshot-${stamp()}.png`;
        const abs = resolvePath(rel, { mustExist: false });
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const p = await ensurePort(kind, args);
        const res = await withPage(p, args.page_id, async (s) => {
          const shot = await s.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: args.full_page === true
          });
          const info = await evaluate(s, '({ title: document.title, url: location.href })');
          return { shot, info };
        });
        fs.writeFileSync(abs, Buffer.from(res.shot.data, 'base64'));
        const bytes = fs.statSync(abs).size;
        return `Saved ${args.full_page ? 'full-page ' : ''}screenshot (${bytes} bytes)\n${abs}\n${res.info.title}\n${res.info.url}`;
      }
    },

    {
      name: 'close_page',
      destructive: true,
      description: 'Close a tab. Defaults to the current tab.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PAGE_ARG,
          port: { type: 'number', description: `DevTools port. Default ${port}.` }
        }
      },
      async handler(args) {
        const p = await ensurePort(kind, args);
        let id = args.page_id;
        if (!id) {
          const pages = (await listTargets(p)).filter((t) => t.type === 'page');
          id = pages[0]?.id;
        }
        if (!id) return 'No tab to close.';
        await closeTab(p, id);
        return `Closed tab ${id}.`;
      }
    }
  ];
}
