import { Router } from 'express';
import { db } from '../db.js';
import { sseInit } from '../sse.js';
import { runtimeConfig } from '../services/openai.js';
import { loadConversation } from '../services/chatService.js';
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
  const { conversation_id, content, image_url, regenerate = false, use_tools = true, extra_system } = req.body || {};

  const conversation = loadConversation(Number(conversation_id));
  if (!conversation) {
    return res.status(404).json({ error: 'conversation not found' });
  }

  const cfg = turnConfig(conversation, req.body);
  if (!cfg.model) {
    return res.status(400).json({ error: 'No model selected. Set a model in Settings (or pick one for this chat).' });
  }

  if (regenerate) {
    // Remove the trailing assistant message so the model answers again.
    const last = db
      .prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(conversation.id);
    if (last) db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);
  } else {
    const text = String(content ?? '').trim();
    if (!text && !image_url) {
      return res.status(400).json({ error: 'content is required' });
    }
    db.prepare('INSERT INTO messages (conversation_id, role, content, image_url) VALUES (?, ?, ?, ?)').run(
      conversation.id,
      'user',
      text,
      image_url || null
    );
    autoTitle(conversation, text);
  }

  const run = startRun({
    conversation,
    cfg,
    useTools: use_tools !== false,
    extraSystem: extra_system
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
  res.json({ runs: activeRuns() });
});

/** POST /api/chat/stop { conversation_id } -> abort a running generation. */
router.post('/stop', (req, res) => {
  const stopped = stopRun(Number(req.body?.conversation_id));
  res.json({ ok: true, stopped });
});

/**
 * POST /api/chat/stop-tool { conversation_id, call_id }
 * Cancel a single in-flight tool call. The turn continues; the model is told
 * the user cancelled this call and must not retry it.
 */
router.post('/stop-tool', (req, res) => {
  const cancelled = cancelToolCall(Number(req.body?.conversation_id), req.body?.call_id);
  res.json({ ok: true, cancelled });
});

function autoTitle(conversation, text) {
  if (conversation.title && conversation.title !== 'New chat') return;
  const base = text.replace(/\s+/g, ' ').trim();
  if (!base) return;
  const title = base.length > 48 ? `${base.slice(0, 48).trimEnd()}…` : base;
  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, conversation.id);
}

export default router;
