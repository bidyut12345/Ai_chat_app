import { Router } from 'express';
import { db } from '../db.js';
import * as mcp from '../services/mcpManager.js';
import { runWithPolicy } from '../services/builtin/policy.js';
import { requireAdmin } from '../services/auth.js';

const router = Router();

const TRANSPORTS = ['stdio', 'http', 'sse', 'builtin'];
const APPROVALS = ['auto', 'always', 'never'];

function normApproval(v) {
  const s = String(v || 'auto').toLowerCase();
  return APPROVALS.includes(s) ? s : 'auto';
}

function parseJson(v, fallback) {
  try {
    return JSON.parse(v) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Built-in servers ship with the app: they can be turned off, not reconfigured or deleted. */
function isProtected(row) {
  return row.transport === 'builtin';
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    builtin_key: row.builtin_key || null,
    builtin: isProtected(row),
    approval: row.approval || 'auto',
    command: row.command,
    args: parseJson(row.args, []),
    url: row.url,
    headers: parseJson(row.headers, {}),
    env: parseJson(row.env, {}),
    enabled: !!row.enabled
  };
}

// GET /api/mcp -> configured servers with live status + discovered tools.
// Any signed-in user may read the list (the per-chat tool menu needs it), but
// env/headers are only included for admins.
router.get('/', (req, res) => {
  res.json(mcp.statusList({ includeSecrets: !!req.user.is_admin }));
});

// POST /api/mcp/tools/refresh -> reconnect all enabled servers and return tools
router.post('/tools/refresh', requireAdmin, async (req, res) => {
  const results = await mcp.connectAll();
  res.json({ results, tools: mcp.allTools() });
});

// POST /api/mcp/connect-all
router.post('/connect-all', requireAdmin, async (req, res) => {
  res.json({ results: await mcp.connectAll() });
});

// POST /api/mcp { name, transport, command, args[], url, headers{}, env{}, enabled }
// NOTE: stdio servers run arbitrary commands on this host, so every mutation
// below is admin-only.
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const transport = String(b.transport || 'stdio').toLowerCase();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'name may only contain letters, numbers, dash and underscore (used as tool namespace)' });
  }
  if (!TRANSPORTS.includes(transport) || transport === 'builtin') {
    return res.status(400).json({ error: `transport must be one of stdio, http, sse` });
  }
  if (transport === 'stdio' && !String(b.command || '').trim()) {
    return res.status(400).json({ error: 'command is required for stdio transport' });
  }
  if (transport !== 'stdio' && !/^https?:\/\//i.test(String(b.url || '').trim())) {
    return res.status(400).json({ error: 'url (http/https) is required for remote transports' });
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO mcp_servers (name, transport, command, args, url, headers, env, enabled, approval)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        transport,
        String(b.command || '').trim() || null,
        JSON.stringify(Array.isArray(b.args) ? b.args : parseJson(b.args, [])),
        String(b.url || '').trim() || null,
        JSON.stringify(b.headers && typeof b.headers === 'object' ? b.headers : parseJson(b.headers, {})),
        JSON.stringify(b.env && typeof b.env === 'object' ? b.env : parseJson(b.env, {})),
        b.enabled === false ? 0 : 1,
        normApproval(b.approval)
      );
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(info.lastInsertRowid);
    let connect = null;
    if (row.enabled) {
      try {
        await mcp.connectServer(row);
        connect = { status: 'connected' };
      } catch (e) {
        connect = { status: 'error', error: e.message };
      }
    }
    res.status(201).json({ ...shape(row), connect });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: `a server named "${name}" already exists` });
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/mcp/:id  (updates and reconnects)  (admin)
router.put('/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'mcp server not found' });
  const b = req.body || {};
  if (isProtected(row)) {
    const allowedFields = new Set(['enabled', 'approval']);
    const bad = Object.keys(b).filter((k) => !allowedFields.has(k));
    if (bad.length) {
      return res.status(400).json({ error: `"${row.name}" is built in - only its on/off switch and approval policy can change.` });
    }
    db.prepare('UPDATE mcp_servers SET enabled = ?, approval = ? WHERE id = ?')
      .run(b.enabled != null ? (b.enabled ? 1 : 0) : row.enabled, normApproval(b.approval ?? row.approval), id);
    await mcp.disconnectServer(row.name);
    const toggled = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    let connect = { status: 'disabled' };
    if (toggled.enabled) {
      try {
        await mcp.connectServer(toggled);
        connect = { status: 'connected' };
      } catch (e) {
        connect = { status: 'error', error: e.message };
      }
    }
    return res.json({ ...shape(toggled), connect });
  }
  const next = {
    name: b.name != null ? String(b.name).trim() : row.name,
    transport: b.transport != null ? String(b.transport).toLowerCase() : row.transport,
    command: b.command != null ? String(b.command).trim() || null : row.command,
    url: b.url != null ? String(b.url).trim() || null : row.url,
    args: b.args != null ? JSON.stringify(Array.isArray(b.args) ? b.args : parseJson(b.args, [])) : row.args,
    headers: b.headers != null ? JSON.stringify(b.headers || {}) : row.headers,
    env: b.env != null ? JSON.stringify(b.env || {}) : row.env,
    enabled: b.enabled != null ? (b.enabled ? 1 : 0) : row.enabled,
    approval: b.approval != null ? normApproval(b.approval) : normApproval(row.approval)
  };
  if (!TRANSPORTS.includes(next.transport)) return res.status(400).json({ error: 'invalid transport' });
  if (!next.name) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    db.prepare(
      `UPDATE mcp_servers SET name=?, transport=?, command=?, url=?, args=?, headers=?, env=?, enabled=?, approval=? WHERE id=?`
    ).run(next.name, next.transport, next.command, next.url, next.args, next.headers, next.env, next.enabled, next.approval, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: `a server named "${next.name}" already exists` });
    throw e;
  }
  await mcp.disconnectServer(row.name);
  const updated = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  let connect = { status: 'disabled' };
  if (updated.enabled) {
    try {
      await mcp.connectServer(updated);
      connect = { status: 'connected' };
    } catch (e) {
      connect = { status: 'error', error: e.message };
    }
  }
  res.json({ ...shape(updated), connect });
});

