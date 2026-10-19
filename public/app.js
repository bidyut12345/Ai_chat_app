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
  streaming: false,
  abort: null,
  attachments: [],
  pendingNewPrompt: false,
  search: '',
  // Auth state: current signed-in user and whether the first account is needed.
  currentUser: null,
  needsSetup: false
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
  if (s.models) fillModelOptions(s.models);
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
}

function current() {
  return state.conversations.find((c) => c.id === state.currentId) || null;
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
    const item = el(
      'div',
      {
        class: `conv-item${c.id === state.currentId ? ' active' : ''}`,
        onclick: () => openConversation(c.id)
      },
      el('div', { class: 'conv-title' }, c.title || 'Untitled',
        runningIds.has(c.id) ? el('span', { class: 'conv-running', title: 'Generating…' }, '●') : null),
      el('div', { class: 'conv-meta' }, `${c.message_count || 0} msg · ${c.prompt_name || 'no persona'}${c.model ? ' · ' + c.model : ''}`),
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
  // Switching away must NOT stop the generation — just detach the viewer.
  detachRun();
  setRunningBadge(state.currentId, runningIds.has(state.currentId));
  if (isMobile()) toggleSidebar(false);
  state.currentId = id;
  const conv = await api(`/conversations/${id}`);
  state.messages = conv.messages || [];
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
  updateContextMeterFromMessages();
  // A fresh view must not carry a leftover image attachment into a new chat
  // (the "blank image" that appeared on text-only messages).
  clearAttachments();
  // If this chat is generating, resume watching it live.
  if (runningIds.has(id)) attachToRun(id, 0);
}

function updateChatSub() {
  const c = current();
  const parts = [];
  if (c) {
    if (c.prompt_name) parts.push(`persona: ${c.prompt_name}`);
    parts.push(`model: ${c.model || state.settings.model || 'server default'}`);
    parts.push(`${state.messages.length} messages`);
  } else {
    parts.push('no conversation selected');
  }
  const toolCount = state.mcp.reduce((n, s) => n + (s.status === 'connected' ? s.tools.length : 0), 0);
  if (toolCount) parts.push(`${toolCount} MCP tools ready`);
  $('#chat-sub').textContent = parts.join('  ·  ');
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
        context = Math.max(context, r.prompt || 0);
      }
    } else {
      processed += m.prompt_tokens || 0;
      generated += m.completion_tokens || 0;
      context = Math.max(context, m.prompt_tokens || 0);
    }
  }
  return { processed, generated, context };
}

// Remember the last context/window pair so switching chats re-renders it.
let lastContext = { tokens: 0, window: 0 };

function updateContextMeterFromMessages() {
  const t = conversationTokenTotals();
  const win = Number(state.settings.context_window) || lastContext.window || 0;
  lastContext = { tokens: t.context, window: win };
  renderContextMeter(t, win);
}

