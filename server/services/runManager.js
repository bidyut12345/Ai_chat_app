/**
 * Background chat runs.
 *
 * A chat turn used to be streamed straight to the browser's fetch response, so
 * anything that closed that connection — switching to another conversation,
 * opening a link in a new tab, navigating away, or a flaky network — aborted the
 * upstream generation. That is what made "opening another chat stops the answer"
 * and "opening a URL in another browser stops generation" happen.
 *
 * Instead a turn now runs independently of any single connection. Its events are
 * appended to a per-conversation buffer (with sequence numbers) and fanned out
 * to whichever browser tabs are currently watching. A tab can disconnect and
 * reconnect at will — resuming from the last sequence id it saw — without the
 * generation noticing. Only an explicit Stop aborts a run.
 */
import { runChatTurn } from './chatService.js';

// conversationId -> run
const runs = new Map();

// Cap the per-run event buffer so a runaway generation cannot exhaust memory.
// Reconnecting clients fall back to a full reload when they ask for events
// older than what we still hold (they get a 'resync' hint).
const MAX_EVENTS = 20000;

// How long a finished run keeps its event buffer for late subscribers
// (clients that POST then connect, or reconnect just after completion).
const RETAIN_AFTER_FINISH_MS = 60000;

function broadcast(run, entry) {
  const wire = `id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
  for (const res of [...run.subscribers]) {
    if (res.writableEnded) {
      run.subscribers.delete(res);
      continue;
    }
    try {
      res.write(wire);
    } catch {
      run.subscribers.delete(res);
    }
  }
}

function makeEmit(run) {
  return function emit(event, data) {
    if (run.finished) return;
    const entry = { id: ++run.seq, event, data };
    run.events.push(entry);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    broadcast(run, entry);
  };
}

export function getRun(conversationId) {
  return runs.get(Number(conversationId)) || null;
}

/** Conversation ids with a generation currently in flight. */
export function activeRuns() {
  return [...runs.values()]
    .filter((r) => !r.finished)
    .map((r) => ({ conversation_id: r.conversationId, started_at: r.startedAt }));
}

export function isRunning(conversationId) {
  const r = runs.get(Number(conversationId));
  return !!r && !r.finished;
}

/**
 * Start (or join) a generation for a conversation. Returns the run object.
 * If one is already in flight for this conversation it is returned untouched so
 * a second tab does not kick off a duplicate turn.
 */
export function startRun({ conversation, cfg, useTools, extraSystem, aiTitle }) {
  const existing = runs.get(conversation.id);
  if (existing && !existing.finished) return existing;

  const abort = new AbortController();
  const run = {
    conversationId: conversation.id,
    events: [],
    seq: 0,
    subscribers: new Set(),
    abort,
    finished: false,
    startedAt: Date.now(),
    // callId -> AbortController for tool calls currently executing, so the user
    // can cancel an individual tool call without stopping the whole turn.
    pendingTools: new Map()
  };
  run.emit = makeEmit(run);
  runs.set(conversation.id, run);

  // Per-tool-call cancellation control handed to the chat turn.
  const toolControl = {
    begin(callId) {
      const ac = new AbortController();
      run.pendingTools.set(callId, ac);
      return ac.signal;
    },
    end(callId) {
      run.pendingTools.delete(callId);
    }
  };

  runChatTurn({ emit: run.emit, signal: abort.signal, toolControl, conversation, cfg, useTools, extraSystem, aiTitle })
    .catch((e) => {
      // runChatTurn emits its own 'done'; this only fires for setup errors that
      // happen before the loop, so the UI still learns the run ended badly.
      if (!run.finished) run.emit('error', { message: e && e.message ? e.message : String(e) });
    })
    .finally(() => {
      run.finished = true;
      // Abort any tool call still executing so it does not linger after the
      // turn ends (e.g. the run errored or finished while a tool was running).
      for (const ac of run.pendingTools.values()) {
        try { ac.abort(); } catch { /* ignore */ }
      }
      run.pendingTools.clear();
      for (const res of [...run.subscribers]) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      run.subscribers.clear();
      // Keep the finished run (with its buffered events) around briefly so a
      // client that POSTs then connects a moment later — or reconnects right
      // after finishing — can still retrieve the full event log.
      run.reapTimer = setTimeout(() => {
        if (runs.get(conversation.id) === run) runs.delete(conversation.id);
      }, RETAIN_AFTER_FINISH_MS);
      run.reapTimer.unref?.();
    });

  return run;
}

/** Stop a running generation (the user pressed Stop). Returns false if none. */
export function stopRun(conversationId) {
  const run = runs.get(Number(conversationId));
  if (!run || run.finished) return false;
  run.abort.abort();
  return true;
}

/**
 * Cancel a single in-flight tool call (the user clicked Cancel on its chip).
 * The chat turn catches the abort, records a "cancelled" tool result, and the
 * model continues. Returns false if no such call is currently running.
 */
export function cancelToolCall(conversationId, callId) {
  const run = runs.get(Number(conversationId));
  if (!run || run.finished || !callId) return false;
  const ac = run.pendingTools.get(callId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/**
 * Attach a browser to a run's event stream. Events after `lastEventId` are
 * replayed from the buffer, then the response is added as a live subscriber.
 * Disconnecting only unsubscribes — the generation keeps running.
 */
export function subscribe(conversationId, lastEventId, res) {
  const run = runs.get(Number(conversationId));
  if (!run) return false;

  const oldest = run.events.length ? run.events[0].id : run.seq + 1;
  const from = Number(lastEventId) || 0;
  // If the client's cursor is older than what we still hold, tell it to reload
  // the finished/partial state from the database instead of replaying a gap.
  if (from > 0 && from < oldest - 1) {
    try {
      res.write(`event: resync\ndata: ${JSON.stringify({ reason: 'buffer_trimmed' })}\n\n`);
    } catch {
      /* ignore */
    }
  } else {
    for (const e of run.events) {
      if (e.id <= from) continue;
      try {
        res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      } catch {
        return false;
      }
    }
  }

  if (run.finished) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return true;
  }

  run.subscribers.add(res);
  res.on('close', () => run.subscribers.delete(res));
  return true;
}
