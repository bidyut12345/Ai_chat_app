import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, DEFAULT_WORKDIR, POLICY_DEFAULTS, aitempRoot } from '../db.js';
import { normalizeEffort, runtimeConfig } from '../services/openai.js';
import { generateTitle, contextStatus } from '../services/context.js';
import { loadConversation } from '../services/chatService.js';

const router = Router();

const APPROVAL_MODES = ['ask', 'auto'];
const ACCESS_MODES = ['restricted', 'full'];
/** The per-chat tool policy every conversation carries. */
const POLICY_COLUMNS = [
  'workdir',
  'approval_mode',
  'file_access',
  'shell_access',
  'files_enabled',
  'shell_enabled'
];

/**
 * Validate the per-chat policy fields present in `body`, layered over `base`.
 * Returns `{ values }` or `{ error }`.
 */
function policyFromBody(body, base) {
  const out = { ...base };
  if (body.workdir !== undefined) {
    const raw = String(body.workdir || '').trim();
    if (!raw) return { error: 'workdir cannot be empty' };
    const p = path.resolve(raw);
    if (!fs.existsSync(p)) return { error: `Working folder does not exist: ${p}` };
    if (!fs.statSync(p).isDirectory()) return { error: `Working folder is not a directory: ${p}` };
    out.workdir = p;
  }
  if (body.approval_mode !== undefined) {
    const v = String(body.approval_mode);
    if (!APPROVAL_MODES.includes(v)) return { error: `approval_mode must be ${APPROVAL_MODES.join(' or ')}` };
    out.approval_mode = v;
  }
  if (body.file_access !== undefined) {
    const v = String(body.file_access);
    if (!ACCESS_MODES.includes(v)) return { error: `file_access must be ${ACCESS_MODES.join(' or ')}` };
    out.file_access = v;
  }
  if (body.shell_access !== undefined) {
    const v = String(body.shell_access);
    if (!ACCESS_MODES.includes(v)) return { error: `shell_access must be ${ACCESS_MODES.join(' or ')}` };
    out.shell_access = v;
  }
  for (const key of ['files_enabled', 'shell_enabled']) {
    if (body[key] !== undefined) out[key] = body[key] ? 1 : 0;
  }
  return { values: out };
}

/** Fetch a conversation owned by the signed-in user (or null). */
function ownedConv(req, id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(Number(id), req.user.id) || null;
}

function withPrompt(conv) {
  if (!conv) return conv;
  const prompt = conv.prompt_id
    ? db.prepare('SELECT id, name FROM system_prompts WHERE id = ?').get(conv.prompt_id)
    : null;
  return { ...conv, prompt_name: prompt?.name || null };
}

// GET /api/conversations
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT substr(replace(coalesce((SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1), ''), char(10), ' '), 1, 120) AS preview
        ) AS preview
       FROM conversations c
       WHERE c.user_id = ?
       ORDER BY datetime(c.updated_at) DESC, c.id DESC`
    )
    .all(req.user.id);
  res.json(rows.map(withPrompt));
});

// POST /api/conversations { title?, prompt_id?, model?, image_url?, workdir?, approval_mode?,
//                           file_access?, shell_access?, files_enabled?, shell_enabled? }
router.post('/', (req, res) => {
  const { title, prompt_id, model, image_url } = req.body || {};
  const { values, error } = policyFromBody(req.body || {}, { ...POLICY_DEFAULTS, workdir: DEFAULT_WORKDIR });
  if (error) return res.status(400).json({ error });
  const explicitWorkdir = String(req.body?.workdir || '').trim() !== '';
  const info = db
    .prepare(
      `INSERT INTO conversations
        (title, prompt_id, model, image_url, workdir, approval_mode, file_access, shell_access, files_enabled, shell_enabled, reasoning_effort, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title && String(title).trim() ? String(title).trim() : 'New chat',
      prompt_id != null && prompt_id !== '' ? Number(prompt_id) : defaultPromptId(),
      model || null,
      image_url || null,
      values.workdir,
      values.approval_mode,
      values.file_access,
      values.shell_access,
      values.files_enabled,
      values.shell_enabled,
      normalizeEffort(req.body?.reasoning_effort),
      req.user.id
    );
  // Without an explicit folder, give the chat its own auto-created directory
  // under the aitemp parent: {aitemp_root}/{chat id}.
  if (!explicitWorkdir) {
    const auto = path.join(aitempRoot(), String(info.lastInsertRowid));
    try {
      fs.mkdirSync(auto, { recursive: true });
      db.prepare('UPDATE conversations SET workdir = ? WHERE id = ?').run(auto, info.lastInsertRowid);
    } catch {
      // If the folder can't be created, keep the validated default workdir.
    }
  }
  res.status(201).json(withPrompt(db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid)));
});

// GET /api/conversations/:id
router.get('/:id', (req, res) => {
  const conv = ownedConv(req, req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversation not found' });
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conv.id);
  const full = loadConversation(conv.id);
  const ctx = contextStatus(full, runtimeConfig({}));
  res.json({ ...withPrompt(conv), messages, context: ctx });
});

