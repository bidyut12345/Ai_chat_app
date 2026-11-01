// Unsent draft text per conversation so typing in Chat A never bleeds into Chat B.
const chatDrafts = new Map();
/* RiSriGPT — frontend */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  // Buttons created in script default to type="submit", which would submit the
  // surrounding <form> when a list lives inside a dialog form.
  if (tag === 'button') n.type = 'button';
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const state = {
  conversations: [],
  prompts: [],
  models: [],
  settings: {},
  mcp: [],
  currentId: null,
  messages: [],
  fileChanges: [],
  streaming: false,
  abort: null,
  attachments: [],
  pendingNewPrompt: false,
  search: '',
  // Auth state: current signed-in user, whether the first account is needed,
  // and whether the admin has opened self-service registration.
  currentUser: null,
  needsSetup: false,
  openRegistration: false
};

// Interval id for the running-generations poll (started once after login).
let authPollTimer = null;

/* ───────────────────────── API helpers ───────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    // A 401 flagged as `auth` means the session expired / isn't signed in.
    if (res.status === 401 && data?.auth && !opts.__noAuthGate) showLogin();
    throw new Error(data?.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 2600);
}

// Copy text to the clipboard. navigator.clipboard only exists in secure
// contexts (https or localhost), so fall back to a hidden textarea +
// execCommand for LAN access like http://192.168.x.x:3000.
async function copyText(text) {
  const s = String(text || '');
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(s); return true; } catch { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

/* ───────────────────────── Timestamps ───────────────────────── */

/** SQLite writes `datetime('now')` as UTC with no zone marker ("2026-10-28
 *  12:34:56"). Without the added "Z" the Date parser would treat it as local
 *  time and shift it by the UTC offset. */
function parseUtcStamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
  const d = new Date(hasZone ? raw : raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Message header stamp: the viewer's local time on screen, the stored UTC
 *  value in the tooltip so the exact instant is never ambiguous. */
function msgStamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return { text: '', title: '' };
  const d = parseUtcStamp(raw);
  if (!d) return { text: raw.slice(5, 16), title: raw };
  return {
    text: d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    title: `${raw.replace('T', ' ').replace(/(\.\d+)?[zZ]$/, '')} UTC`
  };
}

/* ───────────────────────── Theme (dark / light / system) ───────────────────────── */
const THEMES = ['dark', 'light', 'system'];
let storedTheme = 'system';

function systemPrefersLight() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}

/** Resolve a stored mode ("system" follows the OS) to the concrete theme. */
function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersLight() ? 'light' : 'dark';
}

function applyTheme(mode) {
  storedTheme = THEMES.includes(mode) ? mode : 'system';
  try { localStorage.setItem('theme', storedTheme); } catch { /* storage disabled */ }
  const resolved = resolveTheme(storedTheme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#ffffff' : '#212121');
  const btn = $('#btn-theme');
  if (btn) btn.textContent = `🌗 Theme: ${storedTheme}`;
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(storedTheme) + 1) % THEMES.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
}

/** Sync the in-memory mode with the inline <head> script and follow the OS. */
function initTheme() {
  let saved = 'system';
  try { saved = localStorage.getItem('theme') || 'system'; } catch { /* ignore */ }
  applyTheme(THEMES.includes(saved) ? saved : 'system');
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => { if (storedTheme === 'system') applyTheme('system'); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/* ───────────────────────── Data loading ───────────────────────── */
async function loadSettings() {
  state.settings = await api('/settings');
  const s = state.settings;
  $('#set-api_base_url').value = s.api_base_url || '';
  $('#set-model').value = s.model || '';
  $('#set-temperature').value = s.temperature ?? '';
  $('#set-max_tokens').value = s.max_tokens ?? '';
  $('#set-max_tool_rounds').value = s.max_tool_rounds ?? '';
  $('#set-reasoning_effort').value = s.reasoning_effort || 'auto';
  $('#set-context_window').value = s.context_window ?? '';
  $('#set-context_compress_at').value = s.context_compress_at ?? '';
  $('#set-context_keep').value = s.context_keep ?? '';
  $('#set-api_key').value = '';
  $('#key-hint').textContent = s.api_key_masked ? `Saved key: ${s.api_key_masked} (type to replace)` : 'No key saved';
  $('#set-builtin_shell_timeout').value = s.builtin_shell_timeout ?? '';
  $('#set-aitemp_root').value = s.aitemp_root ?? '';
  const reg = $('#set-allow_registration');
  if (reg) reg.checked = String(s.allow_registration || '0') === '1';
  if (s.models) fillModelOptions(s.models);
  applyAdminUi();
  refreshHealth();
}

function fillModelOptions(models) {
  state.models = models || [];
  const dl = $('#model-list');
  dl.innerHTML = '';
  for (const m of state.models) dl.append(el('option', { value: m }));
  const sel = $('#sel-model');
  const cur = sel.value || current()?.model || state.settings.model || '';
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, '— server default —'));
  for (const m of state.models) sel.append(el('option', { value: m }, m));
  if (cur && !state.models.includes(cur)) sel.append(el('option', { value: cur }, cur));
  sel.value = cur;
}

async function loadPrompts() {
  state.prompts = await api('/prompts');
  const sel = $('#sel-prompt');
  const cur = sel.value || current()?.prompt_id || '';
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, '— none —'));
  for (const p of state.prompts) sel.append(el('option', { value: p.id }, p.name + (p.is_default ? ' ★' : '')));
  sel.value = cur || (state.prompts.find((p) => p.is_default)?.id ?? '');
  renderPromptList();
  renderInlineChoices();
  updateChatSub();
}

async function loadConversations() {
  state.conversations = await api('/conversations');
  renderConvList();
}

async function loadMcp() {
  try {
    state.mcp = await api('/mcp');
  } catch (e) {
    state.mcp = [];
  }
  renderMcpList();
  renderPlusMcp();
  updateToolsHint();
  // The list above is rebuilt from scratch, so re-apply the read-only state for
  // non-admins after every load (the buttons are new DOM nodes).
  applyAdminUi();
}

function current() {
  return state.conversations.find((c) => c.id === state.currentId) || null;
}

/** Reflect a new title in the header input and sidebar (used by AI titling). */
function applyTitle(title) {
  if (!title) return;
  const c = current();
  if (c) c.title = title;
  const input = $('#chat-title');
  if (input && document.activeElement !== input) input.value = title;
  renderConvList();
}

/* ───────────────────────── Sidebar ───────────────────────── */
/** On a phone the sidebar is an overlay drawer; on a desktop it collapses. */
const isMobile = () => window.matchMedia('(max-width: 780px)').matches;

function toggleSidebar(force) {
  const app = $('#app');
  if (isMobile()) {
    const open = force ?? !app.classList.contains('sidebar-open');
    app.classList.toggle('sidebar-open', open);
    $('#sidebar-backdrop').classList.toggle('hidden', !open);
  } else {
    $('#sidebar').classList.toggle('collapsed', force ?? undefined);
    $('#sidebar-backdrop').classList.add('hidden');
    app.classList.remove('sidebar-open');
  }
}

function renderConvList() {
  const list = $('#conv-list');
  list.innerHTML = '';
  const q = state.search.trim().toLowerCase();
  const items = state.conversations.filter(
    (c) => !q || (c.title || '').toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q)
  );
  if (!items.length) {
    list.append(el('div', { class: 'muted', style: 'padding:12px 10px;font-size:13px' }, 'No conversations yet.'));
    return;
  }
  for (const c of items) {
    const running = runningIds.has(c.id);
    const title = c.title || 'Untitled';
    const item = el(
      'div',
      {
        class: `conv-item${c.id === state.currentId ? ' active' : ''}`,
        onclick: () => openConversation(c.id)
      },
      el('div', { class: 'conv-title' },
        el('span', { class: 'conv-title-text', title }, title),
        running ? el('span', { class: 'conv-spinner', title: 'Generating…', 'aria-label': 'Generating…' }) : null),
      el('div', { class: 'conv-meta' }, `${c.message_count || 0} msg · ${c.prompt_name || 'no persona'}${c.model ? ' · ' + c.model : ''}`),
      c.workdir ? el('div', { class: 'conv-path', title: c.workdir }, `📂 ${c.workdir}`) : null,
      el('button', {
        class: 'conv-del',
        title: 'Delete conversation',
        onclick: (ev) => {
          ev.stopPropagation();
          deleteConversation(c.id);
        }
      }, '🗑')
    );
    list.append(item);
  }
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation and all its messages?')) return;
  // If it's generating, stop the server-side run first so it doesn't keep
  // writing into a conversation that is about to vanish.
  if (runningIds.has(id)) {
    try { await api('/chat/stop', { method: 'POST', body: { conversation_id: id } }); } catch { /* ignore */ }
  }
  if (run && run.conversationId === id) detachRun();
  setRunningBadge(id, false);
  await api(`/conversations/${id}`, { method: 'DELETE' });
  if (state.currentId === id) {
    state.currentId = null;
    state.messages = [];
    renderMessages();
    renderChatOptions();
    updateContextMeterFromMessages();
  }
  await loadConversations();
  toast('Conversation deleted');
}

/* ───────────────────────── Conversation ───────────────────────── */
async function newConversation() {
  if (state.currentId) {
    chatDrafts.set(state.currentId, $('#input').value);
  }
  detachRun();
  $('#input').value = '';
  autoresize();
  clearAttachments();
  state.messages = [];
  state.fileChanges = [];
  visibleUserTurns = INITIAL_USER_TURNS;
  renderMessages();
  lastContext = { tokens: 0, window: Number(state.settings.context_window) || 0, trigger: 0, fresh: false };
  renderContextMeter({ processed: 0, generated: 0, context: 0 }, lastContext.window);

  const defaultPrompt = state.prompts.find((p) => p.is_default);
  const conv = await api('/conversations', {
    method: 'POST',
    body: { prompt_id: defaultPrompt?.id ?? null, model: state.settings.model || null }
  });
  state.conversations.unshift(conv);
  renderConvList();
  await openConversation(conv.id);
  $('#input').focus();
}

async function openConversation(id) {
  // Save unsent draft from the previous conversation so it doesn't bleed into the new one
  if (state.currentId && state.currentId !== id) {
    chatDrafts.set(state.currentId, $('#input').value);
  }

  // Switching away must NOT stop the generation — just detach the viewer.
  detachRun();
  setRunningBadge(state.currentId, runningIds.has(state.currentId));

  // Reset context meter and clear stale state immediately so the old chat's tokens/messages never leak
  lastContext = { tokens: 0, window: Number(state.settings.context_window) || 0, trigger: 0, fresh: false };
  renderContextMeter({ processed: 0, generated: 0, context: 0 }, lastContext.window);

  if (isMobile()) toggleSidebar(false);
  state.currentId = id;
  visibleUserTurns = INITIAL_USER_TURNS;

  // Restore draft for this conversation (or blank) and clear attachments
  $('#input').value = chatDrafts.get(id) || '';
  autoresize();
  clearAttachments();

  // Clear messages array and DOM immediately so old chat content does not linger while loading
  state.messages = [];
  state.fileChanges = [];
  renderMessages();

  // Optimistically set title & controls from sidebar cached state
  const cached = state.conversations.find((c) => c.id === id);
  if (cached) {
    $('#chat-title').value = cached.title || 'New chat';
    $('#sel-prompt').value = cached.prompt_id ?? '';
    $('#sel-model').value = cached.model || state.settings.model || '';
    if ($('#sel-effort')) $('#sel-effort').value = cached.reasoning_effort || state.settings.reasoning_effort || 'auto';
  }
  renderConvList();
  updateChatSub();

  let conv;
  try {
    conv = await api(`/conversations/${id}`);
  } catch (e) {
    toast(`Failed to load chat: ${e.message}`, true);
    return;
  }

  // Another conversation may have been opened while this fetch was in flight.
  // Bail out so a slow response for a chat we navigated away from doesn't
  // overwrite the one now on screen.
  if (state.currentId !== id) return;
  state.messages = conv.messages || [];
  state.fileChanges = await fetchFileChanges(id);
  if (state.currentId !== id) return;
  const c = current();
  if (c) Object.assign(c, conv);
  $('#chat-title').value = conv.title || 'New chat';
  $('#sel-prompt').value = conv.prompt_id ?? '';
  $('#sel-model').value = conv.model || state.settings.model || '';
  if ($('#sel-effort')) $('#sel-effort').value = conv.reasoning_effort || state.settings.reasoning_effort || 'auto';
  renderConvList();
  renderMessages();
  updateChatSub();
  renderChatOptions();
  if (conv.context) applyContextStatus(conv.context);
  else updateContextMeterFromMessages();

  // If this chat is generating, resume watching it live.
  if (runningIds.has(id)) attachToRun(id, 0, runStartedAt.get(id));
}

function updateChatSub() {
  const c = current();
  const parts = [];
  if (c) {
    if (c.prompt_name) parts.push(c.prompt_name);
    const n = state.messages.length;
    if (n) parts.push(`${n} message${n === 1 ? '' : 's'}`);
  } else {
    parts.push('no conversation selected');
  }
  const off = chatOffServers(c);
  const toolCount = state.mcp.reduce((n, s) => {
    if (!s.enabled || s.status !== 'connected') return n;
    if (off.has(s.name) || (!!s.builtin_key && off.has(s.builtin_key))) return n;
    return n + s.tools.length;
  }, 0);
  if (toolCount) parts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'} ready`);
  $('#chat-sub').textContent = parts.join('  ·  ');
  renderComposerFolder();
}

/** Small badge under the message box showing this chat's working folder.
 *  Shows the last two path segments (full path on hover); admins can click it
 *  to open the folder picker. Ordinary users cannot browse the server's disk. */
function renderComposerFolder() {
  const el2 = $('#composer-folder');
  if (!el2) return;
  const c = current();
  const workdir = c?.workdir || '';
  if (!workdir) {
    el2.classList.add('hidden');
    el2.textContent = '';
    el2.onclick = null;
    return;
  }
  const segs = workdir.split(/[\\/]+/).filter(Boolean);
  // Show the last two segments (e.g. "aitemp/6") so the pill is recognisable;
  // the full path stays in the tooltip.
  const label = segs.slice(-2).join('/') || workdir;
  el2.classList.remove('hidden');
  el2.title = workdir;
  el2.textContent = `📂 ${label}`;
  const admin = !!state.currentUser?.is_admin;
  el2.classList.toggle('readonly', !admin);
  el2.onclick = admin ? () => openFolderPicker() : null;
}

/* ───────────────────────── Context & token totals ─────────────────────────
 * The context meter shows how full the model's window is (the largest prompt
 * count the server reported = the history it actually saw on the last round).
 * The totals line sums every round's processed (prompt) and generated
 * (completion) tokens across the whole conversation.
 */
function conversationTokenTotals() {
  let processed = 0;
  let generated = 0;
  let context = 0;
  for (const m of state.messages) {
    if (m.role !== 'assistant') continue;
    const rounds = parseTokenDetail(m.token_detail);
    if (rounds.length) {
      for (const r of rounds) {
        processed += r.prompt || 0;
        generated += r.completion || 0;
        if (r.prompt) context = r.prompt; // latest round, not the historical max
      }
    } else {
      processed += m.prompt_tokens || 0;
      generated += m.completion_tokens || 0;
      if (m.prompt_tokens) context = m.prompt_tokens;
    }
  }
  return { processed, generated, context };
}

// Remember the last context/window/trigger triple so switching chats re-renders
// it. `tokens` prefers the LIVE estimate from the server (which shrinks right
// after a compaction) over the historical "largest prompt so far".
let lastContext = { tokens: 0, window: 0, trigger: 0, fresh: false };

function updateContextMeterFromMessages() {
  const t = conversationTokenTotals();
  const win = Number(state.settings.context_window) || lastContext.window || 0;
  // A live server snapshot (chat open / after compaction) is authoritative until
  // the next real request; otherwise fall back to the latest round's prompt.
  const tokens = lastContext.fresh && lastContext.tokens ? lastContext.tokens : (t.context || 0);
  lastContext = { tokens, window: win, trigger: lastContext.trigger || 0, fresh: lastContext.fresh || false };
  renderContextMeter(t, win);
}

function updateContextMeter(contextTokens, contextWindow) {
  if (contextTokens) lastContext.tokens = contextTokens;
  if (contextWindow) lastContext.window = Number(contextWindow);
  // A real request just ran — its prompt size is the current truth.
  lastContext.fresh = true;
  const t = conversationTokenTotals();
  if (contextTokens) t.context = contextTokens;
  renderContextMeter(t, lastContext.window);
}

// Apply a live context snapshot from the server (chat open or after compact).
function applyContextStatus(ctx) {
  if (!ctx) return updateContextMeterFromMessages();
  lastContext = {
    tokens: ctx.tokens || 0,
    window: ctx.window || lastContext.window || 0,
    trigger: ctx.trigger || 0,
    fresh: true
  };
  renderContextMeter(conversationTokenTotals(), lastContext.window);
}

function renderContextMeter(totals, window) {
  const el2 = $('#hint-tokens');
  if (!el2) return;
  if (!state.currentId) {
    el2.innerHTML = '';
    return;
  }
  const bits = [];
  if (totals.processed || totals.generated) {
    bits.push(`Σ ${fmtTokens(totals.processed)} in · ${fmtTokens(totals.generated)} out`);
  }
  // Prefer the live estimate (updated on open + after compaction); fall back to
  // the largest prompt the server reported so far.
  const ctxTok = lastContext.tokens || totals.context || 0;
  const trig = lastContext.trigger || 0;
  let bar = '';
  const winNote = (window > 0 ? `window ${fmtTokens(window)} · ` : '') +
    (trig > 0 ? `auto-compacts at ${fmtTokens(trig)} (95%)` : 'auto-compact off');
  if (window > 0 && ctxTok > 0) {
    const pct = Math.min(100, Math.round((ctxTok / window) * 100));
    const cls = pct >= 90 ? 'ctx-high' : pct >= 70 ? 'ctx-mid' : '';
    bar = `<span class="ctx-meter ${cls}" title="Context ${ctxTok.toLocaleString()} / ${window.toLocaleString()} tokens (${pct}%)&#10;${winNote}">` +
      `<span class="ctx-bar"><span class="ctx-fill" style="width:${pct}%"></span></span>` +
      `${fmtTokens(ctxTok)}/${fmtTokens(window)} · ${pct}%</span>`;
  } else if (ctxTok > 0) {
    bar = `<span class="ctx-meter" title="Tokens in context on the next request&#10;${winNote}">ctx ${fmtTokens(ctxTok)}</span>`;
  } else {
    // Always show a context slot so the bottom info doesn't appear/disappear.
    bar = `<span class="ctx-meter ctx-idle" title="${winNote}">ctx —</span>`;
  }
  el2.innerHTML = bits.map((b) => `<span class="ctx-tok">${b}</span>`).join('') + bar;
}

