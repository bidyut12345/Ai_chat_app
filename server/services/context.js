/**
 * Context management: estimate prompt size and keep it within a working budget
 * by rolling older turns into a stored summary ("auto-compress").
 *
 * Why this exists: a chat re-sends its whole history every turn, and tool
 * results (up to 16k chars each) accumulate fast — long tool-using sessions
 * were reaching 200k+ prompt tokens, which costs minutes just to prefill. Once
 * the estimated prompt crosses the configured budget, the oldest turns that are
 * not already summarized are condensed into a running summary held on the
 * conversation, and only recent turns are replayed verbatim after it.
 */
import { db } from '../db.js';
import { chatCompletion } from './openai.js';

// Rough token estimate: ~4 chars/token plus per-message overhead. No tokenizer
// is available, and being a little conservative (over-counting) is safe — it
// just compresses slightly earlier.
const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 4;
const IMAGE_TOKENS = 1000;

/** Estimate tokens for a list of OpenAI-shaped messages. */
export function estimateTokens(messages) {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === 'text' && typeof part.text === 'string') chars += part.text.length;
        else if (part?.type === 'image_url' || m.image_url) images++;
      }
    }
    if (m.image_url) images++;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    chars += PER_MESSAGE_OVERHEAD;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

/**
 * Decide whether the conversation should compress, and if so, the message id up
 * to which we should summarize. Keeps the most recent `keepTokens` worth of
 * turns verbatim and never splits an assistant tool-call from its results.
 *
 * @returns {number|null} the max message id to summarize, or null if no action.
 */
export function chooseCompressCutoff(conversationId, { summarizedUpto, keepTokens }) {
  const rows = db
    .prepare('SELECT id, role, content, tool_calls, tool_call_id FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id')
    .all(conversationId, summarizedUpto || 0);
  if (rows.length < 4) return null; // nothing meaningful to compress yet

  // Walk from the newest backwards, accumulating tokens, until we exceed the
  // keep budget. The cutoff is the id just before that point.
  let acc = 0;
  let cutoff = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    acc += estimateTokens([rowToMessage(rows[i])]);
    if (acc > keepTokens) break;
    cutoff = rows[i].id;
  }
  // cutoff = id of the oldest message we keep. Summarize everything older.
  if (cutoff == null) return null;
  const summarizeUpTo = cutoff - 1;
  // Must actually be summarizing at least one already-eligible message.
  if (summarizeUpTo <= (summarizedUpto || 0)) return null;
  return clampToGroup(conversationId, summarizeUpTo);
}

/**
 * Never cut between an assistant message that has tool_calls and its matching
 * tool results — move the cutoff back to before the assistant tool-call row so
 * the kept region still opens cleanly (and the summarized region closes on a
 * complete exchange).
 */
