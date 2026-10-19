/**
 * Filesystem helpers for the browser UI.
 *
 *  /api/fs/**            - used by the working-folder picker. Sees the server's
 *                          own disk (directories only, never file contents),
 *                          because the folder has to exist on this machine.
 *  /api/conversations/:id/fs/**
 *                        - the per-chat file manager. Every path goes through
 *                          the conversation's own policy, so a chat in
 *                          "restricted" mode cannot read outside its folder.
 */
import { Router } from 'express';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '../db.js';
import { runWithPolicy, resolvePath, fileRoot, PolicyError } from '../services/builtin/policy.js';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_LIST = 3000;
const MAX_PREVIEW_BYTES = 256 * 1024;

const TEXTISH = /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|toml|ini|cfg|conf|log|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cpp|hpp|java|kt|swift|sh|bash|ps1|bat|cmd|sql|php|pl|lua|r|tex|srt|vtt|env|gitignore|dockerfile)$/i;

const isTextish = (p) => TEXTISH.test(p) || /(^|[/\\])(dockerfile|makefile|readme|license)(\..*)?$/i.test(p);

function entryOf(dir, name) {
  const full = path.join(dir, name);
  try {
    const st = fs.statSync(full);
    return {
      name,
      path: full,
      dir: st.isDirectory(),
      size: st.isDirectory() ? null : st.size,
      mtime: st.mtime.toISOString()
    };
  } catch {
    return { name, path: full, dir: true, size: null, mtime: null, unreadable: true };
  }
}

/** Sorted directory listing (folders first). */
function listDir(abs) {
  const names = fs.readdirSync(abs);
  const dirs = [];
  const files = [];
  for (const n of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const e = entryOf(abs, n);
    (e.dir ? dirs : files).push(e);
  }
  const all = [...dirs, ...files];
  return { entries: all.slice(0, MAX_LIST), total: all.length, truncated: all.length > MAX_LIST };
}

