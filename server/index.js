import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, ensureBuiltinServers, DB_PATH } from './db.js';
import settingsRouter from './routes/settings.js';
import promptsRouter from './routes/prompts.js';
import conversationsRouter from './routes/conversations.js';
import { fsRouter, conversationFsRouter } from './routes/files.js';
import chatRouter from './routes/chat.js';
import mcpRouter from './routes/mcp.js';
import approvalsRouter from './routes/approvals.js';
import authRouter from './routes/auth.js';
import { attachUser, requireAuth } from './services/auth.js';
import { connectAll, stopAll } from './services/mcpManager.js';
import { BUILTIN_SERVERS } from './services/builtin/index.js';
import { denyAll } from './services/approvals.js';

import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

/** Real LAN addresses of this machine, for the startup banner. */
function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || [])
      .filter((i) => i.family === 'IPv4' && !i.internal)
      .map((i) => i.address));
}

initDb();
ensureBuiltinServers(Object.entries(BUILTIN_SERVERS).map(([key, def]) => ({ name: key, key })));

const app = express();
app.use(cors());
app.use(express.json({ limit: '256mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, db: DB_PATH, uptime: process.uptime() }));
// Auth: attachUser populates req.user from the cookie on every /api request;
// authRouter (status/register/login) is public; everything after requireAuth.
app.use('/api', attachUser);
app.use('/api/auth', authRouter);
// Everything below requires a valid session.
app.use('/api', requireAuth);
app.use('/api/settings', settingsRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/conversations/:id(\\d+)/fs', conversationFsRouter);
app.use('/api/fs', fsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/mcp', mcpRouter);
app.use('/api/approvals', approvalsRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Centralised error handler
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: err.message || 'internal error' });
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`RiSriGPT  →  http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const a of lanAddresses()) console.log(`               →  http://${a}:${PORT}  (LAN)`);
  }
  console.log(`Database       →  ${DB_PATH}`);
  const results = await connectAll();
  for (const r of results) {
    console.log(`[mcp] ${r.name}: ${r.status}${r.error ? ` (${r.error})` : r.toolCount != null ? ` — ${r.toolCount} tools` : ''}`);
  }
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  denyAll('The app shut down while waiting for your decision.');
  await stopAll().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
