/**
 * Pending tool-call approvals.
 *
 * When the approval mode is 'ask', a tool call that is not read-only is parked
 * here until the user answers in the browser. The chat turn awaits the promise
 * returned by requestApproval(), so the model sees a normal tool result either
 * way (the run, or the user's refusal).
 *
 * Approvals can be remembered per conversation or globally, which is how the
 * "Allow for this chat" and "Always allow" buttons work. Everything here is
 * scoped by user id: one account's prompt (or remembered grant) must never be
 * visible to, or answerable by, another account.
 */
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';
import { describeCall } from './builtin/policy.js';

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const KEEPALIVE_MS = 15 * 1000;
const GRANTS_KEY = 'builtin_always_allowed';

const pending = new Map(); // id -> { userId, resolve, timer, keepalive, meta }
const conversationGrants = new Set(); // `${userId}::${conversationId}::${tool}`
const subscribers = new Map(); // SSE response -> userId

const userPrefix = (userId) => `${userId}::`;

/** "Always allow" survives restarts; "allow for this chat" does not. */
function globalGrants() {
  try {
    const arr = JSON.parse(getSetting(GRANTS_KEY) || '[]');
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function addGlobalGrant(userId, name) {
  const grants = globalGrants();
  grants.add(`${userPrefix(userId)}${name}`);
  setSetting(GRANTS_KEY, JSON.stringify([...grants]));
}

/**
 * Approvals are also broadcast on a standalone stream, so a prompt is still
 * shown (and still answerable) if the user switches conversation or reloads
 * the page while a turn is waiting. Each browser only receives its own user's
 * prompts.
 */
export function subscribe(res, userId) {
  subscribers.set(res, userId);
  for (const entry of pending.values()) {
    if (entry.userId !== userId) continue;
    res.write(`event: approval_request\ndata: ${JSON.stringify(entry.meta)}\n\n`);
  }
  return () => subscribers.delete(res);
}

function broadcast(event, data, userId) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, uid] of [...subscribers]) {
    if (uid !== userId) continue;
    if (res.writableEnded) {
      subscribers.delete(res);
      continue;
    }
    res.write(payload);
  }
}

export function isPreApproved(userId, conversationId, qualifiedName) {
  if (userId == null) return false;
  return globalGrants().has(`${userPrefix(userId)}${qualifiedName}`) ||
    conversationGrants.has(`${userPrefix(userId)}${conversationId}::${qualifiedName}`);
}

/** Grants for one user, with the user prefix stripped for display. */
export function listGrants(userId) {
  const prefix = userPrefix(userId);
  const strip = (g) => g.slice(prefix.length);
  return {
    global: [...globalGrants()].filter((g) => g.startsWith(prefix)).map(strip),
    conversation: [...conversationGrants].filter((g) => g.startsWith(prefix)).map(strip)
  };
}

/** Forget one user's remembered approvals; other users keep theirs. */
export function clearGrants(userId) {
  const prefix = userPrefix(userId);
  const remaining = [...globalGrants()].filter((g) => !g.startsWith(prefix));
  setSetting(GRANTS_KEY, JSON.stringify(remaining));
  for (const g of [...conversationGrants]) {
    if (g.startsWith(prefix)) conversationGrants.delete(g);
  }
}

export function pendingList(userId) {
  return [...pending.values()]
    .filter((p) => p.userId === userId)
    .map((p) => ({ ...p.meta, requestedAt: p.requestedAt }));
}

/**
 * Ask the user to approve a tool call.
 * `send(event, data)` writes onto the caller's SSE stream.
 * Resolves { allowed, reason, scope }.
 */
export function requestApproval({ send, userId, conversationId, qualifiedName, args, signal }) {
  const id = crypto.randomBytes(8).toString('hex');
  const summary = describeCall(qualifiedName, args);
  const emit = (event, data) => {
    send(event, data);
    broadcast(event, data, userId);
  };

  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(entry.timer);
      clearInterval(entry.keepalive);
      pending.delete(id);
      if (result.scope === 'always') addGlobalGrant(userId, qualifiedName);
      if (result.scope === 'conversation') {
        conversationGrants.add(`${userPrefix(userId)}${conversationId}::${qualifiedName}`);
      }
      emit('approval_resolved', { id, allowed: result.allowed, reason: result.reason, scope: result.scope || 'once' });
      resolve(result);
    };

    const entry = {
      id,
      userId,
      requestedAt: Date.now(),
      meta: { id, conversationId, name: qualifiedName, arguments: args, ...summary },
      resolve: finish,
      timer: setTimeout(() => finish({ allowed: false, reason: 'Timed out waiting for approval (10 minutes).' }), APPROVAL_TIMEOUT_MS),
      keepalive: setInterval(() => emit('keepalive', { id }), KEEPALIVE_MS)
    };
    pending.set(id, entry);

    if (signal) {
      if (signal.aborted) {
        finish({ allowed: false, reason: 'The chat turn was cancelled.' });
        return;
      }
      signal.addEventListener('abort', () => {
        if (pending.has(id)) finish({ allowed: false, reason: 'The chat turn was cancelled.' });
      }, { once: true });
    }

    emit('approval_request', entry.meta);
  });
}

/**
 * Answer a pending approval. Returns false when the id is unknown or belongs
 * to another user (so one account cannot approve another's tool call).
 */
export function resolveApproval(id, { allowed, reason, scope }, userId) {
  const entry = pending.get(id);
  if (!entry) return false;
  if (userId != null && entry.userId !== userId) return false;
  entry.resolve({
    allowed: !!allowed,
    reason: reason || (allowed ? 'Approved by the user.' : 'Denied by the user.'),
    scope: allowed ? scope : undefined
  });
  return true;
}

/** Deny everything still waiting (used when the server shuts down). */
export function denyAll(reason = 'The server stopped.') {
  for (const entry of [...pending.values()]) entry.resolve({ allowed: false, reason });
}

/** Text handed back to the model when the user says no. */
export function denialResult(name, reason) {
  return (
    `The user declined to allow "${name}" (${reason || 'denied'}). ` +
    'Do not retry it. Explain what you wanted to do and ask the user how they would like to proceed, ' +
    'or answer without using the tool.'
  );
}
