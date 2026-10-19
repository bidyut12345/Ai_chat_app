/**
 * Pending tool-call approvals.
 *
 * When the approval mode is 'ask', a tool call that is not read-only is parked
 * here until the user answers in the browser. The chat turn awaits the promise
 * returned by requestApproval(), so the model sees a normal tool result either
 * way (the run, or the user's refusal).
 *
 * Approvals can be remembered per conversation or globally, which is how the
 * "Allow for this chat" and "Always allow" buttons work.
 */
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';
import { describeCall } from './builtin/policy.js';

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const KEEPALIVE_MS = 15 * 1000;
const GRANTS_KEY = 'builtin_always_allowed';

const pending = new Map(); // id -> { resolve, timer, keepalive, meta }
const conversationGrants = new Set(); // `${conversationId}::${tool}`

/** "Always allow" survives restarts; "allow for this chat" does not. */
function globalGrants() {
  try {
    const arr = JSON.parse(getSetting(GRANTS_KEY) || '[]');
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function addGlobalGrant(name) {
  const grants = globalGrants();
  grants.add(name);
  setSetting(GRANTS_KEY, JSON.stringify([...grants]));
}
const subscribers = new Set(); // SSE responses watching every approval

/**
 * Approvals are also broadcast on a standalone stream, so a prompt is still
 * shown (and still answerable) if the user switches conversation or reloads
 * the page while a turn is waiting.
 */
export function subscribe(res) {
  subscribers.add(res);
  for (const entry of pending.values()) res.write(`event: approval_request\ndata: ${JSON.stringify(entry.meta)}\n\n`);
  return () => subscribers.delete(res);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...subscribers]) {
    if (res.writableEnded) {
      subscribers.delete(res);
      continue;
    }
    res.write(payload);
  }
}

export function isPreApproved(conversationId, qualifiedName) {
  return globalGrants().has(qualifiedName) || conversationGrants.has(`${conversationId}::${qualifiedName}`);
}

export function listGrants() {
  return { global: [...globalGrants()], conversation: [...conversationGrants] };
}

export function clearGrants() {
  setSetting(GRANTS_KEY, '[]');
  conversationGrants.clear();
}

export function pendingList() {
  return [...pending.values()].map((p) => ({ ...p.meta, requestedAt: p.requestedAt }));
}

/**
 * Ask the user to approve a tool call.
 * `send(event, data)` writes onto the caller's SSE stream.
 * Resolves { allowed, reason, scope }.
 */
export function requestApproval({ send, conversationId, qualifiedName, args, signal }) {
  const id = crypto.randomBytes(8).toString('hex');
  const summary = describeCall(qualifiedName, args);
  const emit = (event, data) => {
    send(event, data);
    broadcast(event, data);
  };

  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(entry.timer);
      clearInterval(entry.keepalive);
      pending.delete(id);
      if (result.scope === 'always') addGlobalGrant(qualifiedName);
      if (result.scope === 'conversation') conversationGrants.add(`${conversationId}::${qualifiedName}`);
      emit('approval_resolved', { id, allowed: result.allowed, reason: result.reason, scope: result.scope || 'once' });
      resolve(result);
    };

    const entry = {
      id,
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

/** Answer a pending approval. Returns false when the id is unknown. */
export function resolveApproval(id, { allowed, reason, scope }) {
  const entry = pending.get(id);
  if (!entry) return false;
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