function clampToGroup(conversationId, summarizeUpTo) {
  const rows = db
    .prepare('SELECT id, role, tool_calls, tool_call_id FROM messages WHERE conversation_id = ? ORDER BY id')
    .all(conversationId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kept = rows.filter((r) => r.id > summarizeUpTo);
  // If the first kept row is a tool result, its assistant call is on the wrong
  // side of the cut. Pull the cutoff back until the kept region starts clean.
  let cut = summarizeUpTo;
  let guard = 0;
  while (kept.length && kept[0].role === 'tool' && guard++ < 100) {
    // Find the assistant row that owns this tool_call_id and cut before it.
    const owner = rows.find((r) => r.role === 'assistant' && r.tool_calls && r.id <= cut);
    if (!owner) break;
    cut = owner.id - 1;
    kept.length = 0;
    for (const r of rows) if (r.id > cut) kept.push(r);
  }
  // Also avoid leaving an assistant tool-call at the very end of the summarized
  // region with its results on the kept side. Step back over such a call.
  while (guard++ < 200) {
    const lastSummarized = byId.get(cut);
    if (lastSummarized && lastSummarized.role === 'assistant' && lastSummarized.tool_calls) cut -= 1;
    else break;
  }
  return cut;
}

function rowToMessage(r) {
  if (r.role === 'tool') return { role: 'tool', tool_call_id: r.tool_call_id, content: r.content || '' };
  const m = { role: r.role, content: r.content || '' };
  if (r.tool_calls) m.tool_calls = r.tool_calls;
  return m;
}

const SUMMARY_SYSTEM =
  'You compress conversation history. Merge the EXISTING SUMMARY with the ' +
  'NEW TURNS into a single tighter summary (≤ 400 words). Preserve: user goals, ' +
  'decisions, file paths, key facts, tool outcomes, and any open questions. ' +
  'Drop pleasantries and verbose tool dumps but keep their important results. ' +
  'Output only the summary text.';

/** Render messages-to-summarize into a compact transcript for the model. */
function transcriptFrom(conversationId, summarizedUpto, summarizeUpTo) {
  const rows = db
    .prepare('SELECT role, content, tool_calls FROM messages WHERE conversation_id = ? AND id > ? AND id <= ? ORDER BY id')
    .all(conversationId, summarizedUpto || 0, summarizeUpTo);
  const lines = [];
  for (const r of rows) {
    if (r.role === 'system') continue;
    if (r.role === 'tool') { lines.push(`[tool result] ${clip(r.content, 800)}`); continue; }
    let line = `${r.role}: ${clip(r.content, 2000)}`;
    if (r.tool_calls) {
      try {
        const tcs = typeof r.tool_calls === 'string' ? JSON.parse(r.tool_calls) : r.tool_calls;
        const names = tcs.map((t) => t.function?.name).filter(Boolean).join(', ');
        if (names) line += ` [called: ${names}]`;
      } catch { /* ignore */ }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Compress the conversation if it exceeds the budget. Called before the first
 * upstream request of a turn. Mutates the stored summary/summarized_upto and
 * returns { compressed, tokensBefore, tokensAfter, error? }.
 *
 * @param {object} conversation the conversation row (has id, summary, summarized_upto)
 * @param {object} cfg runtime config (baseUrl, model, apiKey, contextBudget, compressKeep)
 * @param {(event,data)=>void} emit stream events (for a 'compressed' notice)
 * @param {AbortSignal} signal abort if the user stops
 */
export async function maybeCompress(conversation, cfg, emit = () => {}, signal) {
  // Sliding-window policy: keep at most `contextKeep` tokens of the most recent
  // turns verbatim and roll everything older into the summary. The window is
  // the trigger too, so the prompt is trimmed on every turn that would exceed
  // it — we never re-send the whole conversation. `contextCompressAt` is now an
  // optional *earlier* hard cap (only used if it is smaller than the window).
  const window = cfg.contextKeep || 0;
  if (!window) return { compressed: false, tokensBefore: 0, tokensAfter: 0 };

  const cap = cfg.contextCompressAt || 0;
  const trigger = cap && cap < window ? cap : window;

  const summarizedUpto = conversation.summarized_upto || 0;
  const before = currentPromptTokens(conversation, summarizedUpto);
  if (before <= trigger) return { compressed: false, tokensBefore: before, tokensAfter: before };

  const keepTokens = window;
  const cutoff = chooseCompressCutoff(conversation.id, { summarizedUpto, keepTokens });
  if (cutoff == null) return { compressed: false, tokensBefore: before, tokensAfter: before, skipped: 'nothing-eligible' };

  const transcript = transcriptFrom(conversation.id, summarizedUpto, cutoff);
  if (!transcript.trim()) return { compressed: false, tokensBefore: before, tokensAfter: before, skipped: 'empty' };

  emit('notice', { message: 'Compressing older context…' });

  const userMsg =
    (conversation.summary ? `EXISTING SUMMARY:\n${conversation.summary}\n\n` : '') +
    `NEW TURNS TO FOLD IN:\n${transcript}`;

  try {
    const json = await chatCompletion(cfg, {
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      max_tokens: 700,
      temperature: 0.2,
      stream: false
    }, { signal });
    const text = (json?.choices?.[0]?.message?.content || '').trim();
    if (!text) return { compressed: false, tokensBefore: before, tokensAfter: before, error: 'empty summary' };
    db.prepare('UPDATE conversations SET summary = ?, summarized_upto = ? WHERE id = ?').run(text, cutoff, conversation.id);
    conversation.summary = text;
    conversation.summarized_upto = cutoff;
    const after = currentPromptTokens(conversation, cutoff);
    emit('compressed', { before_tokens: before, after_tokens: after, summarized_upto: cutoff });
    return { compressed: true, tokensBefore: before, tokensAfter: after };
  } catch (e) {
    // Summarization failed (server error/aborted). Do not lose data — leave the
    // history intact; the turn proceeds with full context as before.
    return { compressed: false, tokensBefore: before, tokensAfter: before, error: e.message };
  }
}

/**
 * Manually compact a conversation NOW, regardless of whether it has crossed the
 * auto-compress threshold. Used by the "Compact now" button. Rolls everything
 * older than the recent keep-window into the running summary, exactly like the
 * automatic path but without the "is it big enough yet?" check.
 *
 * @returns {compressed, tokensBefore, tokensAfter, skipped?, error?}
 */
export async function compressNow(conversation, cfg, emit = () => {}, signal) {
  const window = cfg.contextKeep || 0;
  if (!window) return { compressed: false, tokensBefore: 0, tokensAfter: 0, skipped: 'window-disabled' };

  const summarizedUpto = conversation.summarized_upto || 0;
  const before = currentPromptTokens(conversation, summarizedUpto);

  const cutoff = chooseCompressCutoff(conversation.id, { summarizedUpto, keepTokens: window });
  if (cutoff == null) return { compressed: false, tokensBefore: before, tokensAfter: before, skipped: 'nothing-eligible' };

  const transcript = transcriptFrom(conversation.id, summarizedUpto, cutoff);
  if (!transcript.trim()) return { compressed: false, tokensBefore: before, tokensAfter: before, skipped: 'empty' };

  emit('notice', { message: 'Compressing older context…' });
  const userMsg =
    (conversation.summary ? `EXISTING SUMMARY:\n${conversation.summary}\n\n` : '') +
    `NEW TURNS TO FOLD IN:\n${transcript}`;

  try {
    const json = await chatCompletion(cfg, {
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userMsg }
      ],
      max_tokens: 700,
      temperature: 0.2,
      stream: false
    }, { signal });
    const text = (json?.choices?.[0]?.message?.content || '').trim();
    if (!text) return { compressed: false, tokensBefore: before, tokensAfter: before, error: 'empty summary' };
    db.prepare('UPDATE conversations SET summary = ?, summarized_upto = ? WHERE id = ?').run(text, cutoff, conversation.id);
    conversation.summary = text;
    conversation.summarized_upto = cutoff;
    const after = currentPromptTokens(conversation, cutoff);
    emit('compressed', { before_tokens: before, after_tokens: after, summarized_upto: cutoff });
    return { compressed: true, tokensBefore: before, tokensAfter: after };
  } catch (e) {
    return { compressed: false, tokensBefore: before, tokensAfter: before, error: e.message };
  }
}

const TRIMMED_TOOL_NOTE = '[older tool result trimmed to fit the context window]';

/**
 * Keep an in-flight message array within a token budget WITHOUT an extra model
 * call. Used inside the tool loop: a single turn can fire dozens of tool calls,
 * each returning up to 16k chars, so the live `messages` array can balloon to
 * hundreds of thousands of tokens even though the stored history was already
 * window-trimmed at turn start.
 *
 * Strategy: walk newest→oldest and, once past the keep budget, replace the body
 * of older `tool` results with a short note. Message objects are never removed
 * (that would orphan an assistant tool_call or a tool result and break strict
 * servers) — only their bulky text is elided. Returns true if anything changed.
 *
 * Mutates `messages` in place.
 */
export function trimMessagesInPlace(messages, keepTokens) {
  const budget = keepTokens || 0;
  if (!budget) return false;
  if (estimateTokens(messages) <= budget) return false;
  // Count tokens contributed by the messages we always keep verbatim (the most
  // recent ones up to the budget). Anything older is a candidate for eliding.
  let acc = 0;
  let changed = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const size = estimateTokens([m]);
    if (acc + size <= budget) {
      acc += size;
      continue;
    }
    // Over budget. Elide bulky tool-result bodies; leave short/structural msgs.
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > TRIMMED_TOOL_NOTE.length) {
      m.content = TRIMMED_TOOL_NOTE;
      changed = true;
    }
  }
  return changed;
}

/** Estimated prompt tokens for the conversation given a summary split point. */
function currentPromptTokens(conversation, summarizedUpto) {
  const msgs = [];
  if (conversation.summary) msgs.push({ role: 'system', content: conversation.summary });
  const rows = db
    .prepare('SELECT role, content, image_url, tool_calls, tool_call_id FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id')
    .all(conversation.id, summarizedUpto || 0);
  const liveIds = new Set();
  for (const r of rows) {
    if (r.role === 'system') continue;
    if (r.role === 'tool') { if (r.tool_call_id && liveIds.has(r.tool_call_id)) msgs.push({ role: 'tool', content: r.content || '' }); continue; }
    const m = { role: r.role, content: r.content || '' };
    if (r.image_url) m.image_url = r.image_url;
    if (r.role === 'assistant' && r.tool_calls) {
      try { const tcs = typeof r.tool_calls === 'string' ? JSON.parse(r.tool_calls) : r.tool_calls; if (Array.isArray(tcs)) { m.tool_calls = tcs; for (const t of tcs) liveIds.add(t.id); } } catch { /* ignore */ }
    }
    msgs.push(m);
  }
  return estimateTokens(msgs);
}
