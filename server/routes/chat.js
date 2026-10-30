import { Router } from 'express';
import { db } from '../db.js';
import { sseInit } from '../sse.js';
import { runtimeConfig } from '../services/openai.js';
import { loadConversation } from '../services/chatService.js';
import { compressNow, normalizeCompactLevel, contextStatus } from '../services/context.js';
import { startRun, subscribe, stopRun, cancelToolCall, activeRuns } from '../services/runManager.js';

const router = Router();

/** Build the effective config for a turn: global settings, then chat overrides. */
function turnConfig(conversation, body) {
  const cfg = runtimeConfig({
    model: body?.model,
    temperature: body?.temperature,
    maxTokens: body?.max_tokens,
    reasoningEffort: body?.reasoning_effort
  });
  if (conversation.model) cfg.model = conversation.model;
  if (conversation.reasoning_effort) cfg.reasoningEffort = conversation.reasoning_effort;
  return cfg;
}

/**
 * POST /api/chat
 * {
 *   conversation_id: number,
 *   content?: string,          // user message text (omit when regenerate=true)
 *   image_url?: string,        // optional image for vision-capable servers
 *   regenerate?: boolean,      // drop the last assistant reply and re-answer
 *   continue?: boolean,        // continue the last assistant reply without a new user turn
 *   use_tools?: boolean,       // expose connected MCP tools (default true)
 *   extra_system?: string,     // one-off instruction appended to the system prompt
 *   model?, temperature?, max_tokens?, reasoning_effort?
 * }
 *
 * The turn runs in the background (see runManager) — this request only records
 * the user message and kicks the run off, then answers with a small JSON ack.
 * The browser watches the events on GET /api/chat/stream. Closing this (or any)
 * connection never stops the generation.
 */
router.post('/', async (req, res) => {
  const { conversation_id, content, image_url, regenerate = false, continue: cont = false, use_tools = true, extra_system } = req.body || {};

  const conversation = loadConversation(Number(conversation_id));
  if (!conversation || conversation.user_id !== req.user.id) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  if (cont && regenerate) {
    return res.status(400).json({ error: 'continue and regenerate cannot be combined' });
  }
  if (cont) {
    const last = db
      .prepare('SELECT role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
      .get(conversation.id);
    if (!last || last.role !== 'assistant') {
      return res.status(400).json({ error: 'The last message is not an assistant reply to continue.' });
    }
  }

  const cfg = turnConfig(conversation, req.body);
  if (!cfg.model) {
    return res.status(400).json({ error: 'No model selected. Set a model in Settings (or pick one for this chat).' });
  }

  // A turn can only have one reply in flight. Without this check a second
  // message would be stored *before* the running reply and never answered,
  // because startRun() joins the existing run instead of starting a new one.
  if (activeRuns().some((r) => r.conversation_id === conversation.id)) {
    return res.status(409).json({
      error: 'A reply is already being generated for this chat. Wait for it to finish or press Stop.'
    });
  }

  // A chat is "untitled" until the user names it or it gets its first message.
  // We title that first turn with AI after the reply, so capture the moment here.
  const wasUntitled = !conversation.title || conversation.title === 'New chat';

  // The message this turn belongs to. File changes are recorded against it so
  // the browser can show a diff under the user message that asked for them.
  let turnMessageId = null;

  if (regenerate) {
    // Remove the trailing assistant message so the model answers again — but
    // only when it belongs to the last user turn. Regenerating an *older* user
    // message (the browser truncates everything after it first) must not delete
    // that turn's own reply.
    const lastUser = db
      .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(conversation.id);
    const last = db
      .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(conversation.id);
    if (last && (!lastUser || last.id > lastUser.id)) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);
    }
  } else if (!cont) {
    const text = String(content ?? '').trim();
    if (!text && !image_url) {
      return res.status(400).json({ error: 'content is required' });
    }
    const info = db.prepare('INSERT INTO messages (conversation_id, role, content, image_url) VALUES (?, ?, ?, ?)').run(
      conversation.id,
      'user',
      text,
      image_url || null
    );
    turnMessageId = Number(info.lastInsertRowid);
    // Immediate placeholder so the sidebar isn't a row of "New chat" while the
    // AI title is generated after the reply.
    if (wasUntitled) autoTitle(conversation, text);
  }

  // Regenerate / continue have no new user row: attribute their file changes to
  // the most recent user message.
  if (turnMessageId == null) {
    const lastUser = db
      .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
      .get(conversation.id);
    turnMessageId = lastUser ? Number(lastUser.id) : null;
  }

  // A continuation is a normal turn without a user row: the stored history
  // already ends with the partial reply, so the model just picks it up. The
  // instruction is appended to the system prompt for this turn only.
  const continuation = cont
    ? 'Continue the previous assistant reply exactly where it stopped. Do not repeat text that is already there, do not apologize, and do not start over. If it stopped mid-sentence, resume mid-sentence.'
    : null;
  const extraSystem = [extra_system, continuation].filter(Boolean).join('\n\n') || undefined;

  // The sidebar sorts by updated_at, so a new turn must bubble the chat up.
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation.id);

  const run = startRun({
    conversation,
    cfg,
    useTools: use_tools !== false,
    extraSystem,
    // Name the chat with AI after the first turn (only when it's still untitled
    // and this is a fresh user message, not a regenerate/continue).
    aiTitle: wasUntitled && !regenerate && !cont ? String(content ?? '').trim() : null,
    turnMessageId
  });

  res.json({ ok: true, running: true, conversation_id: conversation.id, started_at: run.startedAt });
});