/** Drive letters on Windows; [] elsewhere. */
function listDrives() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`;
    try {
      if (fs.existsSync(root)) out.push({ name: `${String.fromCharCode(i)}:`, path: root, dir: true });
    } catch {
      /* drive not reachable */
    }
  }
  return out;
}

function parentOf(abs) {
  const parent = path.dirname(abs);
  return parent === abs ? null : parent;
}

function expand(p) {
  const raw = String(p || '').trim();
  if (!raw || raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function sendError(res, e) {
  if (e instanceof PolicyError) return res.status(403).json({ error: e.message });
  const code = e?.code;
  if (code === 'ENOENT') return res.status(404).json({ error: `Not found: ${e.path || ''}` });
  if (code === 'EACCES' || code === 'EPERM') return res.status(403).json({ error: `Permission denied: ${e.path || ''}` });
  console.error('[files]', e);
  return res.status(500).json({ error: e.message || String(e) });
}

/* ------------------------------------------------------------------ *
 * Folder picker: browse the server disk, directories only.
 * ------------------------------------------------------------------ */
export const fsRouter = Router();

fsRouter.get('/browse', (req, res) => {
  try {
    const raw = String(req.query.path || '').trim();
    if (!raw) {
      const home = os.homedir();
      return res.json({
        path: '',
        parent: null,
        home,
        drives: listDrives(),
        entries: listDrives().length ? listDrives() : [entryOf(path.dirname(home), path.basename(home))]
      });
    }
    const abs = expand(raw);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return res.status(400).json({ error: `Not a folder: ${abs}` });
    const body = listDir(abs);
    res.json({
      path: abs,
      parent: parentOf(abs),
      home: os.homedir(),
      drives: listDrives(),
      ...body
    });
  } catch (e) {
    sendError(res, e);
  }
});

fsRouter.post('/mkdir', (req, res) => {
  try {
    const abs = expand(String(req.body?.path || ''));
    fs.mkdirSync(abs, { recursive: true });
    res.json({ path: abs });
  } catch (e) {
    sendError(res, e);
  }
});

/* ------------------------------------------------------------------ *
 * Per-chat file manager, enforced by that conversation's policy.
 * ------------------------------------------------------------------ */
export const conversationFsRouter = Router({ mergeParams: true });

function conversation(req, res) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(req.params.id));
  if (!conv) {
    res.status(404).json({ error: 'conversation not found' });
    return null;
  }
  return conv;
}

/** Resolve `p` under the conversation policy; absolute paths are allowed in full mode. */
function convPath(conv, p, opts) {
  return runWithPolicy(conv, () => resolvePath(p == null || p === '' ? '.' : String(p), opts));
}

conversationFsRouter.get('/', (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const abs = convPath(conv, req.query.path, { mustExist: true });
    if (!fs.statSync(abs).isDirectory()) return res.status(400).json({ error: 'Not a folder' });
    const root = runWithPolicy(conv, () => fileRoot());
    res.json({ path: abs, root, parent: parentOf(abs), ...listDir(abs) });
  } catch (e) {
    sendError(res, e);
  }
});

conversationFsRouter.get('/stat', (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const abs = convPath(conv, req.query.path, { mustExist: true });
    res.json(entryOf(path.dirname(abs), path.basename(abs)));
  } catch (e) {
    sendError(res, e);
  }
});

/**
 * Read a file. ?download=1 sends it as an attachment, otherwise small text
 * files come back inline as JSON so the UI can show them without a download.
 */
conversationFsRouter.get('/raw', async (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const abs = convPath(conv, req.query.path, { mustExist: true });
    const st = await fsp.stat(abs);
    if (st.isDirectory()) return res.status(400).json({ error: 'That is a folder' });
    const name = path.basename(abs);
    const wantsDownload = req.query.download === '1' || !isTextish(abs) || st.size > MAX_PREVIEW_BYTES;
    if (!wantsDownload) {
      const content = await fsp.readFile(abs, 'utf8');
      return res.json({ path: abs, name, size: st.size, text: content });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    );
    await fsp.readFile(abs).then((buf) => res.end(buf));
    return undefined;
  } catch (e) {
    sendError(res, e);
    return undefined;
  }
});

conversationFsRouter.post('/mkdir', (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const abs = convPath(conv, req.body?.path);
    fs.mkdirSync(abs, { recursive: true });
    res.json(entryOf(path.dirname(abs), path.basename(abs)));
  } catch (e) {
    sendError(res, e);
  }
});

conversationFsRouter.post('/write', async (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const abs = convPath(conv, req.body?.path);
    const content = String(req.body?.content ?? '');
    if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `Too large to save from the browser (${MAX_UPLOAD_BYTES} bytes max)` });
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    res.json(entryOf(path.dirname(abs), path.basename(abs)));
    return undefined;
  } catch (e) {
    sendError(res, e);
    return undefined;
  }
});

conversationFsRouter.post('/upload', async (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const b64 = String(req.body?.content_base64 || '');
    if (!b64) return res.status(400).json({ error: 'content_base64 is required' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: `File is too large (${MAX_UPLOAD_BYTES} bytes max)` });
    }
    const abs = convPath(conv, req.body?.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
    res.json(entryOf(path.dirname(abs), path.basename(abs)));
    return undefined;
  } catch (e) {
    sendError(res, e);
    return undefined;
  }
});

conversationFsRouter.post('/rename', (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const from = convPath(conv, req.body?.from, { mustExist: true });
    const to = convPath(conv, req.body?.to);
    fs.renameSync(from, to);
    res.json(entryOf(path.dirname(to), path.basename(to)));
  } catch (e) {
    sendError(res, e);
  }
});

conversationFsRouter.post('/delete', async (req, res) => {
  const conv = conversation(req, res);
  if (!conv) return undefined;
  try {
    const abs = convPath(conv, req.body?.path, { mustExist: true });
    const st = await fsp.stat(abs);
    if (st.isDirectory()) await fsp.rm(abs, { recursive: true, force: true });
    else await fsp.unlink(abs);
    res.json({ deleted: abs });
  } catch (e) {
    sendError(res, e);
  }
});