// PATCH /api/conversations/:id { title?, prompt_id?, model?, image_url?, workdir?, approval_mode?,
//                                file_access?, shell_access?, files_enabled?, shell_enabled? }
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const conv = ownedConv(req, id);
  if (!conv) return res.status(404).json({ error: 'conversation not found' });
  const b = req.body || {};
  const base = {};
  for (const col of POLICY_COLUMNS) base[col] = conv[col];
  const { values, error } = policyFromBody(b, base);
  if (error) return res.status(400).json({ error });

  const sets = [
    'title = ?',
    'prompt_id = ?',
    'model = ?',
    'image_url = ?',
    ...POLICY_COLUMNS.map((c) => `${c} = ?`)
  ];
  const params = [
    b.title != null ? String(b.title).trim() || conv.title : conv.title,
    b.prompt_id !== undefined ? (b.prompt_id === null || b.prompt_id === '' ? null : Number(b.prompt_id)) : conv.prompt_id,
    b.model !== undefined ? b.model || null : conv.model,
    b.image_url !== undefined ? b.image_url || null : conv.image_url,
    ...POLICY_COLUMNS.map((c) => values[c])
  ];
  if (b.reasoning_effort !== undefined) {
    sets.push('reasoning_effort = ?');
    params.push(normalizeEffort(b.reasoning_effort));
  }
  // Changing a tool option should not reshuffle the sidebar, so only a real
  // edit of the chat itself counts as activity.
  const touched = ['title', 'prompt_id', 'model', 'image_url', 'reasoning_effort'].some((k) => b[k] !== undefined);
  if (touched) sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  res.json(withPrompt(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)));
});

// POST /api/conversations/:id/generate-title
// Ask the model for a short title from the conversation's first exchange and
// save it. Ignores the current title (explicit user action = always overwrite).
router.post('/:id/generate-title', async (req, res) => {
  const conv = ownedConv(req, req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversation not found' });
  const full = loadConversation(conv.id);
  const cfg = runtimeConfig({});
  if (full.model) cfg.model = full.model;
  if (full.reasoning_effort) cfg.reasoningEffort = full.reasoning_effort;
  if (!cfg.model) return res.status(400).json({ error: 'No model selected. Set a model in Settings first.' });

  // Use the first user message and the assistant reply after it (if any).
  const first = db
    .prepare("SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') AND content != '' ORDER BY id LIMIT 2")
    .all(conv.id);
  const question = first.find((m) => m.role === 'user')?.content || '';
  const answer = first.find((m) => m.role === 'assistant')?.content || '';
  if (!question.trim()) return res.status(400).json({ error: 'Nothing to title yet — send a message first.' });

  const title = await generateTitle(full, cfg, { question, answer });
  if (!title) return res.status(502).json({ error: 'The model did not return a usable title.' });
  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, conv.id);
  res.json(withPrompt(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id)));
});

// DELETE /api/conversations/:id
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'conversation not found' });
  res.json({ ok: true });
});

// POST /api/conversations/:id/messages { role, content, image_url? } -> manual insert (e.g. import)
router.post('/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  if (!ownedConv(req, id)) {
    return res.status(404).json({ error: 'conversation not found' });
  }
  const { role, content, image_url } = req.body || {};
  if (!['user', 'assistant', 'system'].includes(role)) {
    return res.status(400).json({ error: 'role must be user, assistant or system' });
  }
  const info = db
    .prepare('INSERT INTO messages (conversation_id, role, content, image_url) VALUES (?, ?, ?, ?)')
    .run(id, role, String(content ?? ''), image_url || null);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(id);
  res.status(201).json(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid));
});

// DELETE /api/conversations/:id/messages/:messageId
router.delete('/:id/messages/:messageId', (req, res) => {
  if (!ownedConv(req, req.params.id)) return res.status(404).json({ error: 'conversation not found' });
  const info = db
    .prepare('DELETE FROM messages WHERE id = ? AND conversation_id = ?')
    .run(Number(req.params.messageId), Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: 'message not found' });
  res.json({ ok: true });
});

// POST /api/conversations/:id/truncate-after { message_id } -> drop later messages (edit/regenerate)
router.post('/:id/truncate-after', (req, res) => {
  const id = Number(req.params.id);
  if (!ownedConv(req, id)) return res.status(404).json({ error: 'conversation not found' });
  const messageId = Number(req.body?.message_id);
  if (!Number.isFinite(messageId)) return res.status(400).json({ error: 'message_id is required' });
  const info = db
    .prepare('DELETE FROM messages WHERE conversation_id = ? AND id >= ?')
    .run(id, messageId);
  res.json({ ok: true, removed: info.changes });
});

function defaultPromptId() {
  const row =
    db.prepare('SELECT id FROM system_prompts WHERE is_default = 1 ORDER BY id LIMIT 1').get() ||
    db.prepare('SELECT id FROM system_prompts ORDER BY id LIMIT 1').get();
  return row ? row.id : null;
}

export default router;