// POST /api/mcp/:id/connect
router.post('/:id/connect', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'mcp server not found' });
  try {
    const r = await mcp.connectServer(row);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/mcp/:id/disconnect
router.post('/:id/disconnect', requireAdmin, async (req, res) => {
  await mcp.disconnectServer(db.prepare('SELECT name FROM mcp_servers WHERE id = ?').get(Number(req.params.id))?.name);
  res.json({ ok: true });
});

// POST /api/mcp/:id/tools  -> re-list tools  (admin)
router.post('/:id/tools', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'mcp server not found' });
  try {
    await mcp.connectServer(row);
    const entry = mcp.statusList({ includeSecrets: true }).find((s) => s.name === row.name);
    res.json({ tools: entry?.tools || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/mcp/:id/call { tool, arguments, policy? } -> direct test call  (admin).
// `policy` optionally scopes the call the way a chat would:
// { workdir, file_access, shell_access, approval_mode }.
router.post('/:id/call', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'mcp servers not found' });
  const tool = String(req.body?.tool || '');
  if (!tool) return res.status(400).json({ error: 'tool is required' });
  const policy = req.body?.policy;
  if (policy && typeof policy !== 'object') {
    return res.status(400).json({ error: 'policy must be an object' });
  }
  try {
    const run = () => mcp.callTool(`${row.name}__${tool}`, req.body?.arguments ?? {});
    const result = policy ? await runWithPolicy(policy, run) : await run();
    res.json({ result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// DELETE /api/mcp/:id  (admin)
router.delete('/:id', requireAdmin, async (req, res) => {
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'mcp server not found' });
  if (isProtected(row)) {
    return res.status(400).json({ error: `"${row.name}" is built in and cannot be deleted. Switch it off instead.` });
  }
  await mcp.disconnectServer(row.name);
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

export default router;
