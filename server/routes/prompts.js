import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

// GET /api/prompts
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM system_prompts ORDER BY is_default DESC, name').all();
  res.json(rows.map((r) => ({ ...r, is_default: !!r.is_default })));
});

// POST /api/prompts { name, content, description, is_default }
router.post('/', (req, res) => {
  const { name, content, description = '', is_default = false } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
  try {
    const info = db
      .prepare('INSERT INTO system_prompts (name, description, content, is_default) VALUES (?, ?, ?, ?)')
      .run(String(name).trim(), String(description), String(content), is_default ? 1 : 0);
    if (is_default) db.prepare('UPDATE system_prompts SET is_default = 0 WHERE id != ?').run(info.lastInsertRowid);
    res.status(201).json(db.prepare('SELECT * FROM system_prompts WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/prompts/:id
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM system_prompts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'prompt not found' });
  const body = req.body || {};
  const name = body.name != null ? String(body.name).trim() : existing.name;
  const content = body.content != null ? String(body.content) : existing.content;
  const description = body.description != null ? String(body.description) : existing.description;
  if (!name) return res.status(400).json({ error: 'name cannot be empty' });
  if (!content.trim()) return res.status(400).json({ error: 'content cannot be empty' });
  db.prepare(
    'UPDATE system_prompts SET name = ?, description = ?, content = ?, is_default = ?, updated_at = datetime(\'now\') WHERE id = ?'
  ).run(name, description, content, body.is_default != null ? (body.is_default ? 1 : 0) : existing.is_default, id);
  if (body.is_default) db.prepare('UPDATE system_prompts SET is_default = 0 WHERE id != ?').run(id);
  res.json(db.prepare('SELECT * FROM system_prompts WHERE id = ?').get(id));
});

// POST /api/prompts/:id/default -> make it the default prompt
router.post('/:id/default', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM system_prompts WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'prompt not found' });
  }
  db.transaction(() => {
    db.prepare('UPDATE system_prompts SET is_default = 0').run();
    db.prepare("UPDATE system_prompts SET is_default = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  })();
  res.json({ ok: true });
});

// DELETE /api/prompts/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM system_prompts WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'prompt not found' });
  // Never leave the app without a default persona.
  if (!db.prepare('SELECT id FROM system_prompts WHERE is_default = 1 LIMIT 1').get()) {
    const first = db.prepare('SELECT id FROM system_prompts ORDER BY id LIMIT 1').get();
    if (first) db.prepare('UPDATE system_prompts SET is_default = 1 WHERE id = ?').run(first.id);
  }
  res.json({ ok: true });
});

export default router;
