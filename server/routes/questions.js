import express from 'express';
import { listPendingQuestions, resolveQuestion, cancelQuestion, subscribeQuestions } from '../services/questions.js';

const router = express.Router();

/**
 * GET /api/questions/pending?conversation_id=..
 * List any pending questions currently awaiting an answer.
 */
router.get('/pending', (req, res) => {
  const convId = req.query.conversation_id ? Number(req.query.conversation_id) : null;
  const questions = listPendingQuestions(req.user?.id, convId);
  res.json({ questions });
});

/**
 * POST /api/questions/:id/answer
 * Answer a pending question.
 */
router.post('/:id/answer', (req, res) => {
  const id = req.params.id;
  const { answers } = req.body || {};
  const ok = resolveQuestion(id, { answers }, req.user?.id);
  if (!ok) {
    return res.status(404).json({ error: 'Question not found or already answered.' });
  }
  res.json({ ok: true });
});

/**
 * POST /api/questions/:id/cancel
 * Cancel / skip a pending question.
 */
router.post('/:id/cancel', (req, res) => {
  const id = req.params.id;
  const { reason } = req.body || {};
  const ok = cancelQuestion(id, reason, req.user?.id);
  if (!ok) {
    return res.status(404).json({ error: 'Question not found or already answered.' });
  }
  res.json({ ok: true });
});

/**
 * GET /api/questions/stream
 * SSE stream for question prompts and resolutions across pages / tabs.
 */
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const unsubscribe = subscribeQuestions(res, req.user?.id);
  req.on('close', () => unsubscribe());
});

export default router;