// Briefly highlight the context meter green after a compaction so the drop is
// obvious even if the user isn't watching the number closely.
function flashContextMeter() {
  const el2 = $('#hint-tokens');
  if (!el2) return;
  const meter = el2.querySelector('.ctx-meter');
  const target = meter || el2;
  target.classList.remove('ctx-flash');
  // Force reflow so the animation can replay on consecutive compactions.
  void target.offsetWidth;
  target.classList.add('ctx-flash');
  setTimeout(() => target.classList.remove('ctx-flash'), 1400);
}

/**
 * Manually roll older turns into the summary now (the "Compact" button).
 * Blocked while a generation is running for this chat. Reports the token
 * reduction in a toast; the meter refreshes on the next turn.
 */
async function compactNow() {
  if (!state.currentId) return toast('Open a chat first.', true);
  if (runningIds.has(state.currentId)) return toast('Stop the current generation before compacting.', true);
  const btn = $('#btn-compact');
  const level = ($('#compact-level') && $('#compact-level').value) || 'auto';
  btn.disabled = true;
  btn.classList.add('compacting');
  const prev = btn.textContent;
  btn.textContent = '⏳ Compacting…';
  try {
    const r = await api('/chat/compact', { method: 'POST', body: { conversation_id: state.currentId, level } });
    if (r.compressed) {
      const b = (r.before_tokens || 0).toLocaleString();
      const a = (r.after_tokens || 0).toLocaleString();
      const pct = b > 0 ? Math.round((1 - a / b) * 100) : 0;
      // Update the meter to the live (post-compaction) size and flash it green.
      if (r.context) applyContextStatus(r.context);
      flashContextMeter();
      toast(`⤓ Compacted (${r.level || level}): ${b} → ${a} tokens · ${pct}% smaller`);
    } else if (r.skipped === 'nothing-eligible') {
      toast('Nothing to compact yet — the chat is too short to trim at this level.');
    } else if (r.skipped === 'window-disabled') {
      toast('Set a context window in Settings before compacting.', true);
    } else {
      toast('Nothing to compact.');
    }
  } catch (e) {
    toast(e.message || 'Compaction failed.', true);
  } finally {
    btn.disabled = false;
    btn.classList.remove('compacting');
    btn.textContent = prev;
  }
}

/* ───────────────────────── Per-chat tool policy ─────────────────────────
 * Each conversation carries its own working folder, approval mode and file /
 * shell access. These controls sit above the message box and save on change.
 */
function renderChatOptions() {
  const c = current();
  const bar = $('#chat-options');
  bar.classList.toggle('hidden-controls', !c);
  if (!c) return;
  $('#co-workdir').value = c.workdir || '';
  setSeg('#co-approval', c.approval_mode || 'ask');
  setSeg('#co-files-access', c.file_access || 'restricted');
  setSeg('#co-shell-access', c.shell_access || 'restricted');
  $('#co-files-on').checked = Number(c.files_enabled ?? 1) !== 0;
  $('#co-shell-on').checked = Number(c.shell_enabled ?? 1) !== 0;
  const eff = $('#sel-effort');
  if (eff) eff.value = c.reasoning_effort || state.settings.reasoning_effort || 'auto';
  syncOptionGroups();
  updateToolsHint();
  renderInlineChoices();
  renderPlusMcp();
}

/** Mark the active button of a segmented toggle group. */
function setSeg(sel, value) {
  const seg = $(sel);
  if (!seg) return;
  seg.dataset.value = value;
  for (const b of seg.querySelectorAll('button')) {
    const on = b.dataset.value === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function syncOptionGroups() {
  // Each tool set lives on one row: switch off, the rest of the row dims.
  $('#co-files-on').closest('.pm-row').classList.toggle('off', !$('#co-files-on').checked);
  $('#co-shell-on').closest('.pm-row').classList.toggle('off', !$('#co-shell-on').checked);
}

async function setChatOption(patch) {
  const c = current();
  if (!c) return;
  try {
    const updated = await api(`/conversations/${c.id}`, { method: 'PATCH', body: patch });
    Object.assign(c, updated);
    $('#co-files-on').checked = Number(c.files_enabled ?? 1) !== 0;
    $('#co-shell-on').checked = Number(c.shell_enabled ?? 1) !== 0;
    syncOptionGroups();
    updateToolsHint();
    updateChatSub();
    renderPlusMcp();
  } catch (e) {
    toast(e.message, true);
    renderChatOptions(); // roll the control back to the stored value
  }
}

// How many recent user turns to display initially before showing the "Load earlier" banner.
const INITIAL_USER_TURNS = 2;
// How many additional user turns to load each time the user clicks "Load earlier".
const USER_TURNS_STEP = 2;
let visibleUserTurns = INITIAL_USER_TURNS;

function renderMessages(preserveScroll = false) {
  const prevScrollHeight = $('#messages')?.scrollHeight || 0;
  const prevScrollTop = $('#messages')?.scrollTop || 0;
  const box = $('#messages');
  // The "+" menu is moved into the blank-chat setup panel. Bring it home
  // before clearing the transcript, or it would be wiped with the messages.
  detachInlinePlus();
  box.innerHTML = '';
  autoFollow = true;
  const exportBtn = $('#btn-export-chat');
  if (exportBtn) exportBtn.disabled = !state.currentId;
  const filesBtn = $('#btn-header-files');
  if (filesBtn) filesBtn.disabled = !state.currentId;
  if (!state.currentId) {
    box.append($('#empty-state') || buildEmptyState());
    $('#empty-state').classList.remove('hidden');
    const rail = $('#pill-rail');
    if (rail) { rail.innerHTML = ''; rail.classList.add('hidden'); }
    return;
  }
  const msgs = state.messages;
  // A freshly created chat has no messages yet: show the welcome panel instead
  // of an empty page, but without the "start a chat" buttons (we're already in
  // one) so the composer below is the obvious next step.
  if (!msgs.length) {
    const empty = buildEmptyState();
    empty.classList.add('in-chat', 'has-setup');
    empty.querySelector('.empty-actions')?.remove();
    // The panel is the point of this screen, so drop the big welcome block and
    // keep a single line of context above it.
    empty.querySelector('.empty-emoji')?.remove();
    empty.querySelector('h2')?.remove();
    const p = empty.querySelector('p');
    if (p) p.textContent = 'Everything here applies to this chat. Add files or images with +.';
    box.append(empty);
    attachInlinePlus(empty);
    const rail = $('#pill-rail');
    if (rail) { rail.innerHTML = ''; rail.classList.add('hidden'); }
    return;
  }
  // User-turn based paging: display the most recent user messages + replies,
  // with an expandable banner to load earlier turns in parts (or all at once).
  const userIndices = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user') userIndices.push(i);
  }
  const totalTurns = userIndices.length;
  let startIndex = 0;
  let hiddenTurns = 0;
  if (totalTurns > visibleUserTurns && visibleUserTurns > 0) {
    startIndex = userIndices[totalTurns - visibleUserTurns];
    hiddenTurns = totalTurns - visibleUserTurns;
  }

  if (startIndex > 0) {
    const hiddenMsgs = startIndex;
    const nextStep = Math.min(USER_TURNS_STEP, hiddenTurns);
    const stepLabel = nextStep === 1 ? "1 turn" : `${nextStep} turns`;
    const banner = el('div', { class: 'load-earlier-banner' },
      el('span', { class: 'load-earlier-info' }, `${hiddenTurns} earlier turn${hiddenTurns === 1 ? '' : 's'} (${hiddenMsgs} message${hiddenMsgs === 1 ? '' : 's'}) hidden`),
      el('div', { class: 'load-earlier-actions' },
        el('button', {
          class: 'btn btn-sm load-earlier-btn',
          onclick: () => {
            visibleUserTurns += USER_TURNS_STEP;
            renderMessages(true);
          }
        }, `📜 Load +${stepLabel}`),
        el('button', {
          class: 'btn btn-sm btn-ghost load-earlier-all',
          onclick: () => {
            visibleUserTurns = totalTurns;
            renderMessages(true);
          }
        }, `Load all (${totalTurns})`)
      )
    );
    box.append(banner);
    for (let i = startIndex; i < msgs.length; i++) {
      box.append(renderMessage(msgs[i]));
    }
  } else {
    for (const m of msgs) box.append(renderMessage(m));
  }
  if (preserveScroll) {
    const newScrollHeight = box.scrollHeight;
    box.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
  } else {
    scrollBottom();
  }
  renderPillRail();
}

/* ───────────────────────── Pill scroll rail ─────────────────────────
 * A vertical minimap beside the transcript: one pill per *rendered* message,
 * laid out proportionally to its position. Clicking a pill scrolls to that
 * message; the active pill tracks what's currently near the top. Pills mirror
 * only the messages on screen (earlier ones may be behind the load-earlier
 * cutoff), so every pill always has a target to scroll to. */
function renderPillRail() {
  const rail = $('#pill-rail');
  if (!rail) return;
  rail.innerHTML = '';
  const box = $('#messages');
  const nodes = [...box.querySelectorAll('.msg[data-id]')].filter((n) => n.classList.contains('user') || n.classList.contains('assistant'));
  if (nodes.length < 2) {
    rail.classList.add('hidden');
    return;
  }
  rail.classList.remove('hidden');
  const n = nodes.length;
  nodes.forEach((node, i) => {
    const id = Number(node.getAttribute('data-id'));
    const role = node.classList.contains('user') ? 'user' : 'assistant';
    const pill = el('div', { class: `pill ${role}`, 'data-idx': String(i) });
    pill.style.top = `calc(${(i / n) * 100}% + 1px)`;
    pill.title = (node.querySelector('.content')?.textContent || role).replace(/\s+/g, ' ').slice(0, 60);
    pill.onclick = () => {
      const t = box.querySelector(`.msg[data-id="${id}"]`);
      if (!t) return;
      autoFollow = false;
      // Scroll deterministically: smooth animation can be cancelled by the
      // box's own scroll handler, so set scrollTop directly (instant).
      const targetTop = t.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTop = Math.max(0, targetTop - 4);
    };
    rail.append(pill);
  });
  syncActivePill();
}

/** Highlight the pill whose message is nearest the top of the viewport. */
function syncActivePill() {
  const rail = $('#pill-rail');
  if (!rail || rail.classList.contains('hidden')) return;
  const box = $('#messages');
  const nodes = [...box.querySelectorAll('.msg[data-id]')].filter((n) => n.classList.contains('user') || n.classList.contains('assistant'));
  if (!nodes.length) return;
  const top = box.scrollTop + 4;
  let bestIdx = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].offsetTop <= top + 1) bestIdx = i;
    else break;
  }
  const pills = rail.children;
  for (let i = 0; i < pills.length; i++) pills[i].classList.toggle('active', i === bestIdx);
}

function buildEmptyState() {
  const d = el('div', { id: 'empty-state', class: 'empty-state' },
    el('div', { class: 'empty-emoji' }, '🤖'),
    el('h2', {}, 'RiSriGPT'),
    el('p', { html: 'Your conversations are stored in a local SQLite database.<br>Point Settings at any OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM, OpenAI…).' }),
    el('div', { class: 'empty-actions' },
      el('button', { class: 'btn btn-primary', onclick: () => newConversation() }, 'Start a chat'),
      el('button', { class: 'btn', onclick: () => openModal('#dlg-settings') }, 'Configure server URL')),
    el('div', { class: 'empty-setup' },
      el('div', { class: 'empty-setup-head' }, 'Chat setup'))
  );
  return d;
}

/* ── Blank-chat setup panel ──
 * While a chat has no messages there is nothing to read, so the per-chat
 * settings move out of the "+" menu and sit in the blank area: everything on
 * screen at once, no tabs, and the two <select> rows (persona, thinking) are
 * mirrored as one-click chips so no choice hides behind a dropdown.
 *
 * Attachments stay in the "+" menu — the "+" button keeps working exactly as
 * it does in a chat with messages. Only the sections listed below are moved,
 * so there is still a single copy of every control and no state to sync; the
 * same nodes go back into the menu as soon as the chat has content. */
const SETUP_INLINE_SECTIONS = ['chat-options', 'pm-mcp-tools', 'pm-mcp-builtin', 'pm-mcp-custom'];
const SETUP_MENU_ORDER = ['pm-mcp-tools', 'pm-mcp-builtin', 'pm-mcp-custom', 'pm-attach', 'chat-options', 'image-url-row'];

function attachInlinePlus(empty) {
  const menu = $('#plus-menu');
  const host = empty && empty.querySelector('.empty-setup');
  if (!menu || !host) return;
  let body = host.querySelector('.empty-setup-body');
  if (!body) {
    body = el('div', { class: 'empty-setup-body' });
    host.append(body);
  }
  for (const id of SETUP_INLINE_SECTIONS) {
    const sec = menu.querySelector('#' + id);
    if (sec) body.append(sec);
  }
  menu.dataset.split = '1';
  renderInlineChoices();
}

/** Put the moved sections back in the "+" menu (original order). */
function detachInlinePlus() {
  const menu = $('#plus-menu');
  if (!menu || menu.dataset.split !== '1') return;
  for (const id of SETUP_MENU_ORDER) {
    const sec = document.getElementById(id);
    if (sec) menu.append(sec);
  }
  // The popup uses the plain selects again.
  for (const box of menu.querySelectorAll('.choice-chips')) box.remove();
  for (const row of menu.querySelectorAll('.has-chips')) row.classList.remove('has-chips');
  delete menu.dataset.split;
}

/** Mirror one <select> as one-click chips, kept in sync both ways. */
function choiceChips(sel) {
  const row = sel.closest('.pm-row');
  if (!row) return;
  let box = row.querySelector('.choice-chips');
  if (!box) {
    const label = row.querySelector('.pm-label');
    box = el('div', {
      class: 'choice-chips',
      role: 'group',
      'aria-label': label ? label.textContent : 'Choices'
    });
    sel.insertAdjacentElement('afterend', box);
  }
  row.classList.add('has-chips');
  box.innerHTML = '';
  for (const o of sel.options) {
    const on = o.value === sel.value;
    box.append(el('button', {
      type: 'button',
      class: `choice-chip${on ? ' on' : ''}`,
      'data-value': o.value,
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change'));
        renderInlineChoices();
      }
    }, o.textContent.replace(/\s*★\s*$/, '')));
  }
}

/** Repaint the inline chips from the live select values. */
function renderInlineChoices() {
  const menu = $('#plus-menu');
  const body = document.querySelector('.empty-setup-body');
  if (!menu || menu.dataset.split !== '1' || !body) return;
  for (const sel of body.querySelectorAll('select')) choiceChips(sel);
}

/** Label of the button that restarts a reply which a server error cut short. */
const RESUME_LABEL = '▶ Resume';

function renderMessage(m) {
  const label = m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool result' : m.role === 'system' ? 'System' : 'Assistant';
  const avatar = m.role === 'user' ? '🧑' : m.role === 'tool' ? '🔌' : m.role === 'system' ? 'ℹ️' : '🤖';
  const isLast = state.messages[state.messages.length - 1]?.id === m.id;
  const wrap = el('div', { class: `msg ${m.role}`, 'data-id': m.id });
  wrap.append(el('div', { class: 'msg-avatar' }, avatar));
  const stamp = msgStamp(m.created_at);
  // A failed reply may have no text at all — the reason lives in `error`, so the
  // copy button would only copy an empty string.
  const canCopy = !!(m.content || '').trim();
  const body = el('div', { class: 'msg-body' });
  body.append(
    el('div', { class: 'msg-head' },
      el('strong', {}, label),
      el('span', { class: 'msg-time', title: stamp.title || null }, stamp.text),
      el('span', { class: 'msg-actions' },
        canCopy ? el('button', { title: 'Copy', onclick: async () => { toast((await copyText(m.content || '')) ? 'Copied' : 'Copy failed'); } }, 'copy') : null,
        // Regenerate and delete belong to the user's turn: they act on the
        // question and its answer, so they are not shown on assistant rows.
        m.role === 'user' && hasReplyAfter(m)
          ? el('button', { title: 'Regenerate the reply to this message', onclick: () => regenerateFrom(m) }, 'regenerate')
          : null,
        m.role === 'assistant' && isLast && !state.streaming && !m.error
          ? el('button', { title: 'Continue this reply where it stopped', onclick: () => continueReply() }, 'continue')
          : null,
        m.role === 'user' ? el('button', { title: 'Edit & resend', onclick: () => editUserMessage(m) }, 'edit') : null,
        m.role === 'user' ? el('button', { title: 'Delete message', onclick: () => deleteMessage(m.id) }, 'delete') : null
      )
    )
  );

  // Tool results are merged into the calling tool's chip (see renderSegments),
  // so a standalone tool-result row renders nothing on its own.
  if (m.role === 'tool') {
    wrap.classList.add('hidden');
    wrap.append(body);
    return wrap;
  }

  const bubble = el('div', { class: 'bubble' });
  if (m.image_url) bubble.append(el('img', { src: m.image_url, alt: 'attached image', loading: 'lazy' }));

  const files = parseFiles(m.files);
  const segs = parseSegments(m.segments);
  if (m.role === 'assistant' && segs.length) {
    // Ordered layout saved by the server: thinking / text / tool calls / files
    // interleaved exactly as they were streamed.
    renderSegments(bubble, m, segs, files);
  } else {
    // Legacy rows (or rows without a stored layout): thinking, text, files, tools.
    if (m.reasoning) {
      bubble.append(
        el('details', { class: 'thinking' },
          el('summary', {}, `🧠 Thinking (${m.reasoning.length.toLocaleString()} characters)`),
          el('div', { class: 'thinking-body', html: renderMarkdown(m.reasoning) })
        )
      );
    }

    if (m.content || !m.error) {
      const content = el('div', { class: 'content' });
      content.innerHTML = renderMarkdown(m.content || '');
      bubble.append(content);
    }

    if (files.length) bubble.append(fileChips(files));

    if (m.tool_calls) {
      for (const tc of parseToolCalls(m.tool_calls)) {
        bubble.append(toolChip(tc));
      }
    }
  }
  // Persisted failure reason: shown in the transcript (not just a transient
  // toast), so a reload still explains why the reply stopped. When the failed
  // reply is the last one, it also gets a Resume button: the server kept
  // whatever had already streamed, so the useful next step is to ask the model
  // to carry on from that point instead of starting the answer over.
  if (m.error) {
    const canResume = m.role === 'assistant' && isLast && !state.streaming;
    const box = el('div', { class: 'error-box', role: 'alert' },
      el('div', { class: 'error-text' }, m.error)
    );
    if (canResume) {
      box.append(
        el('div', { class: 'error-actions' },
          el('button', {
            class: 'btn btn-primary sm error-resume',
            title: 'Ask the model to continue this reply from where it stopped',
            onclick: async (e) => {
              const btn = e.currentTarget;
              btn.disabled = true;
              btn.textContent = 'Resuming…';
              // continueReply() re-enables the button by returning false when it
              // could not start, so a failed attempt is not a dead end.
              if (!(await continueReply())) {
                btn.disabled = false;
                btn.textContent = RESUME_LABEL;
              }
            }
          }, RESUME_LABEL)
        )
      );
    }
    bubble.append(box);
  }
  body.append(bubble);
  if (m.role === 'assistant') {
    const stats = el('div', { class: 'msg-stats' }, statsText(m));
    body.append(stats);
    // Expandable per-round token breakdown (processed / generated per part).
    if (m.prompt_tokens || m.completion_tokens || parseTokenDetail(m.token_detail).length) {
      body.append(
        el('details', { class: 'token-detail-wrap' },
          el('summary', {}, 'token breakdown'),
          tokenBreakdown(m))
      );
    }
    // Files this turn changed: show only once at the end of the turn (on the final assistant message),
    // not repeated after intermediate tool-call assistant steps.
    if (isLastAssistantInTurn(m)) {
      const userMsg = priorUserMessage(m);
      const changes = (state.fileChanges || []).filter((c) => (userMsg ? c.message_id === userMsg.id : false));
      if (changes.length) body.append(fileChangeList(changes));
    }
  }
  wrap.append(body);
  return wrap;
}

