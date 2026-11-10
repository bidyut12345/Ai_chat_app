import { Router } from 'express';
import { backgroundTasks } from '../services/backgroundTasks.js';

const router = Router();

/**
 * GET /api/tasks?conversation_id=..&all=..
 * List running and recent background tasks.
 */
router.get('/', (req, res) => {
  const convId = req.query.conversation_id ? Number(req.query.conversation_id) : null;
  const all = req.query.all === '1' || req.query.all === 'true';
  const tasks = backgroundTasks.listTasks({ conversationId: convId, all });
  res.json({ tasks, running_count: backgroundTasks.runningCount(convId) });
});

/**
 * GET /api/tasks/:id
 * Get details and output tail for one task.
 */
router.get('/:id', (req, res) => {
  const task = backgroundTasks.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json({ task });
});

/**
 * POST /api/tasks/:id/kill
 * Terminate a running background task process tree.
 */
router.post('/:id/kill', (req, res) => {
  try {
    const outcome = backgroundTasks.killTask(req.params.id);
    res.json(outcome);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

export default router;