function updateContextMeter(contextTokens, contextWindow) {
  if (contextTokens) lastContext.tokens = contextTokens;
  if (contextWindow) lastContext.window = Number(contextWindow);
  const t = conversationTokenTotals();
  if (contextTokens) t.context = contextTokens;
  renderContextMeter(t, lastContext.window);
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
  let bar = '';
  const effKeep = Number(state.settings.context_keep) || 0;
  const winNote = (window > 0 ? `window ${fmtTokens(window)} · ` : '') +
    (effKeep > 0 ? `sent ≤ ${fmtTokens(effKeep)} recent tokens` : 'no trim');
  if (window > 0 && totals.context > 0) {
    const pct = Math.min(100, Math.round((totals.context / window) * 100));
    const cls = pct >= 90 ? 'ctx-high' : pct >= 70 ? 'ctx-mid' : '';
    bar = `<span class="ctx-meter ${cls}" title="Context ${totals.context} / ${window} tokens (${pct}%)&#10;${winNote}">` +
      `<span class="ctx-bar"><span class="ctx-fill" style="width:${pct}%"></span></span>` +
      `${fmtTokens(totals.context)}/${fmtTokens(window)} · ${pct}%</span>`;
  } else if (totals.context > 0) {
    bar = `<span class="ctx-meter" title="Tokens in context on the last request&#10;${winNote}">ctx ${fmtTokens(totals.context)}</span>`;
  } else {
    // Always show a context slot so the bottom info doesn't appear/disappear.
    bar = `<span class="ctx-meter ctx-idle" title="${winNote}">ctx —</span>`;
  }
  el2.innerHTML = bits.map((b) => `<span class="ctx-tok">${b}</span>`).join('') + bar;
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
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '⏳ Compacting…';
  try {
    const r = await api('/chat/compact', { method: 'POST', body: { conversation_id: state.currentId } });
    if (r.compressed) {
      const b = (r.before_tokens || 0).toLocaleString();
      const a = (r.after_tokens || 0).toLocaleString();
      toast(`Context compacted: ${b} → ${a} tokens`);
    } else if (r.skipped === 'nothing-eligible') {
      toast('Nothing to compact yet — the recent window already covers the chat.');
    } else {
      toast('Nothing to compact.');
    }
  } catch (e) {
    toast(e.message || 'Compaction failed.', true);
  } finally {
    btn.disabled = false;
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
    syncOptionGroups();
    updateToolsHint();
  } catch (e) {
    toast(e.message, true);
    renderChatOptions(); // roll the control back to the stored value
  }
}

function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  autoFollow = true;
  if (!state.currentId) {
    box.append($('#empty-state') || buildEmptyState());
    $('#empty-state').classList.remove('hidden');
    return;
  }
  for (const m of state.messages) box.append(renderMessage(m));
  scrollBottom();
}

function buildEmptyState() {
  const d = el('div', { id: 'empty-state', class: 'empty-state' },
    el('div', { class: 'empty-emoji' }, '🤖'),
    el('h2', {}, 'RiSriGPT'),
    el('p', { html: 'Your conversations are stored in a local SQLite database.<br>Point Settings at any OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM, OpenAI…).' }),
    el('div', { class: 'empty-actions' },
      el('button', { class: 'btn btn-primary', onclick: () => newConversation() }, 'Start a chat'),
      el('button', { class: 'btn', onclick: () => openModal('#dlg-settings') }, 'Configure server URL'))
  );
  return d;
}