/** `segments` is the ordered reply layout stored as JSON on assistant rows. */
function parseSegments(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseToolCalls(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toolChip(tc) {
  const result = toolResultForCall(tc.id);
  const cancelled = result?.tool_cancelled === 1;
  const denied = !cancelled && typeof result?.content === 'string' && /^Tool (call )?denied|denied by you/i.test(result.content);
  let status = 'done';
  if (cancelled) status = 'cancelled';
  else if (denied) status = 'denied';
  return buildToolChip({
    id: tc.id,
    name: tc.function?.name || 'tool',
    argsText: prettyJson(tc.function?.arguments),
    status,
    resultText: result ? (result.content || '') : '',
    durationMs: result?.tool_duration_ms ?? null
  });
}

/**
 * Build the bubble contents in the exact order the events were streamed.
 * The row stores one reasoning string and one content string, so repeated
 * thinking/text segments render the whole string at the first occurrence and
 * later ones are skipped (a round's thinking/text is contiguous in practice).
 */
function renderSegments(bubble, m, segs, files) {
  const calls = new Map(parseToolCalls(m.tool_calls).map((tc) => [tc.id, tc]));
  let thinkDone = false;
  let textDone = false;
  const addThinking = () => {
    if (thinkDone || !m.reasoning) return;
    thinkDone = true;
    bubble.append(
      el('details', { class: 'thinking' },
        el('summary', {}, `🧠 Thinking (${m.reasoning.length.toLocaleString()} characters)`),
        el('div', { class: 'thinking-body', html: renderMarkdown(m.reasoning) })
      )
    );
  };
  const addText = () => {
    if (textDone) return;
    textDone = true;
    const content = el('div', { class: 'content' });
    content.innerHTML = renderMarkdown(m.content || '');
    bubble.append(content);
  };
  for (const s of segs) {
    if (s.t === 'r') addThinking();
    else if (s.t === 't') addText();
    else if (s.t === 'tc') {
      const tc = calls.get(s.id);
      if (tc) bubble.append(toolChip(tc));
    } else if (s.t === 'f') {
      const f = files[s.i];
      if (f) bubble.append(fileChips([f]));
    }
  }
  // Defensive: anything the segments forgot still gets shown.
  addText();
  addThinking();
}

/** `files` is stored as JSON text on the message row. */
function parseFiles(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Format a millisecond duration as h/m/s (e.g. "1h 04m 07s", "2m 05s", "8.3s"). */
function fmtDuration(ms) {
  if (!ms && ms !== 0) return '';
  const totalSec = ms / 1000;
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  return `${m}m ${('0' + s).slice(-2)}s`;
}

/** Compact large token counts: 1234 -> "1.2k", 1234567 -> "1.23M". */
function fmtTokens(n) {
  if (n == null) return '?';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Parse a stored token_detail blob (per API round). */
function parseTokenDetail(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** One line: how long, how fast, how many tokens. */
function statsText(m) {
  const bits = [];
  if (m.duration_ms) bits.push(`⏱ ${fmtDuration(m.duration_ms)}`);
  if (m.tg_tok_s) bits.push(`⚡ ${Number(m.tg_tok_s).toFixed(1)} tok/s gen`);
  if (m.pp_tok_s) bits.push(`📥 ${Number(m.pp_tok_s).toFixed(0)} tok/s prompt`);
  if (m.completion_tokens) bits.push(`${fmtTokens(m.prompt_tokens)} → ${fmtTokens(m.completion_tokens)} tok`);
  return bits.join('  ·  ');
}

/**
 * Detailed per-round token breakdown for an assistant message: one row per API
 * round (a "part" of the reply — model call, tool round, …), showing the prompt
 * tokens processed and completion tokens generated, plus a total.
 */
function tokenBreakdown(m) {
  const rounds = parseTokenDetail(m.token_detail);
  const box = el('div', { class: 'token-detail' });
  box.append(el('div', { class: 'td-head' }, '🔢 Token detail'));
  if (!rounds.length) {
    box.append(el('div', { class: 'td-empty muted' }, 'The server did not report per-round token counts for this reply.'));
    if (m.prompt_tokens || m.completion_tokens) {
      box.append(el('div', { class: 'td-total' }, `Total: ${fmtTokens(m.prompt_tokens)} prompt · ${fmtTokens(m.completion_tokens)} generated`));
    }
    return box;
  }
  const table = el('table', { class: 'td-table' });
  table.append(
    el('tr', {}, el('th', {}, 'Round'), el('th', {}, 'Prompt'), el('th', {}, 'Generated'), el('th', {}, 'Gen tok/s'))
  );
  for (const r of rounds) {
    // Prefer the server's own per-second rate (correct under speculative
    // decoding); fall back to computing from the reported ms.
    const tg = r.tg_s != null ? Number(r.tg_s).toFixed(1)
      : (r.predicted_ms > 0 && r.completion > 0 ? (r.completion / (r.predicted_ms / 1000)).toFixed(1) : '—');
    table.append(
      el('tr', {},
        el('td', {}, `#${r.r}`),
        el('td', {}, fmtTokens(r.prompt)),
        el('td', {}, fmtTokens(r.completion)),
        el('td', {}, tg))
    );
  }
  const tp = rounds.reduce((a, r) => a + (r.prompt || 0), 0);
  const tc = rounds.reduce((a, r) => a + (r.completion || 0), 0);
  table.append(
    el('tr', { class: 'td-sum' },
      el('td', {}, 'Total'), el('td', {}, fmtTokens(tp)), el('td', {}, fmtTokens(tc)), el('td', {}, ''))
  );
  box.append(table);
  return box;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;
const isImageFile = (f) => !!f && !f.dir && IMAGE_EXT_RE.test(f.name || '');

/** A produced image file: thumbnail that opens in the fullscreen lightbox. */
function imageChip(f) {
  return el('figure', { class: 'file-chip file-chip-image', title: f.path },
    el('img', {
      class: 'file-thumb',
      src: fileUrl(f.path, false),
      alt: f.name,
      loading: 'lazy',
      onerror: (e) => { e.target.closest('.file-chip-image')?.classList.add('thumb-broken'); }
    }),
    el('figcaption', {},
      el('span', { class: 'file-chip-name' }, f.name),
      el('span', { class: 'file-chip-size' }, fmtSize(f.size)),
      el('a', { class: 'file-chip-dl', href: fileUrl(f.path), download: f.name, title: 'Download' }, '⬇ save')
    )
  );
}

// ── Lightbox state: the group of images the viewer is currently paging ──
const LIGHTBOX = { items: [], index: 0 };

function lightboxShow(index) {
  const lb = $('#dlg-lightbox');
  const img = $('#lightbox-img');
  const cap = $('#lightbox-caption');
  const item = LIGHTBOX.items[index];
  if (!item) return;
  LIGHTBOX.index = index;
  img.src = item.src;
  img.alt = item.alt || 'image';
  const n = LIGHTBOX.items.length;
  if (cap) cap.textContent = n > 1 ? `${index + 1} / ${n}  ·  ${item.alt || 'image'}` : (item.alt || '');
  const nav = $('#lightbox-nav');
  if (nav) nav.classList.toggle('hidden', n < 2);
  lb.showModal();
}

function lightboxStep(delta) {
  const n = LIGHTBOX.items.length;
  if (n < 2) return;
  lightboxShow((LIGHTBOX.index + delta + n) % n);
}

/** A clickable grid of thumbnails; the whole group pages in the lightbox. */
/** One thumbnail tile used inside the live gallery. */
function imageTile(f) {
  return el('figure', { class: 'img-tile', title: f.path || f.name },
    el('img', {
      src: fileUrl(f.path, false),
      alt: f.name,
      loading: 'lazy',
      onerror: (e) => { e.target.closest('.img-tile')?.classList.add('thumb-broken'); }
    }),
    el('figcaption', {}, f.name)
  );
}

/**
 * Fold one produced file into the live reply. Images accumulate into a single
 * gallery container so several pictures render as one grid (each clickable)
 * instead of a stack of one-image chips; non-images stay as plain chips.
 */
function appendLiveFile(bubble, r, d) {
  if (!isImageFile(d)) { bubble.append(fileChips([d])); return; }
  if (!r.liveImages) {
    const box = el('div', { class: 'img-gallery' });
    const title = el('div', { class: 'img-gallery-title' });
    const grid = el('div', { class: 'img-gallery-grid' });
    box.append(title, grid);
    bubble.append(box);
    r.liveImages = { box, title, grid, count: 0 };
  }
  r.liveImages.count += 1;
  r.liveImages.title.textContent = `🖼 ${r.liveImages.count} image${r.liveImages.count > 1 ? 's' : ''}`;
  r.liveImages.grid.append(imageTile(d));
}

/** A clickable grid of thumbnails; the whole group pages in the lightbox. */
function imageGallery(images) {
  const box = el('div', { class: 'img-gallery' });
  box.append(el('div', { class: 'img-gallery-title' }, `🖼 ${images.length} images`));
  const grid = el('div', { class: 'img-gallery-grid' });
  for (const f of images) {
    grid.append(
      el('figure', { class: 'img-tile', title: f.path || f.name },
        el('img', {
          src: fileUrl(f.path, false),
          alt: f.name,
          loading: 'lazy',
          onerror: (e) => { e.target.closest('.img-tile')?.classList.add('thumb-broken'); }
        }),
        el('figcaption', {}, f.name)
      )
    );
  }
  box.append(grid);
  return box;
}

function fileChips(files) {
  const box = el('div', { class: 'file-chips' });
  const images = files.filter(isImageFile);
  const others = files.filter((f) => !isImageFile(f));

  // Several pictures read better as one grid than as a stack of chips.
  if (images.length > 1) box.append(imageGallery(images));
  else if (images.length === 1) box.append(imageChip(images[0]));

  for (const f of others) {
    box.append(el('span', { class: 'file-chip', title: f.path },
      el('span', {}, f.dir ? '📁' : '📄'),
      el('span', { class: 'file-chip-name' }, f.name),
      f.dir ? null : el('span', { class: 'file-chip-size' }, fmtSize(f.size)),
      f.dir
        ? el('a', { class: 'file-chip-dl', href: folderZipUrl(f.path), download: `${f.name}.zip`, title: `Download "${f.name}" folder as .zip` }, '⬇ zip')
        : el('a', { class: 'file-chip-dl', href: fileUrl(f.path), download: f.name, title: 'Download' }, '⬇ save')
    ));
  }
  return box;
}

function prettyJson(v) {
  if (typeof v !== 'string') return JSON.stringify(v ?? {}, null, 2);
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

/** Find the tool name that a stored tool-result message belongs to. */
function toolNameForCall(callId) {
  if (!callId) return 'tool result';
  for (const m of state.messages) {
    if (!m.tool_calls) continue;
    try {
      const tcs = JSON.parse(m.tool_calls);
      const hit = tcs.find((t) => t.id === callId);
      if (hit) return hit.function?.name || 'tool';
    } catch { /* ignore */ }
  }
  return 'tool result';
}

/** The stored tool-result row (if any) for a call id — merged into its chip. */
function toolResultForCall(callId) {
  if (!callId) return null;
  return state.messages.find((m) => m.role === 'tool' && m.tool_call_id === callId) || null;
}

/** Compact duration for a tool call: ms under a second, else s/m/h. */
function fmtToolDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return fmtDuration(ms);
}

/**
 * Build a compact, expandable tool chip. A single line shows the tool name,
 * a status (running / done+duration / cancelled / denied) and, while running,
 * a Cancel button. Clicking the line expands to reveal the arguments and the
 * merged result — no separate result chip.
 *
 * @param {{id,name,argsText,status,resultText,durationMs,cancelled,denied,showCancel}} o
 */
function buildToolChip(o) {
  const status = el('span', { class: 'tool-status' });
  const cancel = el('button', {
    class: 'tool-cancel',
    type: 'button',
    title: 'Cancel this tool call and continue',
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); cancelToolCall(o.id, cancel); }
  }, 'cancel');
  const summary = el('summary', {},
    el('span', { class: 'tool-ico' }, '🔌'),
    el('span', { class: 'tool-name' }, o.name || 'tool'),
    status,
    cancel
  );
  const argsBlock = o.argsText ? el('div', { class: 'tool-args' }, el('pre', {}, o.argsText)) : null;
  const outBlock = el('div', { class: 'tool-out hidden' });
  const chip = el('details', { class: 'tool-chip' }, summary, argsBlock, outBlock);
  if (o.id) chip.dataset.callId = o.id;
  applyToolState(chip, o);
  return chip;
}

/** Update a chip's status line, result body and cancel button in place. */
function applyToolState(chip, o) {
  if (!chip) return;
  const status = chip.querySelector('.tool-status');
  const cancel = chip.querySelector('.tool-cancel');
  const out = chip.querySelector('.tool-out');
  chip.classList.remove('is-running', 'is-done', 'is-cancelled', 'is-denied', 'is-unavailable');
  if (o.status === 'running') {
    chip.classList.add('is-running');
    status.textContent = 'running…';
    if (cancel) cancel.classList.remove('hidden');
  } else if (o.status === 'cancelled') {
    chip.classList.add('is-cancelled');
    status.textContent = `cancelled${o.durationMs != null ? ` in ${fmtToolDuration(o.durationMs)}` : ''}`;
    if (cancel) cancel.classList.add('hidden');
  } else if (o.status === 'denied') {
    chip.classList.add('is-denied');
    status.textContent = 'denied by you';
    if (cancel) cancel.classList.add('hidden');
  } else if (o.status === 'unavailable') {
    chip.classList.add('is-unavailable');
    status.textContent = 'not available — skipped';
    if (cancel) cancel.classList.add('hidden');
  } else {
    // done
    chip.classList.add('is-done');
    status.textContent = o.durationMs != null ? `done in ${fmtToolDuration(o.durationMs)}` : 'done';
    if (cancel) cancel.classList.add('hidden');
  }
  if (out) {
    if (o.resultText != null && o.resultText !== '') {
      out.classList.remove('hidden');
      if (out.querySelector('pre')?.textContent !== o.resultText) {
        out.innerHTML = '';
        out.append(el('pre', {}, o.resultText));
      }
    } else if (o.status === 'running') {
      out.classList.add('hidden');
    }
  }
}

/** Ask the server to cancel one in-flight tool call (the model is told it was cancelled). */
async function cancelToolCall(callId, btn) {
  if (!state.currentId || !callId) return;
  if (btn) { btn.disabled = true; btn.textContent = 'cancelling…'; }
  try {
    await api('/chat/stop-tool', { method: 'POST', body: { conversation_id: state.currentId, call_id: callId } });
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = 'cancel'; }
    toast('Could not cancel the tool call', true);
  }
}

/** Is the message list scrolled to (near) the bottom? */
function isNearBottom(threshold = 120) {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}

function scrollBottom(force = false) {
  const box = $('#messages');
  // During streaming we only follow the newest text if the user hasn't scrolled
  // up to read — otherwise the reply would fight their scroll position.
  if (!force && state.streaming && !autoFollow) return;
  box.scrollTop = box.scrollHeight;
}

/**
 * Called for every streamed chunk: snap to the bottom only while the user is
 * following. If they scrolled up, leave their position untouched.
 */
function scrollToBottomIfFollowing() {
  const box = $('#messages');
  if (autoFollow) box.scrollTop = box.scrollHeight;
}

// Whether the view is auto-following the tail of the transcript.
let autoFollow = true;
function watchMessagesScroll() {
  const box = $('#messages');
  box.addEventListener('scroll', () => {
    autoFollow = isNearBottom();
    const btn = $('#scroll-latest');
    if (btn) btn.classList.toggle('hidden', autoFollow);
    syncActivePill();
  }, { passive: true });
}

async function deleteMessage(id) {
  await api(`/conversations/${state.currentId}/messages/${id}`, { method: 'DELETE' });
  state.messages = state.messages.filter((m) => m.id !== id);
  renderMessages();
}

function editUserMessage(m) {
  const node = $(`.msg[data-id="${m.id}"] .content`);
  if (!node) return;
  const ta = document.createElement('textarea');
  ta.className = 'edit-area';
  ta.rows = Math.min(12, Math.max(2, (m.content || '').split('\n').length + 1));
  ta.value = m.content || '';
  node.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const actions = el('div', { class: 'row', style: 'margin-top:8px' },
    el('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, 'Save & resend'),
    el('button', { class: 'btn', type: 'button', onclick: renderMessages }, 'Cancel')
  );
  ta.after(actions);

  function submit() {
    const text = ta.value;
    api(`/conversations/${state.currentId}/truncate-after`, { method: 'POST', body: { message_id: m.id } })
      .then(() => {
        state.messages = state.messages.filter((x) => x.id < m.id);
        renderMessages();
        $('#input').value = text;
        autoresize();
        sendMessage();
      })
      .catch((e) => {
        toast(e.message, true);
        renderMessages();
      });
  }
}

/* ───────────────────────── Server folder picker ─────────────────────────
 * The working folder lives on the machine running the app, so the browser
 * cannot open its own folder dialog — it browses the server instead.
 */
const folderPicker = { path: '', home: '', drives: [], parent: null };

function folderError(msg) {
  const pre = $('#folder-error');
  pre.textContent = msg || '';
  pre.classList.toggle('hidden', !msg);
}

async function browseFolder(p) {
  try {
    const r = await api(`/fs/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
    folderPicker.path = r.path || '';
    folderPicker.home = r.home || '';
    folderPicker.drives = r.drives || [];
    folderPicker.parent = r.parent;
    $('#folder-path').value = r.path || '';
    const dl = $('#folder-drives');
    dl.innerHTML = '';
    for (const d of folderPicker.drives) {
      dl.append(el('button', { class: 'btn btn-ghost drive-btn', onclick: () => browseFolder(d.path) }, d.name));
    }
    const list = $('#folder-list');
    list.innerHTML = '';
    if (!folderPicker.drives.length && !r.entries) list.append(el('div', { class: 'muted' }, 'No folders here'));
    for (const e of (r.entries || []).filter((x) => x.dir)) {
      list.append(
        el('div', { class: 'file-row', onclick: () => browseFolder(e.path) },
          el('span', { class: 'file-ico' }, '📁'),
          el('span', { class: 'file-name' }, e.name),
          el('span', { class: 'file-meta' }, ''))
      );
    }
    if (r.truncated) list.append(el('div', { class: 'muted' }, `… ${r.total - 3000} more entries not shown`));
    folderError('');
  } catch (e) {
    folderError(e.message);
  }
}

function openFolderPicker() {
  if (adminOnly()) return;
  const c = current();
  setPlusMenu(false);
  folderError('');
  $('#folder-new').value = '';
  browseFolder(c?.workdir || '');
  openModal('#dlg-folder');
}

async function pickWorkdir() {
  const p = $('#folder-path').value.trim();
  if (!p) return folderError('Type or browse to a folder first');
  try {
    await setChatOption({ workdir: p });
    $('#dlg-folder').close();
    renderChatOptions();
    toast(`Working folder: ${p}`);
  } catch (e) {
    folderError(e.message);
  }
}

async function createFolder() {
  const name = $('#folder-new').value.trim();
  const base = $('#folder-path').value.trim();
  if (!name) return folderError('Type a name for the new folder');
  if (!base) return folderError('Open a parent folder first');
  try {
    const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    const r = await api('/fs/mkdir', { method: 'POST', body: { path: `${base.replace(/[\\/]+$/, '')}${sep}${name}` } });
    $('#folder-new').value = '';
    await browseFolder(r.path);
  } catch (e) {
    folderError(e.message);
  }
}

/* ───────────────────────── Chat file manager ───────────────────────── */
const fileBrowser = { path: '', root: '', parent: null };

function filesError(msg) {
  const pre = $('#files-error');
  pre.textContent = msg || '';
  pre.classList.toggle('hidden', !msg);
}

const fmtSize = (n) => {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

function fileUrl(p, download = true) {
  const q = `path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;
  return `/api/conversations/${state.currentId}/fs/raw?${q}`;
}

// URL that streams a folder as a .zip download (server builds it in memory).
function folderZipUrl(p) {
  return `/api/conversations/${state.currentId}/fs/zip?path=${encodeURIComponent(p)}`;
}

// Used by markdown.js to turn local paths in model output into URLs the
// browser can load (inline for images, download=1 for links).
window.conversationFileUrl = (p, download = false) => fileUrl(p, download);

async function browseFiles(p) {
  if (!state.currentId) return;
  try {
    const r = await api(`/conversations/${state.currentId}/fs${p ? `?path=${encodeURIComponent(p)}` : ''}`);
    fileBrowser.path = r.path;
    fileBrowser.root = r.root;
    fileBrowser.parent = r.parent;
    $('#files-path').value = r.path;
    $('#files-count').textContent = `${r.entries.length}${r.truncated ? ` of ${r.total}` : ''} items`;
    const list = $('#files-list');
    list.innerHTML = '';
    for (const e of r.entries) {
      const row = el('div', { class: 'file-row' },
        el('span', { class: 'file-ico' }, e.dir ? '📁' : '📄'),
        el('span', {
          class: 'file-name', title: e.path,
          onclick: e.dir ? () => browseFiles(e.path) : () => previewFile(e)
        }, e.name),
        el('span', { class: 'file-meta' }, e.dir ? '' : fmtSize(e.size)),
        el('span', { class: 'file-acts' },
          e.dir
            ? el('a', { class: 'btn btn-ghost icon-btn', href: folderZipUrl(e.path), download: `${e.name}.zip`, title: `Download "${e.name}" folder as .zip` }, '⬇')
            : el('a', { class: 'btn btn-ghost icon-btn', href: fileUrl(e.path), download: e.name, title: 'Download file' }, '⬇'),
          el('button', { class: 'btn btn-ghost icon-btn', title: 'Rename', onclick: () => renameEntry(e, row) }, '✎'),
          el('button', { class: 'btn btn-ghost icon-btn', title: 'Delete', onclick: (ev) => deleteEntry(e, ev.currentTarget) }, '🗑'))
      );
      list.append(row);
    }
    if (!r.entries.length) list.append(el('div', { class: 'muted' }, 'Empty folder'));
    filesError('');
  } catch (e) {
    filesError(e.message);
  }
}

const PREVIEW_IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const PREVIEW_MD = /\.(md|markdown)$/i;
const PREVIEW_HTML = /\.(html?|xhtml)$/i;

async function previewFile(e) {
  filesError('');
  const list = $('#files-list');
  const sizeSpan = el('span', { class: 'muted' }, fmtSize(e.size));
  const head = (extra = [], cv = null) =>
    el('div', { class: 'row file-preview-head' },
      el('strong', {}, e.name),
      sizeSpan,
      ...extra,
      el('a', { class: 'btn btn-ghost icon-btn', href: fileUrl(e.path), title: 'Download' }, '⬇'),
      el('button', {
        class: 'btn',
        onclick: () => {
          if (cv && typeof cv.isDirty === 'function' && cv.isDirty() && !confirm('You have unsaved changes. Discard and go back?')) return;
          browseFiles(fileBrowser.path);
        }
      }, '⬅ back')
    );
  list.innerHTML = '';

  // Images are served inline by the raw endpoint; render them directly instead
  // of reading the binary through the JSON API.
  if (PREVIEW_IMAGE.test(e.path)) {
    list.append(
      el('div', { class: 'file-preview' }, head(),
        el('div', { class: 'file-preview-image' },
          el('img', { src: fileUrl(e.path, false), alt: e.name, loading: 'lazy' }))
      )
    );
    return;
  }

  try {
    const r = await api(`/conversations/${state.currentId}/fs/raw?path=${encodeURIComponent(e.path)}`);
    if (r.text == null) return browseFiles(fileBrowser.path);

    const saveHandler = async (newCode) => {
      await api(`/conversations/${state.currentId}/fs/write`, {
        method: 'POST',
        body: { path: e.path, content: newCode }
      });
      r.text = newCode;
      e.size = new Blob([newCode]).size;
      sizeSpan.textContent = fmtSize(e.size);
    };

    const isMd = PREVIEW_MD.test(e.path);
    const isHtml = PREVIEW_HTML.test(e.path);
    if (!isMd && !isHtml) {
      // Code / plain text: scrollable code view with syntax coloring,
      // line numbers, copy button, editing support, and JSON formatting.
      const cv = typeof createCodeViewer === 'function'
        ? createCodeViewer(r.text, e.name, { onSave: saveHandler })
        : null;
      if (cv) {
        list.append(
          el('div', { class: 'file-preview' },
            head(cv.badges, cv),
            cv.container
          )
        );
      } else {
        list.append(
          el('div', { class: 'file-preview' }, head(),
            el('pre', { class: 'file-preview-body' }, r.text))
        );
      }
      return;
    }

    // Markdown and HTML get a rendered preview plus the raw source/editor, switchable.
    const cv = typeof createCodeViewer === 'function'
      ? createCodeViewer(r.text, e.name, { onSave: saveHandler })
      : null;
    const codeView = cv ? cv.container : el('pre', { class: 'file-preview-body' }, r.text);
    const content = el('div', { class: 'file-preview-content' });
    const tabs = el('div', { class: 'file-view-tabs' });
    let mode = 'preview';
    const paint = () => {
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
      if (cv) cv.badges.forEach((b) => b.classList.toggle('hidden', mode !== 'code'));
      content.innerHTML = '';
      if (mode === 'code') {
        content.append(codeView);
        return;
      }
      const textToPreview = cv ? cv.getCode() : r.text;
      if (isMd) {
        const md = el('div', { class: 'md-preview' });
        md.innerHTML = renderMarkdown(textToPreview);
        content.append(md);
      } else {
        // No allow-scripts and no allow-same-origin: a preview must not be able
        // to run code against the app's origin.
        content.append(
          el('iframe', {
            class: 'html-preview',
            sandbox: '',
            referrerpolicy: 'no-referrer',
            title: `${e.name} preview`,
            srcdoc: textToPreview
          })
        );
      }
    };
    for (const [m, label] of [['preview', 'Preview'], ['code', 'Code']]) {
      tabs.append(el('button', {
        class: `btn sm${m === 'preview' ? ' on' : ''}`,
        'data-mode': m,
        onclick: () => {
          mode = m;
          paint();
        }
      }, label));
    }
    paint();
    list.append(el('div', { class: 'file-preview' }, head([tabs, ...(cv ? cv.badges : [])], cv), content));
  } catch (err) {
    filesError(err.message);
  }
}

async function renameEntry(e, row) {
  const nameEl = $('.file-name', row);
  const input = el('input', { class: 'file-rename', value: e.name, type: 'text', spellcheck: 'false' });
  nameEl.replaceWith(input);
  input.focus();
  const dot = e.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 && !e.dir ? dot : e.name.length);
  const commit = async () => {
    const name = input.value.trim();
    if (!name || name === e.name) return browseFiles(fileBrowser.path);
    try {
      await api(`/conversations/${state.currentId}/fs/rename`, { method: 'POST', body: { from: e.path, to: parentDirOf(e.path) + name } });
      await browseFiles(fileBrowser.path);
    } catch (err) {
      filesError(err.message);
      browseFiles(fileBrowser.path);
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') browseFiles(fileBrowser.path);
  });
  input.addEventListener('blur', () => { if (input.isConnected) commit(); });
}

/** Parent directory with a trailing separator. */
function parentDirOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? '' : p.slice(0, i + 1);
}

async function deleteEntry(e, btn) {
  // Two-step confirm, so nothing vanishes on a stray click.
  if (btn.dataset.armed) {
    try {
      await api(`/conversations/${state.currentId}/fs/delete`, { method: 'POST', body: { path: e.path } });
      await browseFiles(fileBrowser.path);
    } catch (err) {
      filesError(err.message);
    }
    return;
  }
  btn.dataset.armed = '1';
  btn.textContent = 'sure?';
  btn.classList.add('danger');
  setTimeout(() => {
    if (!btn.isConnected) return;
    delete btn.dataset.armed;
    btn.textContent = '🗑';
    btn.classList.remove('danger');
  }, 3000);
}

function pathJoin(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

async function mkdirHere() {
  const input = $('#files-new');
  const name = input.value.trim();
  if (!name) {
    filesError('Type a name for the new folder first');
    input.focus();
    return;
  }
  try {
    await api(`/conversations/${state.currentId}/fs/mkdir`, { method: 'POST', body: { path: pathJoin(fileBrowser.path, name) } });
    input.value = '';
    filesError('');
    await browseFiles(fileBrowser.path);
  } catch (e) {
    filesError(e.message);
  }
}

async function uploadHere(file) {
  const b64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new Error('Could not read the file'));
    fr.readAsDataURL(file);
  });
  try {
    await api(`/conversations/${state.currentId}/fs/upload`, {
      method: 'POST',
      body: { path: pathJoin(fileBrowser.path, file.name), content_base64: b64 }
    });
    toast(`Uploaded ${file.name}`);
    await browseFiles(fileBrowser.path);
  } catch (e) {
    filesError(e.message);
  }
}

function openFileManager() {
  if (!state.currentId) return toast('Start a chat first', true);
  setPlusMenu(false);
  filesError('');
  browseFiles('');
  openModal('#dlg-files');
}

/* ───────────────────────── Per-message file changes ─────────────────────────
 * Every turn records the text files its tools changed (see server
 * fileChanges.js). They are listed under the user message that started the
 * turn, with a comparison dialog and a per-file revert.
 */
async function fetchFileChanges(convId) {
  try {
    const r = await api(`/conversations/${convId}/fs/changes`);
    return Array.isArray(r.changes) ? r.changes : [];
  } catch {
    return [];
  }
}

function fileChangeList(changes) {
  const box = el('details', { class: 'file-changes' },
    el('summary', {},
      el('span', { class: 'file-changes-ico' }, '📝'),
      `${changes.length} file${changes.length === 1 ? '' : 's'} changed`
    )
  );
  const list = el('div', { class: 'file-changes-list' });
  for (const c of changes) {
    const stats = [];
    if (c.added) stats.push(`+${c.added}`);
    if (c.removed) stats.push(`−${c.removed}`);
    const reverted = !!c.reverted_at;
    list.append(
      el('div', { class: `file-change-row${reverted ? ' is-reverted' : ''}` },
        el('span', { class: 'file-change-name', title: c.path }, c.rel_path || c.path),
        el('span', { class: 'file-change-stats' }, reverted ? 'reverted' : stats.join(' ') || 'changed'),
        el('button', { class: 'btn btn-ghost sm', onclick: () => openDiff(c.id) }, 'Compare'),
        reverted
          ? null
          : el('button', {
              class: 'btn btn-danger sm',
              title: 'Put this file back the way it was before this message',
              onclick: (e) => revertFileChange(c, e.currentTarget)
            }, 'Revert')
      )
    );
  }
  box.append(list);
  return box;
}

async function openDiff(changeId) {
  if (!state.currentId) return;
  try {
    const r = await api(`/conversations/${state.currentId}/fs/changes/${changeId}`);
    $('#diff-title').textContent = r.rel_path || r.path;
    const added = r.diff.filter((o) => o.t === 'add').length;
    const removed = r.diff.filter((o) => o.t === 'del').length;
    $('#diff-stats').textContent = `${added ? `+${added}` : ''}${removed ? ` −${removed}` : ''}`.trim() || 'no textual change';
    const body = $('#diff-body');
    body.innerHTML = '';
    for (const op of r.diff) {
      body.append(
        el('div', { class: `diff-line ${op.t}` },
          el('span', { class: 'diff-sign' }, op.t === 'add' ? '+' : op.t === 'del' ? '−' : ' '),
          el('span', { class: 'diff-text' }, op.text === '' ? ' ' : op.text)
        )
      );
    }
    const btn = $('#btn-diff-revert');
    btn.classList.toggle('hidden', !!r.reverted_at);
    btn.disabled = false;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/conversations/${state.currentId}/fs/changes/${changeId}/revert`, { method: 'POST' });
        toast('File reverted');
        await refreshFileChanges();
        $('#dlg-diff').close();
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    };
    openModal('#dlg-diff');
  } catch (e) {
    toast(e.message, true);
  }
}

async function revertFileChange(c, btn) {
  // Two-step confirm: reverting overwrites (or removes) a real file.
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'sure?';
    setTimeout(() => {
      if (!btn.isConnected) return;
      delete btn.dataset.armed;
      btn.textContent = 'Revert';
    }, 3000);
    return;
  }
  btn.disabled = true;
  try {
    await api(`/conversations/${state.currentId}/fs/changes/${c.id}/revert`, { method: 'POST' });
    toast('File reverted');
    await refreshFileChanges();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

async function refreshFileChanges() {
  if (!state.currentId) return;
  state.fileChanges = await fetchFileChanges(state.currentId);
  renderMessages();
}

/* ───────────────────────── Streaming chat ─────────────────────────
 * Generation runs on the server (see runManager / POST /api/chat). The browser
 * is only a viewer: it attaches to GET /api/chat/stream, and can detach and
 * re-attach (switching chats, opening links, reloading) without stopping the
 * generation. `run` holds the live viewer state for the conversation currently
 * on screen; the server-side run keeps going regardless.
 */
const TYPING = '<span class="typing"><i></i><i></i><i></i></span>';

// Conversation ids the server told us are generating (sidebar badges).
const runningIds = new Set();

// When each of those runs actually started (server clock, epoch ms). Kept apart
// from the live viewer so a refresh or a chat switch resumes the elapsed time
// instead of restarting it at 0.
const runStartedAt = new Map();

function setRunningBadge(id, on) {
  const changed = on ? runningIds.add(id) : runningIds.delete(id);
  if (!on) runStartedAt.delete(id);
  if (changed) { renderConvList(); updateAppBusy(); }
}

async function refreshRunning() {
  try {
    const r = await api('/chat/running');
    const runs = r.runs || [];
    const ids = new Set(runs.map((x) => x.conversation_id));
    for (const x of runs) if (x.started_at) runStartedAt.set(x.conversation_id, x.started_at);
    for (const id of [...runningIds]) {
      if (!ids.has(id)) { runningIds.delete(id); runStartedAt.delete(id); }
    }
    for (const id of ids) runningIds.add(id);
    renderConvList();
    updateAppBusy();
    // Resume watching if the chat now on screen is generating and we're not.
    if (ids.has(state.currentId) && !run) attachToRun(state.currentId, 0, runStartedAt.get(state.currentId));
  } catch {
    /* server not reachable */
  }
}

// Live viewer state for the conversation on screen (null when idle).
let run = null;

async function sendMessage(regenerate = false) {
  if (state.streaming) return;
  if (!state.currentId) await newConversation();
  const input = $('#input');
  let content = input.value.trim();
  const image = pendingImage();
  // Images go to the model as a vision image only. Non-image files are saved
  // into the working folder and referenced by path. Uploading the image too
  // (and telling the model its path) made it run Python/file tools to "read"
  // a picture it can already see — so keep images out of the file path here.
  const files = state.attachments.filter((a) => a.data && a.kind !== 'image');
  if (!regenerate && !content && !image && !files.length) return;

  if (!regenerate) {
    if (files.length) {
      if (!state.currentId) await newConversation();
      toast(`Saving ${files.length} file${files.length === 1 ? '' : 's'}…`);
      let saved;
      try {
        saved = await uploadAttachments();
      } catch (e) {
        toast(e.message, true);
        return;
      }
      const where = saved.map((f) => f.path).join('\n');
      content = [content, `I attached ${saved.length} file(s), saved here:\n${where}`].filter(Boolean).join('\n\n');
    }
  }

  // Ask the server to record the user message and start the run.
  const convId = state.currentId;
  let ack;
  try {
    ack = await api('/chat', {
      method: 'POST',
      body: {
        conversation_id: convId,
        content,
        image_url: image || undefined,
        regenerate,
        use_tools: $('#chk-tools').checked,
        model: $('#sel-model').value || undefined,
        reasoning_effort: $('#sel-effort')?.value || undefined
      }
    });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  // The user row (and any truncation) now lives in the DB — resync from it.
  clearAttachments();
  input.value = '';
  autoresize();
  try {
    const fresh = await api(`/conversations/${convId}`);
    if (convId === state.currentId) {
      state.messages = fresh.messages || [];
      state.fileChanges = await fetchFileChanges(convId);
      if (convId === state.currentId) renderMessages();
    }
  } catch {
    /* keep optimistic view */
  }
  if (ack && ack.started_at) runStartedAt.set(convId, ack.started_at);
  attachToRun(convId, 0, ack && ack.started_at);
}

/**
 * Build (or rebuild) the live assistant bubble for a run and stream into it.
 * `lastEventId` resumes after the given server event sequence (0 = from start);
 * `startedAt` is the server's start time, so the elapsed clock survives a
 * refresh instead of restarting when the viewer re-attaches.
 */
function attachToRun(conversationId, lastEventId = 0, startedAt = 0) {
  if (conversationId !== state.currentId) return; // stale attach
  detachRun();

  const node = el('div', { class: 'msg assistant' });
  node.append(el('div', { class: 'msg-avatar' }, '🤖'));
  const body = el('div', { class: 'msg-body' });
  const bubble = el('div', { class: 'bubble' });
  const contentEl = el('div', { class: 'content' });
  contentEl.innerHTML = TYPING;
  bubble.append(contentEl);
  body.append(bubble);
  const live = el('div', { class: 'msg-stats live' });
  body.append(live);
  node.append(body);
  $('#messages').append(node);

  run = {
    conversationId,
    es: null,
    lastEventId: lastEventId || 0,
    node,
    bubble,
    live,
    contentEl,
    textBuf: '',
    currentTextEl: contentEl,
    activeThinking: null,
    gotText: false,
    startedAt: Number(startedAt) || runStartedAt.get(conversationId) || Date.now(),
    // Last event id that belongs to the backlog replayed on attach (see the
    // 'hello' event). Replayed tokens are not live generation speed.
    replayUntil: 0,
    firstTokenAt: null,
    // Time spent actually generating tokens (reasoning + answer), accumulated in
    // small increments so tool-execution and re-prefill gaps are excluded. This
    // keeps the live tok/s accurate across multi-round tool turns.
    genMs: 0,
    lastTokenAt: 0,
    outChars: 0,
    reasonChars: 0,
    stats: null,
    timer: null
  };

  // Live ⏱ tok/s readout. We don't know the real token count mid-stream, so
  // estimate from characters (~4 chars/token) — the accurate figure arrives in
  // the final 'stats' event from the server's own counters. Speed is measured
  // only over intervals where tokens are actively arriving: when a tool runs or
  // the server re-prefills there is a large gap with no tokens, and counting
  // that dead time would make the rate collapse.
  run.timer = setInterval(() => {
    if (!run) return;
    const secs = Math.max(0, (Date.now() - run.startedAt) / 1000);
    const bits = [`⏱ ${fmtDuration(secs * 1000)}`];
    if (run.genMs > 400) {
      const outTokens = (run.outChars + (run.reasonChars || 0)) / 4;
      bits.push(`⚡ ${(outTokens / (run.genMs / 1000)).toFixed(1)} tok/s gen (est.)`);
    }
    if (run.live.dataset.notice) bits.push(`· ${run.live.dataset.notice}`);
    run.live.textContent = bits.join('  ·  ');
  }, 250);

  setStreaming(true);
  scrollToBottomIfFollowing();
  openRunStream(run);
}

// A gap larger than this between two streamed tokens is treated as "not
// generating" (tool execution, re-prefill, or a pause) and excluded from the
// generation-time total, so the live tok/s reflects actual decode speed.
const CONTINUOUS_GAP_MS = 700;

/** True while the stream is still replaying events the server had buffered.
 *  Those all arrive at once, so counting them as decode speed would report an
 *  impossible rate right after a reload or a reconnect. */
function isReplay(r) {
  return r.replayUntil > 0 && r.lastEventId <= r.replayUntil;
}

/** Record a streamed token (reasoning or answer) toward generation time. */
function noteToken(r) {
  const now = Date.now();
  if (!r.firstTokenAt) r.firstTokenAt = now;
  if (r.lastTokenAt) {
    const dt = now - r.lastTokenAt;
    if (dt <= CONTINUOUS_GAP_MS) r.genMs += dt;
  }
  r.lastTokenAt = now;
}

function openRunStream(r) {  const url = `/api/chat/stream?conversation_id=${r.conversationId}&last_event_id=${r.lastEventId}`;
  const es = new EventSource(url);
  r.es = es;
  for (const name of ['delta', 'reasoning', 'notice', 'tool_generating', 'tool_call', 'tool_result', 'tool_cancelled', 'tool_denied', 'tool_unavailable', 'file_created', 'compressed', 'title', 'stats', 'done', 'error', 'resync', 'idle']) {
    es.addEventListener(name, (e) => {
      // Track our cursor so a reconnect resumes in the right place. Events
      // without an id (resync/idle) must not zero the cursor.
      if (e.lastEventId) {
        const id = Number(e.lastEventId);
        if (Number.isFinite(id) && run === r) run.lastEventId = id;
      }
      handleRunEvent(r, name, e.data ? JSON.parse(e.data) : {});
    });
  }
  // The server tells us where the replayed backlog ends (and the true start
  // time) before sending it.
  es.addEventListener('hello', (e) => {
    let d = {};
    try { d = JSON.parse(e.data); } catch { /* ignore */ }
    if (Number.isFinite(Number(d.seq))) r.replayUntil = Number(d.seq);
    if (Number(d.started_at)) r.startedAt = Number(d.started_at);
  });
  // A dropped connection is fine — the server run continues. Reconnect after a
  // beat, resuming from the last event id we processed.
  es.onerror = () => {
    if (run !== r) return;
    es.close();
    setTimeout(() => {
      if (run === r) openRunStream(r);
    }, 1200);
  };
}

/** Seal the active thinking box: fold it away with a character count. */
function sealThinking(r) {
  const t = r.activeThinking;
  if (!t) return;
  const sum = t.box.querySelector('summary');
  if (sum) sum.textContent = `🧠 Thinking (${t.buf.length.toLocaleString()} characters)`;
  // Reasoning is painted on an animation frame, but a burst can be sealed
  // before that frame runs (the answer or a tool call arrives in the same
  // tick). Paint the final text now, or the box would claim N characters and
  // open to an empty body.
  t.body.innerHTML = renderMarkdown(t.buf);
  t.box.removeAttribute('open');
  r.activeThinking = null;
}
/** Seal the active text block: drop the typing cursor; remove it if empty. */
function sealText(r) {
  if (r.currentTextEl) {
    if (r.textBuf) r.currentTextEl.innerHTML = renderMarkdown(r.textBuf);
    else r.currentTextEl.remove();
  }
  r.currentTextEl = null;
  r.textBuf = '';
}
function renderThinking(r) {
  const t = r.activeThinking;
  if (!t) return;
  const nearBottom = t.body.scrollHeight - t.body.scrollTop - t.body.clientHeight < 80;
  t.body.innerHTML = renderMarkdown(t.buf);
  if (nearBottom) t.body.scrollTop = t.body.scrollHeight;
}
function queueThinkingRender(r) {
  if (!r.activeThinking || r.activeThinking.queued) return;
  r.activeThinking.queued = true;
  requestAnimationFrame(() => {
    if (r.activeThinking) r.activeThinking.queued = false;
    renderThinking(r);
  });
}

function handleRunEvent(r, event, d) {
  if (run !== r) return;
  const bubble = r.bubble;
  if (event === 'delta') {
    if (!r.gotText) r.gotText = true;
    sealThinking(r);
    if (!r.currentTextEl) {
      r.currentTextEl = el('div', { class: 'content' });
      bubble.append(r.currentTextEl);
    }
    if (!isReplay(r)) {
      r.outChars += (d.text || '').length;
      noteToken(r);
    }
    r.textBuf += d.text || '';
    r.currentTextEl.innerHTML = renderMarkdown(r.textBuf) + TYPING;
    scrollToBottomIfFollowing();
  } else if (event === 'notice') {
    // Notices are folded into the live line so the transcript stays clean.
    r.live.dataset.notice = d.message || '';
  } else if (event === 'compressed') {
    const b = d.before_tokens || 0;
    const a = d.after_tokens || 0;
    r.live.dataset.notice = `Context compressed: ${b.toLocaleString()} → ${a.toLocaleString()} tokens`;
  } else if (event === 'title') {
    // AI generated a title for the first turn — update the header + sidebar.
    applyTitle(d.title);
  } else if (event === 'reasoning') {
    // Reasoning tokens are the first thing a thinking model generates, so they
    // seed the live speed timer and count toward the estimated rate — unless
    // they are being replayed from the backlog.
    if (!isReplay(r)) {
      r.reasonChars += (d.text || '').length;
      noteToken(r);
    }
    sealText(r);
    if (!r.activeThinking) {
      const box = el('details', { class: 'thinking', open: 'open' }, el('summary', {}, '🧠 Thinking…'));
      const bodyEl = el('div', { class: 'thinking-body' });
      box.append(bodyEl);
      bubble.append(box);
      r.activeThinking = { box, body: bodyEl, buf: '', queued: false };
    }
    r.activeThinking.buf += d.text || '';
    queueThinkingRender(r);
    scrollToBottomIfFollowing();
  } else if (event === 'tool_unavailable') {
    sealThinking(r);
    sealText(r);
    const chip = buildToolChip({ id: d.id, name: d.name, status: 'unavailable' });
    bubble.append(chip);
    scrollToBottomIfFollowing();
  } else if (event === 'tool_generating') {
    // The model is still streaming this tool call's arguments (can take a long
    // time for big write/edit payloads) — show the chip with live progress.
    sealThinking(r);
    sealText(r);
    let chip = findChip(bubble, d.id);
    if (!chip) {
      chip = buildToolChip({ id: d.id, name: d.name || 'tool', status: 'running' });
      bubble.append(chip);
    }
    const nameEl = chip.querySelector('.tool-name');
    if (nameEl && d.name && nameEl.textContent === 'tool') nameEl.textContent = d.name;
    const status = chip.querySelector('.tool-status');
    if (status) status.textContent = `generating… ${fmtTokens(d.args_chars || 0)} chars`;
    scrollToBottomIfFollowing();
  } else if (event === 'tool_call') {
    sealThinking(r);
    sealText(r);
    // Reuse the chip from 'tool_generating' if we have one; it's the same call.
    const argsText = JSON.stringify(d.arguments ?? {}, null, 2);
    let chip = findChip(bubble, d.id);
    if (chip) {
      const nameEl = chip.querySelector('.tool-name');
      if (nameEl && d.name) nameEl.textContent = d.name;
      let argsBlock = chip.querySelector('.tool-args');
      if (!argsBlock) {
        argsBlock = el('div', { class: 'tool-args' }, el('pre', {}));
        chip.insertBefore(argsBlock, chip.querySelector('.tool-out'));
      }
      const pre = argsBlock.querySelector('pre');
      if (pre && pre.textContent !== argsText) pre.textContent = argsText;
      applyToolState(chip, { status: 'running' });
    } else {
      chip = buildToolChip({
        id: d.id,
        name: d.name,
        argsText,
        status: 'running'
      });
      bubble.append(chip);
    }
    scrollToBottomIfFollowing();
  } else if (event === 'tool_denied') {
    const chip = findChip(bubble, d.id);
    if (chip) applyToolState(chip, { status: 'denied' });
  } else if (event === 'tool_cancelled') {
    const chip = findChip(bubble, d.id);
    if (chip) applyToolState(chip, { status: 'cancelled', durationMs: d.duration_ms });
  } else if (event === 'tool_result') {
    const chip = findChip(bubble, d.id);
    if (chip && !chip.classList.contains('is-cancelled')) {
      applyToolState(chip, {
        status: d.cancelled ? 'cancelled' : 'done',
        durationMs: d.duration_ms,
        resultText: typeof d.result === 'string' ? d.result : JSON.stringify(d.result, null, 2)
      });
    }
  } else if (event === 'file_created') {
    appendLiveFile(bubble, r, d);
    scrollToBottomIfFollowing();
  } else if (event === 'stats') {
    r.stats = d;
    r.live.textContent = statsText({
      duration_ms: d.duration_ms,
      tg_tok_s: d.tg_tok_s,
      pp_tok_s: d.pp_tok_s,
      prompt_tokens: d.prompt_tokens,
      completion_tokens: d.completion_tokens
    });
    if (d.context_tokens) updateContextMeter(d.context_tokens, d.context_window);
  } else if (event === 'done') {
    finishRun(r, d);
  } else if (event === 'error') {
    finishRun(r, { error: d.message || 'stream error' });
  } else if (event === 'resync') {
    // Buffer gap after a long disconnect — reload persisted state and re-attach
    // right after the oldest event the server still holds.
    reloadAndReattach(r.conversationId, d.oldest);
  } else if (event === 'idle') {
    // Nothing is running (e.g. we attached late). Drop the live bubble quietly.
    detachRun();
    reloadConversation(state.currentId);
  }
}

function findChip(bubble, id) {
  return [...bubble.querySelectorAll('.tool-chip')].reverse().find((c) => c.dataset.callId === id);
}

async function finishRun(r, d) {
  const convId = r.conversationId;
  setRunningBadge(convId, false);
  if (run !== r) return;
  detachRun();
  if (d.error) toast(d.error, true);
  await reloadConversation(convId);
  await loadConversations();
  updateChatSub();
  updateContextMeterFromMessages();
  scrollBottom(true);
}

/** Reload messages for a conversation from the DB and re-render. */
async function reloadConversation(convId) {
  if (convId !== state.currentId) return;
  try {
    const fresh = await api(`/conversations/${convId}`);
    // The user may have switched conversations while the fetch was in flight.
    // Re-check before painting — otherwise a slow response for the OLD chat
    // overwrites the NEW chat currently on screen (message bleed).
    if (convId !== state.currentId) return;
    state.messages = fresh.messages || [];
    state.fileChanges = await fetchFileChanges(convId);
    if (convId !== state.currentId) return;
    renderMessages();
  } catch {
    /* ignore */
  }
}

/**
 * After a buffer gap: reload persisted state, then resume if still running.
 * `oldest` is the first event the server still retains, so resuming from
 * `oldest - 1` continues without re-rendering the truncated prefix.
 */
async function reloadAndReattach(convId, oldest = 0) {
  if (convId !== state.currentId) return;
  const wasLastId = run ? run.lastEventId : 0;
  const resumeFrom = Number(oldest) > 0 ? Number(oldest) - 1 : wasLastId;
  detachRun();
  await reloadConversation(convId);
  if (runningIds.has(convId)) attachToRun(convId, resumeFrom, runStartedAt.get(convId));
}

/** Tear down the live viewer (does NOT stop the server-side run). */
function detachRun() {
  if (!run) return;
  if (run.es) {
    try { run.es.close(); } catch { /* ignore */ }
  }
  clearInterval(run.timer);
  if (run.node) run.node.remove();
  run = null;
  setStreaming(false);
}

/** Stop the server-side generation for the conversation on screen. */
async function stopStreaming() {
  const convId = state.currentId;
  try {
    await api('/chat/stop', { method: 'POST', body: { conversation_id: convId } });
  } catch (e) {
    toast(e.message, true);
  }
  // The server emits 'done' which finishes the viewer; if nothing is running,
  // make sure the UI returns to idle anyway.
  setTimeout(() => {
    if (run && run.conversationId === convId) {
      detachRun();
      setRunningBadge(convId, false);
    }
  }, 1500);
}

function setStreaming(on) {
  state.streaming = on;
  $('#btn-send').classList.toggle('hidden', on);
  $('#btn-stop').classList.toggle('hidden', !on);
  $('#input').disabled = false; // input stays usable; you can queue a new chat meanwhile
  updateAppBusy();
}

// The header spinner reflects ANY in-flight generation, not just the chat on
// screen — background chats (started here or elsewhere) keep it spinning too.
function updateAppBusy() {
  const busy = !!state.streaming || runningIds.size > 0;
  const sp = $('#app-spinner');
  if (sp) sp.classList.toggle('hidden', !busy);
}

/**
 * Find the user message that started this assistant turn.
 */
function priorUserMessage(m) {
  if (!m || m.role !== 'assistant') return null;
  return [...state.messages]
    .reverse()
    .find((x) => x.role === 'user' && x.id < m.id) || null;
}

/**
 * True when this assistant message is the final assistant response of its turn
 * (i.e. not followed by another assistant message in the same turn before a new user message).
 */
function isLastAssistantInTurn(m) {
  if (!m || m.role !== 'assistant') return false;
  const idx = state.messages.findIndex((x) => x.id === m.id);
  if (idx === -1) return true;
  for (let i = idx + 1; i < state.messages.length; i++) {
    const next = state.messages[i];
    if (next.role === 'user') break;
    if (next.role === 'assistant') return false;
  }
  return true;
}

/** True when an assistant reply exists after this user message. */
function hasReplyAfter(m) {
  return state.messages.some((x) => x.role === 'assistant' && x.id > m.id);
}

/**
 * Re-answer one user message: drop everything after it, then run the turn
 * again without adding a second copy of the question. The server only removes
 * a trailing assistant row that sits *after* the last user message, so an older
 * turn's reply is never deleted by mistake.
 */
async function regenerateFrom(m) {
  if (state.streaming) return;
  if (!state.currentId) return;
  try {
    await api(`/conversations/${state.currentId}/truncate-after`, {
      method: 'POST',
      body: { message_id: m.id + 1 }
    });
    state.messages = state.messages.filter((x) => x.id <= m.id);
    state.fileChanges = (state.fileChanges || []).filter((c) => c.message_id <= m.id);
    renderMessages();
    await sendMessage(true);
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * Continue the last assistant reply without adding a visible user turn.
 * Returns true when the run was started, false when nothing was sent (so a
 * caller can restore its button instead of leaving it disabled).
 */
async function continueReply() {
  if (state.streaming) return false;
  if (!state.currentId) {
    toast('Open a chat first.', true);
    return false;
  }
  if (state.messages[state.messages.length - 1]?.role !== 'assistant') {
    toast('The last message is not a reply to continue.', true);
    return false;
  }
  const convId = state.currentId;
  let ack;
  try {
    ack = await api('/chat', {
      method: 'POST',
      body: {
        conversation_id: convId,
        continue: true,
        use_tools: $('#chk-tools').checked,
        model: $('#sel-model').value || undefined,
        reasoning_effort: $('#sel-effort')?.value || undefined
      }
    });
  } catch (e) {
    toast(e.message, true);
    return false;
  }
  if (ack && ack.started_at) runStartedAt.set(convId, ack.started_at);
  attachToRun(convId, 0, ack && ack.started_at);
  return true;
}

/** Download this conversation as Markdown (default) or JSON. */
async function exportConversation(format = 'md') {
  if (!state.currentId) {
    toast('Open a chat first.', true);
    return;
  }
  const kind = format === 'json' ? 'json' : 'md';
  try {
    const res = await fetch(`/api/conversations/${state.currentId}/export?format=${kind}`);
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
      if (res.status === 401) showLogin();
      throw new Error(msg);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = match ? match[1] : `chat.${kind}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported as ${kind === 'json' ? 'JSON' : 'Markdown'}`);
  } catch (e) {
    toast(`Export failed: ${e.message}`, true);
  }
}
/* ───────────────────────── Composer ───────────────────────── */
function autoresize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 220) + 'px';
}

/** The "+" menu holds attachments plus everything per-chat. */
function setPlusMenu(open) {
  const menu = $('#plus-menu');
  const willOpen = open ?? menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  $('#btn-plus').setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (!willOpen) $('#image-url-row').classList.add('hidden');
}

/* ── Attachments ──
 * Images go to the model as an image (vision). Anything else is saved into this
 * chat's working folder, and the model is told the path so its file tools can
 * open it. */
function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  box.classList.toggle('hidden', !state.attachments.length);
  for (const [i, a] of state.attachments.entries()) {
    box.append(
      el('div', { class: `att${a.uploading ? ' uploading' : ''}`, title: a.name },
        a.kind === 'image'
          ? el('img', { src: a.url || `data:${a.mime};base64,${a.data}`, alt: a.name })
          : el('span', { class: 'att-ico' }, '📄'),
        el('span', { class: 'att-name' }, a.name),
        el('span', { class: 'att-size' }, a.url ? 'image URL' : fmtSize(a.size)),
        el('button', { type: 'button', class: 'att-x', title: 'Remove', onclick: () => removeAttachment(i) }, '✕'))
    );
  }
}

function removeAttachment(i) {
  state.attachments.splice(i, 1);
  renderAttachments();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

/** Files from a paste event: `clipboardData.files`, or image blobs wrapped into
 *  File objects when the source only exposes clipboard items. */
function clipboardFiles(e) {
  const direct = [...(e.clipboardData?.files || [])];
  if (direct.length) return direct;
  const items = [...(e.clipboardData?.items || [])];
  const out = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    // Clipboard items often have no name; give the image a sensible one.
    const ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const name = blob.name || `pasted-image-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
    out.push(name === blob.name ? blob : new File([blob], name, { type: blob.type || 'image/png' }));
  }
  return out;
}

/** Read picked files; the first image becomes the vision image, and every file
 *  (images included) is also saved into the chat's working folder on send. */
async function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  for (const f of files) {
    if (f.size > MAX_UPLOAD_BYTES) {
      toast(`${f.name} is larger than ${fmtSize(MAX_UPLOAD_BYTES)}`, true);
      continue;
    }
    const data = await readAsBase64(f);
    const isImage = (f.type || '').startsWith('image/');
    state.attachments.push({ name: f.name, size: f.size, mime: f.type || 'application/octet-stream', kind: isImage ? 'image' : 'file', data });
  }
  renderAttachments();
  setPlusMenu(false);
  $('#input').focus();
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

/** The image that goes to a vision-capable model (the first image attached). */
function pendingImage() {
  const img = state.attachments.find((a) => a.kind === 'image' && (a.url || a.data));
  if (!img) return null;
  const value = img.url || `data:${img.mime};base64,${img.data}`;
  // Never send an empty image — that was the phantom "blank image" bug.
  return value && value !== 'data:;base64,' ? value : null;
}

/** Save the non-image attachments into the chat's working folder. Images are
 *  sent to the model as vision input instead, so they are not written to disk
 *  here (writing them made the model run code to read the file). */
async function uploadAttachments() {
  const files = state.attachments.filter((a) => a.data && a.kind !== 'image');
  const saved = [];
  for (const a of files) {
    a.uploading = true;
    renderAttachments();
    try {
      saved.push(await api(`/conversations/${state.currentId}/fs/upload`, {
        method: 'POST',
        body: { path: a.name, content_base64: a.data }
      }));
    } finally {
      a.uploading = false;
    }
  }
  renderAttachments();
  return saved;
}

function attachImageUrl() {
  const row = $('#image-url-row');
  row.classList.remove('hidden');
  $('#image-url-input').focus();
}

function commitImageUrl() {
  const url = $('#image-url-input').value.trim();
  $('#image-url-row').classList.add('hidden');
  $('#image-url-input').value = '';
  if (!url) return;
  state.attachments.push({ name: url.slice(0, 40), size: 0, mime: 'image/url', kind: 'image', url });
  renderAttachments();
  setPlusMenu(false);
}

function updateToolsHint() {
  const c = current();
  const off = chatOffServers(c);
  const isOff = (s) => off.has(s.name) || (!!s.builtin_key && off.has(s.builtin_key));
  const connected = state.mcp.filter((s) => s.enabled && s.status === 'connected');
  const visible = connected.filter((s) => !isOff(s));
  const n = visible.reduce((a, s) => a + s.tools.length, 0);
  const bits = [
    n
      ? `${n} tool${n === 1 ? '' : 's'} from ${visible.length} MCP server${visible.length === 1 ? '' : 's'}`
      : 'no MCP tools connected'
  ];
  const offNames = connected.filter(isOff).map((s) => s.name);
  if (offNames.length) bits.push(`${offNames.join(' + ')} off for this chat`);
  else if (c) bits.push(c.approval_mode === 'auto' ? 'auto-approve' : 'ask before changes');
  $('#hint-tools').textContent = bits.join(' · ');
}

/* ───────────────────────── Health ───────────────────────── */
async function refreshHealth() {
  const pill = $('#server-status');
  pill.innerHTML = '<span class="dot dot-grey"></span><span>checking…</span>';
  try {
    // Read-only ping: available to every signed-in user, unlike the admin-only
    // settings test (which accepts unsaved base URLs/keys).
    const r = await api('/settings/health');
    if (r.ok) {
      pill.innerHTML = `<span class="dot dot-green"></span><span>${r.modelCount} model${r.modelCount === 1 ? '' : 's'} online</span>`;
      if (r.models?.length) fillModelOptions(r.models);
    } else {
      pill.innerHTML = `<span class="dot dot-red"></span><span>server unreachable</span>`;
      pill.title = r.error || r.baseUrl || '';
    }
  } catch (e) {
    pill.innerHTML = '<span class="dot dot-red"></span><span>server unreachable</span>';
    pill.title = e.message;
  }
}

async function restartAiServer() {
  const btn = $('#btn-restart-server');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Restarting…';
  }
  const pill = $('#server-status');
  if (pill) {
    pill.innerHTML = '<span class="dot dot-grey"></span><span>restarting…</span>';
    pill.title = 'Restarting AI server…';
  }
  toast('Restarting AI server…');

  try {
    const res = await api('/settings/restart-ai-server', { method: 'POST' });
    toast(res.message || 'AI server restart initiated');
  } catch (e) {
    toast(`Failed to restart AI server: ${e.message}`, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Restart server';
    }
    refreshHealth();
    return;
  }

  // Poll /api/settings/health until the server is back online
  let attempts = 0;
  const maxAttempts = 45;
  const pollTimer = setInterval(async () => {
    attempts++;
    try {
      const r = await api('/settings/health');
      if (r && r.ok) {
        clearInterval(pollTimer);
        toast('AI server is online');
        refreshHealth();
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔄 Restart server';
        }
        return;
      }
    } catch {
      // still loading or restarting
    }
    if (attempts >= maxAttempts) {
      clearInterval(pollTimer);
      toast('AI server restart: still waiting for server to report online', true);
      refreshHealth();
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Restart server';
      }
    }
  }, 2000);
}