/**
 * GET /api/chat/stream?conversation_id=..&last_event_id=..  (SSE)
 *
 * Attach to a running generation, replaying any events after `last_event_id`.
 * Safe to reconnect at any time; used both for live watching and to resume
 * after switching conversations or reloading. 404s when nothing is running.
 */
router.get('/stream', (req, res) => {
  const id = Number(req.query.conversation_id);
  if (!Number.isFinite(id)) return res.status(400).end();
  const owns = db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!owns) return res.status(404).end();
  const lastEventId = Number(req.query.last_event_id) || 0;
  sseInit(res);
  if (!subscribe(id, lastEventId, res)) {
    // Nothing running for this conversation.
    res.write('event: idle\ndata: {}\n\n');
    res.end();
  }
});

/** GET /api/chat/running -> list of conversations with a generation in flight. */
router.get('/running', (req, res) => {
  const runs = activeRuns().filter((r) => db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(r.conversation_id, req.user.id));
  res.json({ runs });
});

/** POST /api/chat/stop { conversation_id } -> abort a running generation. */
router.post('/stop', (req, res) => {
  const id = Number(req.body?.conversation_id);
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(id, req.user.id)) {
    return res.status(404).json({ error: 'conversation not found' });
  }
  const stopped = stopRun(id);
  res.json({ ok: true, stopped });
});

/**
 * POST /api/chat/stop-tool { conversation_id, call_id }
 * Cancel a single in-flight tool call. The turn continues; the model is told
 * the user cancelled this call and must not retry it.
 */
router.post('/stop-tool', (req, res) => {
  const id = Number(req.body?.conversation_id);
  if (!db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(id, req.user.id)) {
    return res.status(404).json({ error: 'conversation not found' });
  }
  const cancelled = cancelToolCall(id, req.body?.call_id);
  res.json({ ok: true, cancelled });
});

/**
 * POST /api/chat/compact { conversation_id }
 * Manually roll older turns into the summary right now, without waiting for the
 * auto-compress threshold. Refuses while a generation is running for this chat
 * (compacting mid-turn would change the context the model is answering against).
 */
router.post('/compact', async (req, res) => {
  const id = Number(req.body?.conversation_id);
  const conversation = loadConversation(id);
  if (!conversation || conversation.user_id !== req.user.id) {
    return res.status(404).json({ error: 'conversation not found' });
  }
  if (activeRuns().some((r) => r.conversation_id === id)) {
    return res.status(409).json({ error: 'Stop the current generation before compacting.' });
  }
  const cfg = turnConfig(conversation, {});
  if (!cfg.model) return res.status(400).json({ error: 'No model selected. Set a model in Settings first.' });
  const level = normalizeCompactLevel(req.body?.level);
  const result = await compressNow(conversation, cfg, () => {}, undefined, level);
  if (result.error) return res.status(502).json({ error: result.error });
  res.json({
    ok: true,
    compressed: !!result.compressed,
    skipped: result.skipped || null,
    level,
    before_tokens: result.tokensBefore || 0,
    after_tokens: result.tokensAfter || 0,
    context: contextStatus(conversation, cfg)
  });
});

function autoTitle(conversation, text) {
  if (conversation.title && conversation.title !== 'New chat') return;
  const base = text.replace(/\s+/g, ' ').trim();
  if (!base) return;
  const title = base.length > 48 ? `${base.slice(0, 48).trimEnd()}…` : base;
  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, conversation.id);
}

export default router;