function renderMessage(m) {
  const label = m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool result' : m.role === 'system' ? 'System' : 'Assistant';
  const avatar = m.role === 'user' ? '🧑' : m.role === 'tool' ? '🔌' : m.role === 'system' ? 'ℹ️' : '🤖';
  const wrap = el('div', { class: `msg ${m.role}`, 'data-id': m.id });
  wrap.append(el('div', { class: 'msg-avatar' }, avatar));
  const body = el('div', { class: 'msg-body' });
  body.append(
    el('div', { class: 'msg-head' },
      el('strong', {}, label),
      el('span', {}, m.created_at ? String(m.created_at).slice(5, 16) : ''),
      el('span', { class: 'msg-actions' },
        el('button', { title: 'Copy', onclick: () => { navigator.clipboard.writeText(m.content || ''); toast('Copied'); } }, 'copy'),
        m.role === 'assistant' ? el('button', { title: 'Regenerate the last reply', onclick: () => regenerate() }, 'regenerate') : null,
        m.role === 'user' ? el('button', { title: 'Edit & resend', onclick: () => editUserMessage(m) }, 'edit') : null,
        el('button', { title: 'Delete message', onclick: () => deleteMessage(m.id) }, 'delete')
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

    const content = el('div', { class: 'content' });
    content.innerHTML = renderMarkdown(m.content || '');
    bubble.append(content);

    if (files.length) bubble.append(fileChips(files));

    if (m.tool_calls) {
      for (const tc of parseToolCalls(m.tool_calls)) {
        bubble.append(toolChip(tc));
      }
    }
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

function fileChips(files) {
  const box = el('div', { class: 'file-chips' });
  for (const f of files) {
    box.append(
      el('span', { class: 'file-chip', title: f.path },
        el('span', {}, f.dir ? '📁' : '📄'),
        el('span', { class: 'file-chip-name' }, f.name),
        f.dir ? null : el('span', { class: 'file-chip-size' }, fmtSize(f.size)),
        f.dir
          ? null
          : el('a', { class: 'file-chip-dl', href: fileUrl(f.path), download: f.name, title: 'Download' }, '⬇ save')
      )
    );
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
          e.dir ? null : el('a', { class: 'btn btn-ghost icon-btn', href: fileUrl(e.path), title: 'Download' }, '⬇'),
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

async function previewFile(e) {
  try {
    const r = await api(`/conversations/${state.currentId}/fs/raw?path=${encodeURIComponent(e.path)}`);
    if (r.text == null) return browseFiles(fileBrowser.path);
    const list = $('#files-list');
    list.innerHTML = '';
    list.append(
      el('div', { class: 'file-preview' },
        el('div', { class: 'row file-preview-head' },
          el('strong', {}, r.name),
          el('span', { class: 'muted' }, fmtSize(r.size)),
          el('a', { class: 'btn btn-ghost icon-btn', href: fileUrl(e.path), title: 'Download' }, '⬇'),
          el('button', { class: 'btn', onclick: () => browseFiles(fileBrowser.path) }, '⬅ back')),
        el('pre', { class: 'file-preview-body' }, r.text))
    );
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

function setRunningBadge(id, on) {
  const changed = on ? runningIds.add(id) : runningIds.delete(id);
  if (changed) { renderConvList(); updateAppBusy(); }
}

async function refreshRunning() {
  try {
    const r = await api('/chat/running');
    const ids = new Set((r.runs || []).map((x) => x.conversation_id));
    for (const id of [...runningIds]) if (!ids.has(id)) runningIds.delete(id);
    for (const id of ids) runningIds.add(id);
    renderConvList();
    updateAppBusy();
    // Resume watching if the chat now on screen is generating and we're not.
    if (ids.has(state.currentId) && !run) attachToRun(state.currentId, 0);
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
  const files = state.attachments.filter((a) => a.data);
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
      renderMessages();
    }
  } catch {
    /* keep optimistic view */
  }
  attachToRun(convId, 0);
}

/**
 * Build (or rebuild) the live assistant bubble for a run and stream into it.
 * `lastEventId` resumes after the given server event sequence (0 = from start).
 */
function attachToRun(conversationId, lastEventId = 0) {
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
    startedAt: Date.now(),
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
    const secs = (Date.now() - run.startedAt) / 1000;
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
  for (const name of ['delta', 'reasoning', 'notice', 'tool_call', 'tool_result', 'tool_cancelled', 'tool_denied', 'tool_unavailable', 'file_created', 'compressed', 'stats', 'done', 'error', 'resync', 'idle']) {
    es.addEventListener(name, (e) => {
      // Track our cursor so a reconnect resumes in the right place.
      const id = Number(e.lastEventId);
      if (Number.isFinite(id) && run === r) run.lastEventId = id;
      handleRunEvent(r, name, e.data ? JSON.parse(e.data) : {});
    });
  }
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
    r.outChars += (d.text || '').length;
    noteToken(r);
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
  } else if (event === 'reasoning') {
    // Reasoning tokens are the first thing a thinking model generates, so they
    // seed the live speed timer and count toward the estimated rate.
    r.reasonChars += (d.text || '').length;
    noteToken(r);
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
  } else if (event === 'tool_call') {
    sealThinking(r);
    sealText(r);
    const chip = buildToolChip({
      id: d.id,
      name: d.name,
      argsText: JSON.stringify(d.arguments ?? {}, null, 2),
      status: 'running'
    });
    bubble.append(chip);
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
    bubble.append(fileChips([d]));
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
    // Buffer gap after a long disconnect — reload persisted state and re-attach.
    reloadAndReattach(r.conversationId);
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
  if (run !== r) return;
  const convId = r.conversationId;
  detachRun();
  setRunningBadge(convId, false);
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
    state.messages = fresh.messages || [];
    renderMessages();
  } catch {
    /* ignore */
  }
}

/** After a buffer gap: reload persisted state, then resume if still running. */
async function reloadAndReattach(convId) {
  if (convId !== state.currentId) return;
  const wasLastId = run ? run.lastEventId : 0;
  detachRun();
  await reloadConversation(convId);
  if (runningIds.has(convId)) attachToRun(convId, wasLastId);
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

function regenerate() {
  sendMessage(true);
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

/** Save the attachments (images included) into the chat's working folder. */
async function uploadAttachments() {
  const files = state.attachments.filter((a) => a.data);
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
  const off = new Set();
  if (c) {
    if (!Number(c.files_enabled ?? 1)) off.add('files');
    if (!Number(c.shell_enabled ?? 1)) off.add('shell');
  }
  const visible = state.mcp.filter((s) => s.status === 'connected' && !off.has(s.builtin_key));
  const n = visible.reduce((a, s) => a + s.tools.length, 0);
  const bits = [
    n
      ? `${n} tool${n === 1 ? '' : 's'} from ${visible.length} MCP server${visible.length === 1 ? '' : 's'}`
      : 'no MCP tools connected'
  ];
  if (off.size) bits.push(`${[...off].join(' + ')} off for this chat`);
  else if (c) bits.push(c.approval_mode === 'auto' ? 'auto-approve' : 'ask before changes');
  $('#hint-tools').textContent = bits.join(' · ');
}

/* ───────────────────────── Health ───────────────────────── */
async function refreshHealth() {
  const pill = $('#server-status');
  const txt = $('#server-status-text');
  pill.innerHTML = '<span class="dot dot-grey"></span><span>checking…</span>';
  try {
    const r = await api('/settings/test', { method: 'POST', body: {} });
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

/* ───────────────────────── Settings modal ───────────────────────── */
function openModal(sel) {
  $(sel).showModal();
}

// Scroll an open dialog to one of its sections (used by the MCP shortcut).
function scrollToSection(sel) {
  const target = $(sel);
  if (!target) return;
  requestAnimationFrame(() => {
    const body = target.closest('.modal-body') || target.parentElement;
    body.scrollTop = Math.max(0, target.offsetTop - body.offsetTop - 12);
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function saveSettings(e) {
  e?.preventDefault();
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
    aitemp_root: $('#set-aitemp_root').value.trim()
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

/**
 * Compact MCP server status lists shown inside the "+" menu, right below the
 * MCP tools toggle: built-in servers (files / shell) first, then servers the
 * user added in Settings. Each row shows a status dot, the name and how many
 * tools it contributes to this chat.
 */
function renderPlusMcp() {
  const c = current();
  const off = new Set();
  if (c) {
    if (!Number(c.files_enabled ?? 1)) off.add('files');
    if (!Number(c.shell_enabled ?? 1)) off.add('shell');
  }
  const row = (s) => {
    const disabled = !s.enabled || off.has(s.builtin_key);
    const dot = disabled
      ? 'dot-grey'
      : s.status === 'connected'
        ? 'dot-green'
        : s.status === 'error'
          ? 'dot-red'
          : 'dot-grey';
    const count = s.status === 'connected' && !disabled ? `${s.tools?.length || 0} tools` : '';
    return el('div', { class: 'pm-mcp-item', title: s.error || s.name },
      el('span', { class: `dot ${dot}` }),
      el('span', { class: 'pm-mcp-name' }, s.name),
      el('span', { class: 'pm-mcp-count' }, count)
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
  try {
    const r = await api(`/mcp/${id}/connect`, { method: 'POST' });
    toast(`connected: ${r.toolCount} tool(s)`);
  } catch (e) {
    toast(e.message, true);
  }
  await loadMcp();
}

async function toggleMcp(id, enabled) {
  try {
    await api(`/mcp/${id}`, { method: 'PUT', body: { enabled } });
    toast(enabled ? 'Server switched on' : 'Server switched off');
  } catch (e) {
    toast(e.message, true);
  }
  await loadMcp();
}

async function deleteMcp(id) {
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

function connectApprovalStream() {
  const src = new EventSource('/api/approvals/stream');
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
// user, otherwise register a new ordinary user).
function setLoginMode(mode) {
  loginMode = mode;
  const isSetup = mode === 'register' && state.needsSetup;
  $('#login-title').textContent = mode === 'register' ? (isSetup ? 'Create the admin account' : 'Create an account') : 'Sign in';
  $('#login-sub').textContent = mode === 'register'
    ? (isSetup ? 'You are the first user, so this account will be the administrator and will receive any existing chats.' : 'Choose a username and password.')
    : 'Sign in to continue.';
  $('#login-submit').textContent = mode === 'register' ? (isSetup ? 'Create admin account' : 'Create account') : 'Sign in';
  $('#login-switch-text').textContent = mode === 'register' ? 'Already have an account?' : 'No account?';
  $('#login-toggle').textContent = mode === 'register' ? 'Sign in' : 'Create one';
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
  await Promise.all([loadSettings(), loadPrompts(), loadConversations(), loadMcp()]);
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
}

async function doLogout() {
  try { await api('/auth/logout', { method: 'POST', __noAuthGate: true }); } catch { /* ignore */ }
  state.currentUser = null;
  state.conversations = [];
  state.messages = [];
  renderUserChip();
  renderConvList();
  renderMessages();
  hideUserMenu();
  loginMode = 'login';
  const st = await fetchAuthStatus().catch(() => null);
  if (st) { state.needsSetup = st.needs_setup; }
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
  $('#btn-new-chat').onclick = () => newConversation();
  $('#empty-new')?.addEventListener('click', () => newConversation());
  $('#empty-settings')?.addEventListener('click', () => openModal('#dlg-settings'));
  $('#btn-toggle-sidebar').onclick = () => toggleSidebar();
  $('#sidebar-backdrop').onclick = () => toggleSidebar(false);
  $('#conv-search').oninput = (e) => {
    state.search = e.target.value;
    renderConvList();
  };

  $('#chat-title').onchange = async (e) => {
    if (!state.currentId) return;
    const c = await api(`/conversations/${state.currentId}`, { method: 'PATCH', body: { title: e.target.value } });
    Object.assign(current(), c);
    renderConvList();
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
  $('#btn-open-settings').onclick = () => {
    loadSettings();
    loadMcp();
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

  // prompts
  $('#btn-open-prompts').onclick = () => {
    renderPromptList();
    openModal('#dlg-prompts');
  };
  $('#btn-save-prompt').onclick = savePrompt;
  $('#btn-reset-prompt').onclick = resetPromptForm;
  $('#btn-delete-prompt').onclick = () => editingPromptId && deletePrompt(editingPromptId);

  // mcp (managed inside the Settings dialog)
  $('#btn-open-mcp').onclick = () => {
    loadSettings();
    loadMcp();
    openModal('#dlg-settings');
    scrollToSection('#mcp-section');
  };
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
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;
    const code = btn.parentElement.querySelector('code');
    navigator.clipboard.writeText(code?.textContent || '').then(() => {
      btn.textContent = 'copied!';
      setTimeout(() => (btn.textContent = 'copy'), 1200);
    });
  });

  // close buttons inside dialogs
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => b.closest('dialog').close();
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
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
  connectApprovalStream();
  // Auth gate: nothing loads until the session is verified.
  let status = null;
  try { status = await fetchAuthStatus(); } catch (e) { console.error(e); }
  state.needsSetup = !!status?.needs_setup;
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