/* ───────────────────────── Settings modal ───────────────────────── */
function openModal(sel) {
  $(sel).showModal();
}

/* ───────────────────────── Command palette (Ctrl/Cmd+K) ───────────────────────── */
let paletteItems = [];
let paletteIndex = 0;

/** Everything the palette can run, plus a jump list of conversations. */
function paletteEntries() {
  const q = ($('#palette-input')?.value || '').trim().toLowerCase();
  const commands = [
    { group: 'Actions', icon: '＋', title: 'New chat', hint: 'Ctrl+N', run: () => newConversation() },
    { group: 'Actions', icon: '☰', title: 'Toggle sidebar', run: () => toggleSidebar() },
    { group: 'Actions', icon: '🌗', title: `Theme: ${storedTheme} (cycle)`, run: () => cycleTheme() },
    { group: 'Actions', icon: '⤓', title: 'Compact context now', run: () => compactNow() },
    { group: 'Actions', icon: '⚙', title: 'Open settings', run: () => $('#btn-open-settings').click() },
    { group: 'Actions', icon: '🔄', title: 'Restart AI server', run: () => restartAiServer() },
    { group: 'Actions', icon: '🎭', title: 'Open personas', run: () => { renderPromptList(); openModal('#dlg-prompts'); } },
    { group: 'Actions', icon: '🔌', title: 'Open MCP servers', run: () => { loadSettings(); loadMcp(); openModal('#dlg-settings'); scrollToSection('#mcp-section'); } },
    { group: 'Actions', icon: '⎋', title: 'Sign out', run: () => doLogout() }
  ];
  if (state.currentId) {
    if (state.messages[state.messages.length - 1]?.role === 'assistant') {
      commands.push({ group: 'Actions', icon: '▶', title: 'Continue the last reply', run: () => continueReply() });
    }
    commands.push(
      { group: 'Export', icon: '⤓', title: 'Export this chat as Markdown', run: () => exportConversation('md') },
      { group: 'Export', icon: '{ }', title: 'Export this chat as JSON', run: () => exportConversation('json') }
    );
  }
  const chats = state.conversations.map((c) => ({
    group: 'Chats',
    icon: '💬',
    title: c.title || 'Untitled',
    hint: `${c.message_count || 0} msg`,
    run: () => openConversation(c.id)
  }));
  const all = [...commands, ...chats];
  const matches = q
    ? all.filter((it) => it.title.toLowerCase().includes(q) || (it.group || '').toLowerCase().includes(q))
    : all;
  return matches.slice(0, 60);
}

