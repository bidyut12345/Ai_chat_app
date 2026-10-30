import { Router } from 'express';
import * as approvals from '../services/approvals.js';
import { sseInit } from '../sse.js';

const router = Router();

// GET /api/approvals -> this user's calls still waiting for an answer
router.get('/', (req, res) => {
  res.json({ pending: approvals.pendingList(req.user.id), grants: approvals.listGrants(req.user.id) });
});

// GET /api/approvals/stream -> live feed, survives reloads and tab switches
router.get('/stream', (req, res) => {
  sseInit(res);
  const unsubscribe = approvals.subscribe(res, req.user.id);
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
    res.end();
  });
});

// POST /api/approvals/:id { allowed, scope: 'once'|'conversation'|'always', reason }
router.post('/:id', (req, res) => {
  const id = String(req.params.id);
  const allowed = !!req.body?.allowed;
  const scope = ['once', 'conversation', 'always'].includes(req.body?.scope) ? req.body.scope : 'once';
  const ok = approvals.resolveApproval(id, { allowed, scope, reason: req.body?.reason }, req.user.id);
  if (!ok) return res.status(404).json({ error: 'That approval has already been answered or has expired.' });
  res.json({ ok: true, allowed, scope });
});

// POST /api/approvals/grants/clear -> forget this user's remembered allowances
router.post('/grants/clear', (req, res) => {
  approvals.clearGrants(req.user.id);
  res.json({ ok: true });
});

export default router;
