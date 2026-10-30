/**
 * Per-turn file change tracking.
 *
 * Every chat turn runs inside `runWithFileChanges()`, which carries the id of
 * the user message that started the turn. The built-in file tools call
 * `trackFile()` around their writes: the first touch of a path during that turn
 * stores its previous content, and the last touch stores the final content.
 *
 * The result is one row per (user message, path) in `file_changes`, which the
 * browser uses to show a comparison under that user message and to offer a
 * per-file revert. Only text files below MAX_TRACK_BYTES are tracked — binary
 * payloads and huge files are skipped rather than stored.
 *
 * Tracking is deliberately best-effort: a failure here must never break a tool
 * call or the chat turn.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../db.js';
import { fileRoot } from './builtin/policy.js';

const store = new AsyncLocalStorage();

/** Files larger than this are not diffed (too heavy to keep per turn). */
const MAX_TRACK_BYTES = 512 * 1024;

/** Diff DP is skipped above this many cells; a coarse block diff is used. */
const MAX_DIFF_CELLS = 4_000_000;

export function runWithFileChanges(turn, fn) {
  if (!turn || !turn.messageId || !turn.conversationId) return fn();
  return store.run({ conversationId: Number(turn.conversationId), messageId: Number(turn.messageId) }, fn);
}

function activeTurn() {
  return store.getStore() || null;
}

/** Read a file when it is a small text file we can store and diff. */
async function readTrackable(abs) {
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > MAX_TRACK_BYTES) return { skip: true };
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return { skip: true };
    return { exists: true, text: buf.toString('utf8') };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, text: null };
    return { skip: true };
  }
}

function relPathOf(abs) {
  try {
    const root = fileRoot();
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  } catch {
    /* fall through to the absolute path */
  }
  return abs;
}

/** Record the state of `abs` before the turn's first change to it. */
export async function noteBefore(abs) {
  const turn = activeTurn();
  if (!turn || !abs) return;
  try {
    const seen = db
      .prepare('SELECT 1 FROM file_changes WHERE message_id = ? AND path = ?')
      .get(turn.messageId, abs);
    if (seen) return;
    const info = await readTrackable(abs);
    if (info.skip) return;
    db.prepare(
      `INSERT OR IGNORE INTO file_changes
         (conversation_id, message_id, path, rel_path, before_exists, before_text)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(turn.conversationId, turn.messageId, abs, relPathOf(abs), info.exists ? 1 : 0, info.text ?? null);
  } catch {
    /* tracking is best-effort */
  }
}

/** Record the state of `abs` after a change (the final state wins). */
export async function noteAfter(abs) {
  const turn = activeTurn();
  if (!turn || !abs) return;
  try {
    const row = db
      .prepare('SELECT id FROM file_changes WHERE message_id = ? AND path = ?')
      .get(turn.messageId, abs);
    if (!row) return;
    const info = await readTrackable(abs);
    if (info.skip) {
      // It turned into a binary/huge file: a text diff no longer makes sense.
      db.prepare('DELETE FROM file_changes WHERE id = ?').run(row.id);
      return;
    }
    db.prepare('UPDATE file_changes SET after_exists = ?, after_text = ? WHERE id = ?').run(
      info.exists ? 1 : 0,
      info.text ?? null,
      row.id
    );
  } catch {
    /* tracking is best-effort */
  }
}

/**
 * Run `fn` while recording the before/after state of `paths`.
 * `paths` is one absolute path or an array of them.
 */
export async function trackFile(paths, fn) {
  if (!activeTurn()) return fn();
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  for (const p of list) await noteBefore(p);
  try {
    return await fn();
  } finally {
    for (const p of list) await noteAfter(p);
  }
}

/* ------------------------------------------------------------------ *
 * Diff helpers used by the API (list summary + detail view).
 * ------------------------------------------------------------------ */

function splitLines(text) {
  const s = text == null ? '' : String(text);
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Cheap +/- counts for the list: trim the common prefix and suffix. */
export function changeStats(beforeText, afterText) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { added: endB - start, removed: endA - start };
}

/**
 * Line diff as `{ t: 'ctx'|'add'|'del', text }` ops.
 * Uses an LCS for normal files and a coarse common-prefix/suffix block when the
 * files are too large for the DP table.
 */
export function diffLines(beforeText, afterText) {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  const n = a.length;
  const m = b.length;
  const ops = [];

  if (n * m > MAX_DIFF_CELLS) {
    let start = 0;
    while (start < n && start < m && a[start] === b[start]) start++;
    let endA = n;
    let endB = m;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    for (let i = 0; i < start; i++) ops.push({ t: 'ctx', text: a[i] });
    for (let i = start; i < endA; i++) ops.push({ t: 'del', text: a[i] });
    for (let i = start; i < endB; i++) ops.push({ t: 'add', text: b[i] });
    for (let i = endA; i < n; i++) ops.push({ t: 'ctx', text: a[i] });
    return ops;
  }

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: 'del', text: a[i] });
      i++;
    } else {
      ops.push({ t: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'del', text: a[i++] });
  while (j < m) ops.push({ t: 'add', text: b[j++] });
  return ops;
}

/** True when a change row is only noise (same content before and after). */
export function isNoopChange(row) {
  const before = row.before_exists ? row.before_text ?? '' : null;
  const after = row.after_exists ? row.after_text ?? '' : null;
  return before === after;
}

/**
 * Revert one tracked file to its before state.
 * Returns a short human message. Throws on I/O problems.
 */
export async function revertChange(abs, row) {
  if (row.before_exists) {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, row.before_text ?? '', 'utf8');
    return `Restored ${abs}`;
  }
  // The file did not exist before this turn: remove it again.
  try {
    await fsp.rm(abs, { force: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return `Removed ${abs}`;
}