function renderPalette() {
  paletteItems = paletteEntries();
  if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(0, paletteItems.length - 1);
  const list = $('#palette-list');
  list.innerHTML = '';
  if (!paletteItems.length) {
    list.append(el('div', { class: 'palette-empty' }, 'No matches'));
    return;
  }
  let lastGroup = null;
  paletteItems.forEach((item, i) => {
    if (item.group !== lastGroup) {
      list.append(el('div', { class: 'palette-group' }, item.group));
      lastGroup = item.group;
    }
    list.append(
      el(
        'div',
        {
          class: `palette-item${i === paletteIndex ? ' active' : ''}`,
          role: 'option',
          'aria-selected': i === paletteIndex ? 'true' : 'false',
          onclick: () => runPaletteItem(i)
        },
        el('span', { class: 'pi-ico' }, item.icon),
        el('span', { class: 'pi-title' }, item.title),
        item.hint ? el('span', { class: 'pi-hint' }, item.hint) : null
      )
    );
  });
  list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(i) {
  const item = paletteItems[i];
  if (!item) return;
  closePalette();
  // Let the dialog finish closing before an action opens another one.
  setTimeout(() => {
    try { item.run(); } catch (e) { toast(e.message, true); }
  }, 0);
}

function openPalette() {
  if (!state.currentUser) return;
  const dlg = $('#dlg-palette');
  if (!dlg || dlg.open) return;
  const input = $('#palette-input');
  input.value = '';
  paletteIndex = 0;
  renderPalette();
  dlg.showModal();
  input.focus();
}

function closePalette() {
  const dlg = $('#dlg-palette');
  if (dlg?.open) dlg.close();
}

function onPaletteKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (paletteItems.length) paletteIndex = (paletteIndex + 1) % paletteItems.length;
    renderPalette();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (paletteItems.length) paletteIndex = (paletteIndex - 1 + paletteItems.length) % paletteItems.length;
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPaletteItem(paletteIndex);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
}

function switchSettingsTab(tabId) {
  const dlg = $('#dlg-settings');
  if (!dlg) return;
  const targetId = tabId.endsWith('-section') ? tabId : `${tabId}-section`;
  const tabs = dlg.querySelectorAll('.settings-tab-btn');
  const panels = dlg.querySelectorAll('.settings-tab-panel');
  tabs.forEach(btn => {
    const isTarget = btn.dataset.tab === targetId;
    btn.classList.toggle('on', isTarget);
    btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  });
  panels.forEach(panel => {
    const isTarget = panel.id === targetId;
    panel.classList.toggle('hidden', !isTarget);
  });
  const body = dlg.querySelector('.modal-body');
  if (body) body.scrollTop = 0;
}

// Scroll an open dialog to one of its sections (used by the MCP shortcut).
function scrollToSection(sel) {
  const target = $(sel);
  if (!target) return;
  const panel = target.closest('.settings-tab-panel') || (target.classList.contains('settings-tab-panel') ? target : null);
  if (panel && panel.id) {
    switchSettingsTab(panel.id);
  }
  requestAnimationFrame(() => {
    const body = target.closest('.modal-body') || target.parentElement;
    body.scrollTop = Math.max(0, target.offsetTop - body.offsetTop - 12);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function saveSettings(e) {
  e?.preventDefault();
  if (adminOnly()) return;
  const body = {
    api_base_url: $('#set-api_base_url').value.trim(),
    model: $('#set-model').value.trim(),
    temperature: $('#set-temperature').value,
    max_tokens: $('#set-max_tokens').value,
    max_tool_rounds: $('#set-max_tool_rounds').value,
    reasoning_effort: $('#set-reasoning_effort').value,
    context_window: $('#set-context_window').value.trim(),
    context_compress_at: $('#set-context_compress_at').value.trim(),
    context_keep: $('#set-context_keep').value.trim(),
    builtin_shell_timeout: $('#set-builtin_shell_timeout').value.trim() || '120',
    aitemp_root: $('#set-aitemp_root').value.trim(),
    allow_registration: $('#set-allow_registration')?.checked ? '1' : '0'
  };
  const key = $('#set-api_key').value.trim();
  if (key) body.api_key = key;
  try {
    await api('/settings', { method: 'PUT', body });
    await loadSettings();
    toast('Settings saved');
    $('#dlg-settings').close();
  } catch (err) {
    toast(err.message, true);
  }
}

async function testConnection() {
  if (adminOnly()) return;
  const out = $('#test-result');
  out.classList.remove('hidden');
  out.textContent = 'Testing…';
  try {
    const r = await api('/settings/test', {
      method: 'POST',
      body: { api_base_url: $('#set-api_base_url').value.trim(), api_key: $('#set-api_key').value.trim() || undefined, model: $('#set-model').value.trim() }
    });
    out.textContent = `${r.ok ? '✅ reachable' : '❌ failed'}\nURL: ${r.baseUrl}/chat/completions\nHTTP ${r.status ?? '-'}${r.error ? '\n' + r.error : ''}${r.models ? `\nModels (${r.models.length}):\n` + r.models.join('\n') : ''}`;
    if (r.models?.length) fillModelOptions(r.models);
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
}

async function fetchModels() {
  if (adminOnly()) return;
  const hint = $('#models-hint');
  hint.textContent = 'Fetching…';
  try {
    const r = await api('/settings/models');
    fillModelOptions(r.models);
    hint.textContent = `${r.models.length} model(s) from ${r.baseUrl}`;
    if (r.models.length && !$('#set-model').value) $('#set-model').value = r.models[0];
  } catch (e) {
    hint.textContent = `❌ ${e.message}`;
  }
}

/* ───────────────────────── Prompts modal ───────────────────────── */
let editingPromptId = null;

function renderPromptList() {
  const list = $('#prompt-list');
  list.innerHTML = '';
  if (!state.prompts.length) {
    list.append(el('div', { class: 'muted' }, 'No prompts yet.'));
    return;
  }
  for (const p of state.prompts) {
    list.append(
      el('div', { class: 'list-card' },
        el('div', { class: 'lc-main' },
          el('div', { class: 'lc-title' }, p.name, p.is_default ? el('span', { class: 'badge default' }, 'default') : null),
          el('div', { class: 'lc-sub' }, (p.description ? p.description + ' — ' : '') + p.content)
        ),
        el('div', { class: 'lc-actions' },
          el('button', { class: 'btn', onclick: () => editPrompt(p) }, 'edit'),
          p.is_default ? null : el('button', { class: 'btn', onclick: () => makeDefaultPrompt(p.id) }, 'make default'),
          el('button', { class: 'btn btn-danger', onclick: () => deletePrompt(p.id) }, 'delete')
        )
      )
    );
  }
}

function editPrompt(p) {
  editingPromptId = p.id;
  $('#prompt-editor-title').textContent = `Edit: ${p.name}`;
  $('#p-name').value = p.name;
  $('#p-desc').value = p.description || '';
  $('#p-content').value = p.content;
  $('#p-default').checked = !!p.is_default;
  $('#btn-delete-prompt').classList.remove('hidden');
}

function resetPromptForm() {
  editingPromptId = null;
  $('#prompt-editor-title').textContent = 'New prompt';
  $('#p-name').value = '';
  $('#p-desc').value = '';
  $('#p-content').value = '';
  $('#p-default').checked = false;
  $('#btn-delete-prompt').classList.add('hidden');
}

async function savePrompt() {
  const body = {
    name: $('#p-name').value.trim(),
    description: $('#p-desc').value.trim(),
    content: $('#p-content').value,
    is_default: $('#p-default').checked
  };
  if (!body.name || !body.content.trim()) return toast('Name and content are required', true);
  const wasEditing = editingPromptId;
  try {
    const saved = wasEditing
      ? await api(`/prompts/${wasEditing}`, { method: 'PUT', body })
      : await api('/prompts', { method: 'POST', body });
    resetPromptForm();
    await loadPrompts();
    // Created from the chat bar? Apply it to this conversation straight away.
    if (!wasEditing && state.pendingNewPrompt && saved?.id && current()) {
      state.pendingNewPrompt = false;
      await api(`/conversations/${current().id}`, { method: 'PATCH', body: { prompt_id: saved.id } });
      await openConversation(current().id);
      $('dlg-prompts').close();
      return toast('Prompt saved and applied to this chat');
    }
    toast('Prompt saved');
  } catch (e) {
    toast(e.message, true);
  }
}

async function makeDefaultPrompt(id) {
  await api(`/prompts/${id}/default`, { method: 'POST' });
  await loadPrompts();
  toast('Default persona updated');
}

async function deletePrompt(id) {
  if (!confirm('Delete this system prompt? Conversations using it will keep their history.')) return;
  await api(`/prompts/${id}`, { method: 'DELETE' });
  if (editingPromptId === id) resetPromptForm();
  await loadPrompts();
}

/* ───────────────────────── MCP modal ───────────────────────── */
let editingMcpId = null;

/** Names of MCP servers the current chat has switched off. */
function chatOffServers(c) {
  const off = new Set();
  if (!c) return off;
  if (!Number(c.files_enabled ?? 1)) off.add('files');
  if (!Number(c.shell_enabled ?? 1)) off.add('shell');
  let names = [];
  try {
    names = JSON.parse(c.mcp_disabled || '[]');
  } catch {
    names = [];
  }
  if (Array.isArray(names)) for (const n of names) off.add(String(n));
  return off;
}

/** Whether this chat has this server switched off. */
function serverOffForChat(s, c) {
  const off = chatOffServers(c);
  return off.has(s.name) || (!!s.builtin_key && off.has(s.builtin_key));
}

/**
 * Switch one MCP server on/off for the current chat.
 * Built-in sets live in their own columns; custom servers are a JSON list.
 */
async function setServerEnabled(server, on) {
  const c = current();
  if (!c) return;
  const key = server.builtin_key === 'files' || server.builtin_key === 'shell' ? `${server.builtin_key}_enabled` : null;
  if (key) {
    await setChatOption({ [key]: on ? 1 : 0 });
    return;
  }
  let names = [];
  try {
    names = JSON.parse(c.mcp_disabled || '[]');
  } catch {
    names = [];
  }
  const set = new Set(Array.isArray(names) ? names.map(String) : []);
  if (on) set.delete(server.name);
  else set.add(server.name);
  try {
    const updated = await api(`/conversations/${c.id}`, { method: 'PATCH', body: { mcp_disabled: [...set] } });
    Object.assign(c, updated);
    renderPlusMcp();
    updateToolsHint();
    updateChatSub();
  } catch (e) {
    toast(e.message, true);
    renderPlusMcp();
  }
}

/**
 * Compact MCP server status lists shown inside the "+" menu, right below the
 * MCP tools toggle: built-in servers (files / shell) first, then servers the
 * user added in Settings. Each row shows a status dot, the name, how many
 * tools it contributes to this chat, and a switch that turns that one server
 * on or off for this chat only.
 */
function renderPlusMcp() {
  const c = current();
  const off = chatOffServers(c);
  const row = (s) => {
    const chatOff = off.has(s.name) || (!!s.builtin_key && off.has(s.builtin_key));
    const disabled = !s.enabled || chatOff;
    const dot = disabled
      ? 'dot-grey'
      : s.status === 'connected'
        ? 'dot-green'
        : s.status === 'error'
          ? 'dot-red'
          : 'dot-grey';
    const count = s.status === 'connected' && !disabled ? `${s.tools?.length || 0} tools` : '';
    const toggle = el('input', {
      type: 'checkbox',
      class: 'switch',
      title: s.enabled ? `Use ${s.name} in this chat` : `${s.name} is switched off in Settings`,
      'aria-label': `${s.name} in this chat`,
      disabled: s.enabled ? null : 'disabled'
    });
    toggle.checked = !!s.enabled && !chatOff;
    toggle.onchange = () => setServerEnabled(s, toggle.checked);
    return el('label', {
      class: `pm-mcp-item${chatOff ? ' off' : ''}`,
      title: s.error || (s.enabled ? `Use ${s.name} in this chat` : `${s.name} is switched off in Settings`)
    },
      el('span', { class: `dot ${dot}` }),
      el('span', { class: 'pm-mcp-name' }, s.name),
      el('span', { class: 'pm-mcp-count' }, count),
      toggle
    );
  };
  const builtin = state.mcp.filter((s) => s.builtin);
  const custom = state.mcp.filter((s) => !s.builtin);
  const bl = $('#pm-mcp-builtin-list');
  const cl = $('#pm-mcp-custom-list');
  if (bl) { bl.innerHTML = ''; for (const s of builtin) bl.append(row(s)); }
  if (cl) {
    cl.innerHTML = '';
    if (!custom.length) cl.append(el('div', { class: 'pm-mcp-empty' }, 'No MCP servers added yet.'));
    else for (const s of custom) cl.append(row(s));
  }
}

function renderMcpList() {
  const list = $('#mcp-list');
  list.innerHTML = '';
  if (!state.mcp.length) {
    list.append(el('div', { class: 'muted' }, 'No MCP servers configured yet. Add one below — for example the filesystem server: command “npx”, arguments [\"-y\", \"@modelcontextprotocol/server-filesystem\", \"C:\\\\tmp\"].'));
    return;
  }
  for (const s of state.mcp) {
    const badge = !s.enabled
      ? el('span', { class: 'badge off' }, 'disabled')
      : s.status === 'connected'
        ? el('span', { class: 'badge on' }, `connected · ${s.tools.length} tools`)
        : s.status === 'error'
          ? el('span', { class: 'badge err' }, 'error')
          : el('span', { class: 'badge' }, s.status);
    const main = el('div', { class: 'lc-main' },
      el('div', { class: 'lc-title' }, s.name, badge,
        s.builtin ? el('span', { class: 'badge builtin' }, 'built-in') : el('span', { class: 'badge' }, s.transport)),
      el('div', { class: 'lc-sub' }, s.error || (s.transport === 'stdio' ? `${s.command || ''} ${(s.args || []).join(' ')}` : s.url || ''))
    );
    if (s.tools?.length) {
      main.append(el('div', { class: 'tool-tags' }, ...s.tools.map((t) => el('code', { title: t.description || '' }, `${s.name}__${t.name}`))));
    }
    const approvalSel = el('select', {
      class: 'btn approval-select',
      title: 'When should the model be allowed to use this server’s tools?'
    },
      el('option', { value: 'auto' }, 'approval: auto'),
      el('option', { value: 'always' }, 'approval: always ask'),
      el('option', { value: 'never' }, 'approval: never ask')
    );
    approvalSel.value = s.approval || 'auto';
    approvalSel.onchange = async () => {
      try {
        await api(`/mcp/${s.id}`, { method: 'PUT', body: { approval: approvalSel.value, enabled: !!s.enabled } });
        toast(`approval policy: ${approvalSel.value}`);
      } catch (e) {
        toast(e.message, true);
      }
      await loadMcp();
    };

    const actions = s.builtin
      ? [
          approvalSel,
          el('button', { class: 'btn', onclick: () => connectMcp(s.id) }, 'reconnect'),
          el('button', {
            class: `btn ${s.enabled ? 'btn-danger' : 'btn-primary'}`,
            onclick: () => toggleMcp(s.id, !s.enabled)
          }, s.enabled ? 'switch off' : 'switch on')
        ]
      : [
          approvalSel,
          el('button', { class: 'btn', onclick: () => connectMcp(s.id) }, 'reconnect'),
          el('button', { class: 'btn', onclick: () => editMcp(s) }, 'edit'),
          el('button', { class: 'btn btn-danger', onclick: () => deleteMcp(s.id) }, 'delete')
        ];
    list.append(el('div', { class: 'list-card' }, main, el('div', { class: 'lc-actions' }, ...actions)));
  }
}

function editMcp(s) {
  editingMcpId = s.id;
  $('#mcp-editor-title').textContent = `Edit: ${s.name}`;
  $('#m-name').value = s.name;
  $('#m-transport').value = s.transport;
  $('#m-command').value = s.command || '';
  $('#m-url').value = s.url || '';
  $('#m-args').value = JSON.stringify(s.args || []);
  $('#m-env').value = s.env && Object.keys(s.env).length ? JSON.stringify(s.env, null, 2) : '';
  $('#m-headers').value = s.headers && Object.keys(s.headers).length ? JSON.stringify(s.headers, null, 2) : '';
  $('#m-enabled').checked = !!s.enabled;
  $('#btn-delete-mcp').classList.remove('hidden');
}

function resetMcpForm() {
  editingMcpId = null;
  $('#mcp-editor-title').textContent = 'Add MCP server';
  for (const id of ['#m-name', '#m-command', '#m-url', '#m-args', '#m-env', '#m-headers']) $(id).value = '';
  $('#m-transport').value = 'stdio';
  $('#m-enabled').checked = true;
  $('#btn-delete-mcp').classList.add('hidden');
  $('#mcp-result').classList.add('hidden');
}

function parseJsonField(value, fallback, label) {
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
}

async function saveMcp() {
  if (adminOnly()) return;
  const out = $('#mcp-result');
  out.classList.remove('hidden');
  out.textContent = 'Saving and connecting…';
  let body;
  try {
    body = {
      name: $('#m-name').value.trim(),
      transport: $('#m-transport').value,
      command: $('#m-command').value.trim(),
      url: $('#m-url').value.trim(),
      args: parseJsonField($('#m-args').value, [], 'Arguments'),
      env: parseJsonField($('#m-env').value, {}, 'Environment'),
      headers: parseJsonField($('#m-headers').value, {}, 'Headers'),
      enabled: $('#m-enabled').checked
    };
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
    return;
  }
  try {
    const r = editingMcpId ? await api(`/mcp/${editingMcpId}`, { method: 'PUT', body }) : await api('/mcp', { method: 'POST', body });
    out.textContent = `✅ saved — ${r.connect?.status}${r.connect?.error ? ': ' + r.connect.error : ''}`;
    resetMcpForm();
    await loadMcp();
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  }
}

async function connectMcp(id) {
  if (adminOnly()) return;
  try {
    const r = await api(`/mcp/${id}/connect`, { method: 'POST' });
    toast(`connected: ${r.toolCount} tool(s)`);
  } catch (e) {
    toast(e.message, true);
  }
  await loadMcp();
}

async function toggleMcp(id, enabled) {
  if (adminOnly()) return;
  try {
    await api(`/mcp/${id}`, { method: 'PUT', body: { enabled } });
    toast(enabled ? 'Server switched on' : 'Server switched off');
  } catch (e) {
    toast(e.message, true);
  }
  await loadMcp();
}

async function deleteMcp(id) {
  if (adminOnly()) return;
  if (!confirm('Remove this MCP server?')) return;
  await api(`/mcp/${id}`, { method: 'DELETE' });
  if (editingMcpId === id) resetMcpForm();
  await loadMcp();
}

/* ───────────────────────── Tool approvals ─────────────────────────
 * The server parks a mutating tool call until the user answers. Pending calls
 * arrive on a dedicated stream so they survive a reload or a tab switch.
 */
const approvalCards = new Map();
let approvalStream = null;

/**
 * One approval stream per page. It is opened after sign-in (and closed on
 * logout) so the login screen does not sit in an EventSource retry loop
 * against a route that requires a session.
 */
function connectApprovalStream() {
  if (approvalStream) return;
  const src = new EventSource('/api/approvals/stream');
  approvalStream = src;
  src.addEventListener('approval_request', (e) => showApproval(JSON.parse(e.data)));
  src.addEventListener('approval_resolved', (e) => {
    const d = JSON.parse(e.data);
    removeApproval(d.id, d.allowed ? 'allowed' : 'denied');
  });
  src.addEventListener('keepalive', () => {});
  src.onerror = () => {
    // EventSource reconnects by itself; nothing to do but stop the noise.
  };
}

function disconnectApprovalStream() {
  if (!approvalStream) return;
  approvalStream.close();
  approvalStream = null;
}

function showApproval(meta) {
  if (approvalCards.has(meta.id)) return;

  const detail = el('div', { class: 'approval-detail' }, meta.detail || '');
  if (meta.body) detail.append(el('pre', { class: 'approval-body' }, meta.body));

  const card = el('div', { class: 'approval-card' },
    el('div', { class: 'approval-head' },
      el('span', { class: 'approval-icon' }, meta.kind === 'command' ? '💻' : meta.kind === 'file' ? '📄' : '🔌'),
      el('strong', {}, meta.title || `Run ${meta.name}`),
      el('code', { class: 'approval-tool' }, meta.name)
    ),
    detail,
    meta.extra ? el('div', { class: 'muted approval-extra' }, meta.extra) : null,
    el('div', { class: 'approval-actions' },
      el('button', { class: 'btn btn-primary', onclick: () => answerApproval(meta.id, true, 'once') }, 'Allow'),
      el('button', { class: 'btn', onclick: () => answerApproval(meta.id, true, 'conversation') }, 'Allow for this chat'),
      el('button', { class: 'btn', onclick: () => answerApproval(meta.id, true, 'always') }, 'Always allow'),
      el('button', { class: 'btn btn-danger', onclick: () => answerApproval(meta.id, false, 'once') }, 'Deny')
    )
  );
  approvalCards.set(meta.id, card);
  $('#approvals').append(card);
  card.scrollIntoView({ block: 'nearest' });
}

function removeApproval(id, outcome) {
  const card = approvalCards.get(id);
  if (!card) return;
  approvalCards.delete(id);
  card.classList.add('resolved');
  card.textContent = outcome === 'allowed' ? '✓ Allowed' : '✕ Denied';
  setTimeout(() => card.remove(), 1800);
}

async function answerApproval(id, allowed, scope) {
  try {
    await api(`/approvals/${id}`, { method: 'POST', body: { allowed, scope } });
  } catch (e) {
    toast(e.message, true);
    removeApproval(id, false);
  }
}

/* ───────────────────────── Auth (login / users) ───────────────────────── */

async function fetchAuthStatus() {
  return api('/auth/status', { __noAuthGate: true });
}

let loginMode = 'login'; // 'login' | 'register'

function showLogin() {
  const ov = $('#login-overlay');
  if (!ov || !ov.classList.contains('hidden')) return;
  ov.classList.remove('hidden');
  $('#login-error')?.classList.add('hidden');
  $('#login-password').value = '';
  setLoginMode(loginMode);
  setTimeout(() => $('#login-username')?.focus(), 50);
}

function hideLogin() {
  $('#login-overlay')?.classList.add('hidden');
}

// Switch the overlay between "Sign in" and "Create account" (setup when first
// user, otherwise register a new ordinary user). The sign-up switch is hidden
// while registration is closed; the first account is always allowed.
function setLoginMode(mode) {
  const canRegister = state.needsSetup || state.openRegistration;
  if (!canRegister) mode = 'login';
  loginMode = mode;
  const isSetup = mode === 'register' && state.needsSetup;
  $('#login-title').textContent = mode === 'register' ? (isSetup ? 'Create the admin account' : 'Create an account') : 'Sign in';
  $('#login-sub').textContent = mode === 'register'
    ? (isSetup ? 'You are the first user, so this account will be the administrator and will receive any existing chats.' : 'Choose a username and password.')
    : (canRegister ? 'Sign in to continue.' : 'Sign in to continue. New accounts are created by an admin.');
  $('#login-submit').textContent = mode === 'register' ? (isSetup ? 'Create admin account' : 'Create account') : 'Sign in';
  $('#login-switch-text').textContent = mode === 'register' ? 'Already have an account?' : 'No account?';
  $('#login-toggle').textContent = mode === 'register' ? 'Sign in' : 'Create one';
  $('#login-switch-text').classList.toggle('hidden', !canRegister);
  $('#login-toggle').classList.toggle('hidden', !canRegister);
  $('#login-password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
}

async function submitLogin(e) {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  const err = $('#login-error');
  err.classList.add('hidden');
  const btn = $('#login-submit');
  btn.disabled = true;
  try {
    const path = loginMode === 'register' ? '/auth/register' : '/auth/login';
    const r = await api(path, { method: 'POST', body: { username, password }, __noAuthGate: true });
    state.currentUser = r.user;
    state.needsSetup = false;
    if (loginMode === 'register' && r.claimed_conversations) {
      toast(`${r.claimed_conversations} existing chat${r.claimed_conversations === 1 ? '' : 's'} moved to your account`);
    }
    hideLogin();
    await afterLogin();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function afterLogin() {
  renderUserChip();
  connectApprovalStream();
  await Promise.all([loadSettings(), loadPrompts(), loadConversations(), loadMcp()]);
  applyAdminUi();
  fillModelOptions(state.settings.model ? [state.settings.model] : []);
  if (state.conversations.length) await openConversation(state.conversations[0].id);
  else { renderMessages(); renderChatOptions(); }
  updateToolsHint();
  await refreshRunning();
  if (!authPollTimer) authPollTimer = setInterval(refreshRunning, 4000);
}

function renderUserChip() {
  const u = state.currentUser;
  const chip = $('#user-chip');
  if (!u) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  $('#user-avatar').textContent = u.username[0].toUpperCase();
  $('#user-name').textContent = u.username;
  $('#user-menu-name').textContent = u.username;
  $('#user-menu-role').textContent = u.is_admin ? 'admin' : 'user';
  $('#btn-manage-users').classList.toggle('hidden', !u.is_admin);
  applyAdminUi();
}

/** Guard an action that only admins may perform. Returns true when blocked. */
function adminOnly() {
  if (state.currentUser?.is_admin) return false;
  toast('Only an administrator can change that.', true);
  return true;
}

/**
 * Settings and MCP configuration are global (and MCP stdio servers can run any
 * command on this machine), so ordinary users only get a read-only view.
 * "Forget remembered approvals" stays available: grants are per user now.
 */
function applyAdminUi() {
  const admin = !!state.currentUser?.is_admin;
  for (const n of document.querySelectorAll('#settings-form input, #settings-form select, #settings-form textarea, #settings-form button')) {
    if (n.closest('.modal-head') || n.closest('.settings-tabs') || n.classList.contains('settings-tab-btn') || n.hasAttribute('data-close') || n.id === 'btn-clear-grants') continue;
    n.disabled = !admin;
  }
  $('#settings-admin-hint')?.classList.toggle('hidden', admin);
  const pick = $('#btn-pick-workdir');
  if (pick) {
    pick.disabled = !admin;
    pick.title = admin ? 'Browse the server for a folder' : 'Only an admin can browse server folders';
  }
  renderComposerFolder();
}

async function doLogout() {
  try { await api('/auth/logout', { method: 'POST', __noAuthGate: true }); } catch { /* ignore */ }
  // Drop the live streams/pollers tied to the old session before the overlay.
  disconnectApprovalStream();
  if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; }
  state.currentUser = null;
  state.conversations = [];
  state.messages = [];
  renderUserChip();
  renderConvList();
  renderMessages();
  hideUserMenu();
  loginMode = 'login';
  const st = await fetchAuthStatus().catch(() => null);
  if (st) {
    state.needsSetup = st.needs_setup;
    state.openRegistration = !!st.open_registration;
  }
  showLogin();
}

function hideUserMenu() { $('#user-menu')?.classList.add('hidden'); }

/* ── Manage users (admin) ── */
async function openUsersDialog() {
  hideUserMenu();
  $('#dlg-users').showModal();
  await renderUsersList();
}

async function renderUsersList() {
  const box = $('#users-list');
  box.textContent = '';
  let r;
  try { r = await api('/auth/users'); } catch (e) { box.append(el('div', { class: 'muted' }, e.message)); return; }
  for (const u of r.users) {
    const row = el('div', { class: 'user-row' },
      el('span', { class: 'user-row-name' }, u.username, u.is_admin ? el('span', { class: 'tag tag-admin' }, 'admin') : null),
      el('span', { class: 'user-row-count muted' }, `${u.conversation_count} chats`)
    );
    if (u.id !== state.currentUser.id) {
      row.append(
        el('button', { class: 'link-btn', onclick: () => toggleAdmin(u) }, u.is_admin ? 'Revoke admin' : 'Make admin'),
        el('button', { class: 'link-btn danger', onclick: () => deleteUser(u) }, 'Delete')
      );
    } else {
      row.append(el('span', { class: 'muted' }, 'you'));
    }
    box.append(row);
  }
}

async function toggleAdmin(u) {
  try {
    await api(`/auth/users/${u.id}`, { method: 'PATCH', body: { is_admin: !u.is_admin } });
    await renderUsersList();
  } catch (e) { toast(e.message, true); }
}

async function deleteUser(u) {
  if (!confirm(`Delete user "${u.username}"? This permanently removes their chats.`)) return;
  try {
    await api(`/auth/users/${u.id}`, { method: 'DELETE' });
    await renderUsersList();
    toast('User deleted');
  } catch (e) { toast(e.message, true); }
}

async function createUser() {
  const username = $('#nu-username').value.trim();
  const password = $('#nu-password').value;
  const is_admin = $('#nu-admin').checked;
  if (!username || !password) { toast('Username and password required', true); return; }
  try {
    await api('/auth/users', { method: 'POST', body: { username, password, is_admin } });
    $('#nu-username').value = ''; $('#nu-password').value = ''; $('#nu-admin').checked = false;
    await renderUsersList();
    toast('User created');
  } catch (e) { toast(e.message, true); }
}

async function changePassword(e) {
  e.preventDefault();
  try {
    await api('/auth/change-password', { method: 'POST', body: { current: $('#cp-current').value, next: $('#cp-next').value } });
    $('#cp-current').value = ''; $('#cp-next').value = '';
    $('#dlg-change-password').close();
    toast('Password updated');
  } catch (err) { toast(err.message, true); }
}

/* ───────────────────────── Wiring ───────────────────────── */
function wire() {
  initTheme();
  $('#btn-new-chat').onclick = () => newConversation();
  $('#empty-new')?.addEventListener('click', () => newConversation());
  $('#empty-settings')?.addEventListener('click', () => openModal('#dlg-settings'));
  $('#btn-toggle-sidebar').onclick = () => toggleSidebar();
  $('#sidebar-backdrop').onclick = () => toggleSidebar(false);
  $('#btn-export-chat').onclick = () => exportConversation('md');
  $('#btn-header-files').onclick = () => openFileManager();
  $('#btn-theme').onclick = () => { hideUserMenu(); cycleTheme(); };

  // Command palette: filter as you type, arrows move, Enter runs, Esc closes.
  const paletteInput = $('#palette-input');
  paletteInput.addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
  paletteInput.addEventListener('keydown', onPaletteKey);
  $('#dlg-palette').addEventListener('click', (e) => {
    if (e.target === $('#dlg-palette')) closePalette();
  });

  $('#conv-search').oninput = (e) => {
    state.search = e.target.value;
    renderConvList();
  };

  $('#chat-title').onchange = async (e) => {
    if (!state.currentId) return;
    const val = e.target.value.trim();
    if (!val) { e.target.value = current()?.title || 'New chat'; return; }
    const c = await api(`/conversations/${state.currentId}`, { method: 'PATCH', body: { title: val } });
    Object.assign(current(), c);
    renderConvList();
  };

  // "Generate with AI" — ask the model for a title for the current chat.
  $('#btn-ai-title').onclick = async () => {
    if (!state.currentId) return toast('Open a chat first.', true);
    const btn = $('#btn-ai-title');
    btn.disabled = true;
    // Swap only the label so the button keeps its icon and width while working.
    const label = btn.querySelector('.hb-label');
    const prevLabel = label ? label.textContent : btn.textContent;
    if (label) label.textContent = '…';
    else btn.textContent = '⏳…';
    try {
      const c = await api(`/conversations/${state.currentId}/generate-title`, { method: 'POST' });
      Object.assign(current(), c);
      applyTitle(c.title);
      toast('Title updated');
    } catch (err) {
      toast(err.message || 'Could not generate a title.', true);
    } finally {
      btn.disabled = false;
      if (label) label.textContent = prevLabel;
      else btn.textContent = prevLabel;
    }
  };

  $('#sel-prompt').onchange = async (e) => {
    if (!state.currentId) return;
    const c = await api(`/conversations/${state.currentId}`, { method: 'PATCH', body: { prompt_id: e.target.value || null } });
    Object.assign(current(), c);
    renderConvList();
    updateChatSub();
    toast('Persona updated');
  };

  $('#sel-model').onchange = async (e) => {
    if (!state.currentId) return;
    const c = await api(`/conversations/${state.currentId}`, { method: 'PATCH', body: { model: e.target.value || null } });
    Object.assign(current(), c);
    updateChatSub();
  };

  $('#composer').onsubmit = (e) => {
    e.preventDefault();
    sendMessage();
  };
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#input').addEventListener('input', autoresize);
  $('#btn-stop').onclick = stopStreaming;
  $('#btn-compact').onclick = compactNow;

  // "+" menu: attachments plus this chat's options
  $('#btn-plus').onclick = (e) => {
    e.stopPropagation();
    setPlusMenu();
  };
  $('#btn-attach').onclick = () => $('#attach-input').click();
  $('#attach-input').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };
  $('#btn-attach-url').onclick = attachImageUrl;
  $('#btn-image-add').onclick = commitImageUrl;
  $('#btn-image-cancel').onclick = () => $('#image-url-row').classList.add('hidden');
  $('#image-url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitImageUrl();
    } else if (e.key === 'Escape') {
      $('#image-url-row').classList.add('hidden');
    }
  });
  // Clicking anywhere outside the menu closes it (but not on a control inside it).
  document.addEventListener('click', (e) => {
    if ($('#plus-menu').classList.contains('hidden')) return;
    if (!e.target.closest('#plus-menu') && !e.target.closest('#btn-plus')) setPlusMenu(false);
  });
  // Keep the menu inside the viewport when the on-screen keyboard appears.
  window.addEventListener('resize', () => {
    if (!$('#plus-menu').classList.contains('hidden')) setPlusMenu(false);
    if (!isMobile()) {
      $('#sidebar-backdrop').classList.add('hidden');
      $('#app').classList.remove('sidebar-open');
    }
  });

  // Paste images / files (screenshots, Explorer copies, images copied from apps).
  // Images copied from some apps arrive as clipboard *items* rather than files,
  // so fall back to the items and synthesise File objects from the blobs.
  $('#input').addEventListener('paste', (e) => {
    const files = clipboardFiles(e);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  // Dropping onto the message box attaches the same way.
  const composer = $('#composer');
  composer.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  composer.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  // settings
  document.querySelectorAll('#dlg-settings .settings-tab-btn').forEach(btn => {
    btn.onclick = () => switchSettingsTab(btn.dataset.tab);
  });
  $('#dlg-settings .settings-tabs')?.addEventListener('keydown', (e) => {
    const tabs = Array.from(document.querySelectorAll('#dlg-settings .settings-tab-btn'));
    const idx = tabs.findIndex(t => t.classList.contains('on'));
    if (idx === -1) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = tabs[(idx + 1) % tabs.length];
      next.focus();
      switchSettingsTab(next.dataset.tab);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      prev.focus();
      switchSettingsTab(prev.dataset.tab);
    }
  });

  $('#btn-open-settings').onclick = async () => {
    await loadSettings();
    await loadMcp();
    applyAdminUi();
    switchSettingsTab('ai-section');
    openModal('#dlg-settings');
  };
  $('#settings-form').onsubmit = (e) => {
    // The MCP editor lives inside this form but saves with its own button.
    if (e.submitter && e.submitter.closest('#mcp-section')) {
      e.preventDefault();
      return;
    }
    saveSettings(e);
  };
  $('#btn-test').onclick = testConnection;
  $('#btn-fetch-models').onclick = fetchModels;
  $('#btn-clear-grants').onclick = async () => {
    await api('/approvals/grants/clear', { method: 'POST' });
    toast('Remembered approvals cleared');
  };

  // per-chat tool policy (above the message box)
  for (const [sel, key] of [['#co-approval', 'approval_mode'], ['#co-files-access', 'file_access'], ['#co-shell-access', 'shell_access']]) {
    $(sel).onclick = (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b || b.classList.contains('on')) return;
      setSeg(sel, b.dataset.value);
      setChatOption({ [key]: b.dataset.value });
    };
  }
  $('#co-files-on').onchange = (e) => setChatOption({ files_enabled: e.target.checked });
  $('#co-shell-on').onchange = (e) => setChatOption({ shell_enabled: e.target.checked });

  // Per-chat thinking effort (reasoning_effort).
  const effortSel = $('#sel-effort');
  if (effortSel) {
    effortSel.onchange = async (e) => {
      const c = current();
      if (!c) return;
      try {
        const updated = await api(`/conversations/${c.id}`, { method: 'PATCH', body: { reasoning_effort: e.target.value } });
        Object.assign(c, updated);
      } catch (err) {
        toast(err.message, true);
        renderChatOptions();
      }
    };
  }
  // Scroll-to-latest pill.
  const scrollLatest = $('#scroll-latest');
  if (scrollLatest) scrollLatest.onclick = () => { autoFollow = true; scrollBottom(true); };
  const saveWorkdir = () => {
    const c = current();
    if (!c) return;
    const v = $('#co-workdir').value.trim();
    if (v === (c.workdir || '').trim()) return;
    setChatOption({ workdir: v });
  };
  $('#co-workdir').addEventListener('change', saveWorkdir);
  $('#co-workdir').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveWorkdir();
    }
  });
  $('#btn-new-prompt').onclick = () => {
    setPlusMenu(false);
    resetPromptForm();
    state.pendingNewPrompt = true;
    renderPromptList();
    openModal('#dlg-prompts');
    $('#p-name').focus();
  };
  $('#btn-pick-workdir').onclick = openFolderPicker;
  $('#btn-file-manager').onclick = openFileManager;

  // folder picker
  $('#btn-folder-go').onclick = () => browseFolder($('#folder-path').value.trim());
  $('#folder-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      browseFolder($('#folder-path').value.trim());
    }
  });
  $('#btn-folder-up').onclick = () => folderPicker.parent && browseFolder(folderPicker.parent);
  $('#btn-folder-home').onclick = () => browseFolder(folderPicker.home || '');
  $('#btn-folder-create').onclick = createFolder;
  $('#folder-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createFolder();
    }
  });
  $('#btn-folder-pick').onclick = pickWorkdir;
  $('#btn-folder-cancel').onclick = () => $('#dlg-folder').close();

  // chat file manager
  $('#btn-files-up').onclick = () => fileBrowser.parent && browseFiles(fileBrowser.parent);
  $('#btn-files-zip').onclick = () => {
    if (!state.currentId) return;
    const p = fileBrowser.path || '';
    const folderName = p ? (p.split(/[\/\\]/).pop() || 'workspace') : 'workspace';
    toast('Generating ZIP download…');
    const a = document.createElement('a');
    a.href = folderZipUrl(p);
    a.download = `${folderName}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
  };
  $('#btn-files-root').onclick = () => browseFiles('');
  $('#btn-files-refresh').onclick = () => browseFiles(fileBrowser.path);
  $('#btn-files-mkdir').onclick = mkdirHere;
  $('#files-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      mkdirHere();
    }
  });
  $('#btn-files-upload').onclick = () => $('#files-upload').click();
  $('#files-upload').onchange = (e) => {
    const f = e.target.files?.[0];
    if (f) uploadHere(f);
    e.target.value = '';
  };

  // restart AI server button in sidebar
  $('#btn-restart-server')?.addEventListener('click', restartAiServer);

  // prompts
  if ($('#btn-open-prompts')) {
    $('#btn-open-prompts').onclick = () => {
      renderPromptList();
      openModal('#dlg-prompts');
    };
  }
  $('#btn-save-prompt').onclick = savePrompt;
  $('#btn-reset-prompt').onclick = resetPromptForm;
  $('#btn-delete-prompt').onclick = () => editingPromptId && deletePrompt(editingPromptId);

  // mcp (managed inside the Settings dialog)
  if ($('#btn-open-mcp')) {
    $('#btn-open-mcp').onclick = () => {
      loadSettings();
      loadMcp();
      openModal('#dlg-settings');
      scrollToSection('#mcp-section');
    };
  }
  // The MCP editor lives inside the settings form, so Enter must not submit it.
  $('#mcp-section').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
  });
  $('#btn-save-mcp').onclick = saveMcp;
  $('#btn-reset-mcp').onclick = resetMcpForm;
  $('#btn-delete-mcp').onclick = async () => {
    if (editingMcpId) await deleteMcp(editingMcpId);
  };

  // copy code buttons (delegated)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;
    const code = btn.parentElement.querySelector('code');
    await copyText(code?.textContent || '');
    btn.textContent = 'copied!';
    setTimeout(() => (btn.textContent = 'copy'), 1200);
  });

  // close buttons inside dialogs
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => b.closest('dialog').close();
  });

  // Images in chat open in a fullscreen lightbox
  // Images in chat open in a fullscreen lightbox. If the clicked image is
  // part of a gallery (or the reply simply holds several pictures), the
  // whole group becomes a navigable slideshow with arrows and key controls.
  const lightbox = $('#dlg-lightbox');
  const lightboxImg = $('#lightbox-img');
  document.addEventListener('click', (e) => {
    if (e.target.closest?.('#dlg-lightbox')) return;
    const img = e.target.closest?.('#messages img');
    if (!img || img === lightboxImg) return;
    const scope = img.closest('.img-gallery') || img.closest('.bubble') || document;
    const nodes = [...scope.querySelectorAll('img')].filter((n) => n !== lightboxImg);
    LIGHTBOX.items = nodes.map((n) => ({ src: n.currentSrc || n.src, alt: n.alt || 'image' }));
    const idx = nodes.indexOf(img);
    lightboxShow(idx < 0 ? 0 : idx);
  });
  lightbox.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-lb]')?.getAttribute('data-lb');
    if (act === 'prev') { e.stopPropagation(); return lightboxStep(-1); }
    if (act === 'next') { e.stopPropagation(); return lightboxStep(1); }
    if (e.target === lightbox || e.target === lightboxImg) lightbox.close();
  });
  lightbox.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxStep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lightboxStep(1); }
  });
  lightbox.addEventListener('close', () => {
    lightboxImg.removeAttribute('src');
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('#dlg-palette').open) closePalette();
      else openPalette();
      return;
    }
    // The palette owns the keyboard while it is open.
    if ($('#dlg-palette').open) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newConversation();
    }
    if (e.key === 'Escape' && state.streaming) stopStreaming();
    if (e.key === 'Escape') hideUserMenu();
  });

  // ── Auth UI ──
  $('#login-form').addEventListener('submit', submitLogin);
  $('#login-toggle').addEventListener('click', () => setLoginMode(loginMode === 'login' ? 'register' : 'login'));
  $('#user-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#user-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#user-chip')) hideUserMenu();
  });
  $('#btn-logout').addEventListener('click', doLogout);
  $('#btn-manage-users').addEventListener('click', openUsersDialog);
  $('#nu-create').addEventListener('click', createUser);
  $('#change-password-form').addEventListener('submit', changePassword);
  $('#btn-change-password').addEventListener('click', () => { hideUserMenu(); $('#dlg-change-password').showModal(); });
}

async function init() {
  wire();
  watchMessagesScroll();
  // Auth gate: nothing loads (and no live streams open) until the session is
  // verified.
  let status = null;
  try { status = await fetchAuthStatus(); } catch (e) { console.error(e); }
  state.needsSetup = !!status?.needs_setup;
  state.openRegistration = !!status?.open_registration;
  if (!status?.authenticated) {
    loginMode = state.needsSetup ? 'register' : 'login';
    showLogin();
    return;
  }
  state.currentUser = status.user;
  renderUserChip();
  await afterLogin();
}

window.addEventListener('DOMContentLoaded', init);
