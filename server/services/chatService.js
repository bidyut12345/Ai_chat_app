/**
 * Chat orchestration: builds the message list from the database, runs the
 * OpenAI-compatible chat completion with an MCP tool-calling loop, and
 * persists everything (including tool traffic) to SQLite.
 */
import { db } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion, consumeChatStream, mcpToolsToOpenAi, unavailableToolResult } from './openai.js';
import { allTools, callTool } from './mcpManager.js';
import { isPreApproved, requestApproval, denialResult } from './approvals.js';
import { toolNeedsApproval, runWithConversation, resolvePath } from './builtin/policy.js';
import { maybeCompress } from './context.js';

const MAX_TOOL_RESULT_CHARS = 16000;

/**
 * Text handed back to the model when the user cancels a running tool call.
 * Explicitly tells the model not to retry so generation can continue.
 */
function cancelledToolResult(name) {
  return `The user cancelled the "${name}" tool call before it finished. ` +
    `Do not retry this tool call. Continue your response without it, ` +
    `and briefly acknowledge that the action was cancelled if relevant.`;
}

/** Tools that leave a file behind, and which argument names the result. */
const PRODUCING_TOOLS = {
  'files__write_file': 'path',
  'files__create_directory': 'path',
  'files__copy_path': 'to',
  'files__move_path': 'to'
};

function clampText(s) {
  if (typeof s !== 'string') return '';
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]` : s;
}

/** Describe a file a tool just wrote, so the browser can offer a download. */
function describeProducedFile(qualifiedName, args) {
  const key = PRODUCING_TOOLS[qualifiedName];
  if (!key || typeof args?.[key] !== 'string') return null;
  try {
    const abs = resolvePath(args[key], { mustExist: true });
    const st = fs.statSync(abs);
    return {
      path: abs,
      name: path.basename(abs),
      dir: st.isDirectory(),
      size: st.isDirectory() ? null : st.size,
      mtime: st.mtime.toISOString()
    };
  } catch {
    return null;
  }
}

/** Merge per-round usage / timing counters reported by the server. */
function mergeStats(total, usage, timings) {
  const round = { r: total.rounds.length + 1, prompt: 0, completion: 0, prompt_ms: 0, predicted_ms: 0 };
  if (usage) {
    round.prompt = Number(usage.prompt_tokens) || 0;
    round.completion = Number(usage.completion_tokens) || 0;
    total.promptTokens += round.prompt;
    total.completionTokens += round.completion;
    // Authoritative rates reported by the server (already account for
    // speculative decoding). Keep the last non-null value seen.
    const ups = Number(usage.prompt_tokens_per_second);
    const ucs = Number(usage.completion_tokens_per_second);
    if (Number.isFinite(ups) && ups > 0) { total.usagePpS = ups; round.pp_s = ups; }
    if (Number.isFinite(ucs) && ucs > 0) { total.usageTgS = ucs; round.tg_s = ucs; }
  }
  if (timings) {
    round.prompt_ms = Number(timings.prompt_ms) || 0;
    round.predicted_ms = Number(timings.predicted_ms) || 0;
    total.promptMs += round.prompt_ms;
    total.predictedMs += round.predicted_ms;
    const tps = Number(timings.prompt_per_second);
    const tcs = Number(timings.predicted_per_second);
    if (Number.isFinite(tps) && tps > 0) { total.timingPpS = tps; round.pp_s = round.pp_s ?? tps; }
    if (Number.isFinite(tcs) && tcs > 0) { total.timingTgS = tcs; round.tg_s = round.tg_s ?? tcs; }
  }
  total.rounds.push(round);
  return total;
}

/**
 * Tokens/second for prompt processing and generation.
 *
 * A server doing speculative decoding reports wall-clock rates that already
 * fold in the draft-model work; recomputing `tokens / predicted_ms` under-counts
 * it (predicted_ms sums every draft+target attempt). So trust the server's own
 * per-second figures when it provides them and only fall back to the ms math.
 */
function tokPerSecond(total) {
  const pp = total.usagePpS ?? total.timingPpS ??
    (total.promptMs > 0 && total.promptTokens > 0 ? total.promptTokens / (total.promptMs / 1000) : null);
  const tg = total.usageTgS ?? total.timingTgS ??
    (total.predictedMs > 0 && total.completionTokens > 0 ? total.completionTokens / (total.predictedMs / 1000) : null);
  return { pp, tg };
}

let insertMsg;
function msgInserter(db) {
  if (!insertMsg) insertMsg = db.prepare('INSERT INTO messages (conversation_id, role, content, image_url, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?, ?)');
  return insertMsg;
}

/**
 * Heal a broken tool exchange before replaying it upstream.
 *
 * A turn killed by an upstream error or a user stop can leave an assistant
 * message whose tool calls never got results. Strict OpenAI-compatible servers
 * reject the whole next request when that is the tail of the history ("sending
 * a new message in the same conversation gives an error"). Fill every missing
 * result with a synthetic interruption message — persisted, so the history
 * stays consistent — and drop tool_calls that have no results at all.
 */
function healOrphanToolCalls(conversationId, msgs) {
  // Every tool result id already present in the rebuilt history.
  const have = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  // Also count results persisted in the DB (defensive: buildMessages may have
  // dropped one whose call we didn't keep, but the id still exists).
  const interrupted = '[Interrupted: this tool call never ran (the generation stopped or failed). Do not retry it automatically; continue without it.]';
  // Rebuild so each assistant tool_calls message is immediately followed by a
  // result for every one of its calls. Missing results are synthesised and
  // persisted, which also fixes the "new message errors after a failed turn"
  // case where the orphaned assistant row sits mid-history (followed by a new
  // user message), not just at the tail.
  const out = [];
  let changed = false;
  for (const m of msgs) {
    out.push(m);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc?.id || have.has(tc.id)) continue;
        // Synthesise the missing result right after the call.
        const synth = { role: 'tool', tool_call_id: tc.id, content: interrupted };
        out.push(synth);
        have.add(tc.id);
        changed = true;
        msgInserter(db).run(conversationId, 'tool', interrupted, null, null, tc.id);
      }
    }
  }
  if (changed) {
    msgs.length = 0;
    for (const m of out) msgs.push(m);
  }
}

/** Store an assistant message, keeping its chain of thought and layout alongside it. */
function insertAssistant(conversationId, content, toolCalls, reasoning, segments, files) {
  const info = msgInserter(db).run(conversationId, 'assistant', content, null, toolCalls, null);
  if (reasoning || segments || files) {
    setExtras(info.lastInsertRowid, { reasoning, segments, files });
  }
  return info;
}

let updateMsgExtras;
/** Attach the per-reply extras (reasoning, ordered segments, files, stats) to a row. */
function setExtras(id, { reasoning, segments, files, durationMs, promptTokens, completionTokens, pp, tg, tokenDetail } = {}) {
  if (!updateMsgExtras) {
    updateMsgExtras = db.prepare(
      `UPDATE messages
          SET reasoning = COALESCE(?, reasoning),
              segments = COALESCE(?, segments),
              files = COALESCE(?, files),
              duration_ms = COALESCE(?, duration_ms),
              prompt_tokens = COALESCE(?, prompt_tokens),
              completion_tokens = COALESCE(?, completion_tokens),
              pp_tok_s = COALESCE(?, pp_tok_s),
              tg_tok_s = COALESCE(?, tg_tok_s),
              token_detail = COALESCE(?, token_detail)
        WHERE id = ?`
    );
  }
  updateMsgExtras.run(
    reasoning ?? null,
    segments ?? null,
    files ?? null,
    durationMs ?? null,
    promptTokens ?? null,
    completionTokens ?? null,
    pp ?? null,
    tg ?? null,
    tokenDetail ?? null,
    id
  );
}

let updateToolExtras;
/** Record how long a tool call took and whether the user cancelled it. */
function setToolExtras(id, durationMs, cancelled) {
  if (!updateToolExtras) {
    updateToolExtras = db.prepare('UPDATE messages SET tool_duration_ms = ?, tool_cancelled = ? WHERE id = ?');
  }
  updateToolExtras.run(durationMs ?? null, cancelled ? 1 : 0, id);
}

/**
 * Coerce one assistant tool call into a shape the upstream will accept.
 * Some models emit malformed `arguments` JSON; keep the call but replace the
 * broken arguments with `{}` so replay never sends invalid JSON upstream.
 * Returns null when the call is beyond repair (no id or no function name).
 */
function normalizeToolCall(tc) {
  const id = tc && typeof tc.id === 'string' ? tc.id : '';
  const name = tc?.function?.name;
  if (!id || typeof name !== 'string' || !name) return null;
  let args = tc.function.arguments;
  if (typeof args !== 'string') args = args == null ? '' : JSON.stringify(args);
  if (!args) args = '{}';
  try {
    JSON.parse(args);
  } catch {
    args = '{}';
  }
  return { id, type: 'function', function: { name, arguments: args } };
}

/** Parse a stored assistant tool_calls blob into a clean, replayable array (or null). */
function parseStoredToolCalls(raw) {
  let tcs;
  try {
    tcs = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(tcs)) return null;
  const clean = tcs.map(normalizeToolCall).filter(Boolean);
  return clean.length ? clean : null;
}

/** Rebuild the OpenAI message list for a conversation, including tool traffic. */
export function buildMessages(conversationId, { systemPrompt, extraSystem, summary, summarizedUpto } = {}) {
  const msgs = [];
  const sys = [systemPrompt, extraSystem].filter((s) => s && s.trim()).join('\n\n');
  if (sys) msgs.push({ role: 'system', content: sys });
  // Older turns rolled into a summary (auto-compress): replay a compact recap
  // instead of the verbatim history, so the prompt stays within budget.
  if (summary) msgs.push({ role: 'system', content: `[Summary of earlier conversation]\n${summary}` });
  const rows = db
    .prepare('SELECT role, content, image_url, tool_calls, tool_call_id FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id')
    .all(conversationId, summarizedUpto || 0);
  // ids referenced by an assistant message we actually kept, so we never emit an
  // orphaned `tool` message (a tool result with no matching call breaks strict servers).
  const liveIds = new Set();
  for (const r of rows) {
    if (r.role === 'system') continue;
    if (r.role === 'tool') {
      if (r.tool_call_id && liveIds.has(r.tool_call_id)) {
        msgs.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content || '' });
      }
      continue;
    }
    const m = { role: r.role, content: r.content || '' };
    if (r.image_url) m.image_url = r.image_url;
    if (r.role === 'assistant' && r.tool_calls) {
      const tcs = parseStoredToolCalls(r.tool_calls);
      if (tcs) {
        m.tool_calls = tcs;
        for (const tc of tcs) liveIds.add(tc.id);
      }
    }
    msgs.push(m);
  }
  healOrphanToolCalls(conversationId, msgs);
  return msgs;
}

/**
 * Run one chat turn with the conversation's own tool policy active, so the
 * built-in file and shell tools resolve paths, approvals and scopes per chat.
 */
export function runChatTurn({ emit, signal, toolControl, conversation, cfg, useTools, extraSystem }) {
  return runWithConversation(conversation, () => runChatTurnInner({ emit, signal, toolControl, conversation, cfg, useTools, extraSystem }));
}

async function runChatTurnInner({ emit, signal, toolControl, conversation, cfg, useTools, extraSystem }) {
  // The upstream request is aborted when the user presses Stop (the run's
  // signal). A browser merely disconnecting does NOT abort — see runManager.
  const abortSignal = signal || new AbortController().signal;

  // Fold older turns into a summary when the prompt would exceed the budget,
  // so long tool-heavy chats don't resend hundreds of thousands of tokens.
  try {
    await maybeCompress(conversation, cfg, emit, abortSignal);
  } catch {
    /* compression is best-effort; proceed with full history on failure */
  }

  const messages = buildMessages(conversation.id, {
    systemPrompt: conversation.prompt_content,
    extraSystem,
    summary: conversation.summary,
    summarizedUpto: conversation.summarized_upto
  });

  // Stable per-conversation cache identity so upstream KV/prefix caches are reused
  // across turns (OpenAI `user` + `prompt_cache_key`; ignored by servers that lack them).
  const cacheKey = `conv-${conversation.id}`;

  const tools = useTools ? allTools(conversation) : [];
  const toolSchemas = tools.length ? mcpToolsToOpenAi(tools) : undefined;
  const toolIndex = new Map(tools.map((t) => [t.qualifiedName, t]));
  // Infinity (the default) keeps the tool loop running until the model answers.
  const maxRounds = cfg.maxToolRounds ?? Infinity;


  let finalContent = '';
  let finalError = null;

  // Turn-wide counters: wall time, tokens and speeds reported by the server,
  // the chain of thought (kept, not discarded) and any file the tools wrote.
  const startedAt = Date.now();
  const stats = { promptTokens: 0, completionTokens: 0, promptMs: 0, predictedMs: 0, rounds: [] };
  let reasoningAll = '';
  let lastRoundReasoning = '';
  const producedFiles = [];

  // Ordered layout of each round, mirroring the order the browser receives the
  // events: {t:'r'} reasoning, {t:'t'} answer text, {t:'tc',id} tool call,
  // {t:'f',i} produced file (index into that row's files). Persisted on the
  // assistant row so a reload shows thinking / text / tools interleaved in the
  // exact streamed order instead of one clumped after the other.
  let roundSegs = [];
  const addSeg = (seg) => {
    const last = roundSegs[roundSegs.length - 1];
    if ((seg.t === 'r' || seg.t === 't') && last && last.t === seg.t) return;
    roundSegs.push(seg);
  };
  // Files produced in the current round (stored on the row this round creates,
  // so file chips reload next to the tool call that made them, not at the end).
  let roundFiles = [];
  // The partial text/thinking of the round being streamed, kept so an upstream
  // error or a stop mid-round still persists what the model produced.
  let roundText = '';
  let roundThink = '';
  let partialThink = '';

  try {
  for (let round = 0; round < maxRounds; round++) {
    roundSegs = [];
    roundFiles = [];
    roundText = '';
    roundThink = '';
    const body = { messages, stream: true, user: cacheKey, prompt_cache_key: cacheKey };
    if (toolSchemas) body.tools = toolSchemas;
    if (cfg.temperature != null) body.temperature = cfg.temperature;
    // 'auto' (the default) omits reasoning_effort so servers that don't know the
    // parameter aren't broken; any explicit level is forwarded upstream.
    if (cfg.reasoningEffort && cfg.reasoningEffort !== 'auto') body.reasoning_effort = cfg.reasoningEffort;
    if (cfg.maxTokens != null) body.max_tokens = cfg.maxTokens;

    const upstream = await chatCompletion(cfg, body, { stream: true, signal: abortSignal });
    if (round > 0) emit('notice', { message: 'Model is continuing after the tool results…' });

    let roundReasoning = '';
    const assistant = await consumeChatStream(
      upstream,
      (chunk) => {
        roundText += chunk;
        addSeg({ t: 't' });
        emit('delta', { text: chunk });
      },
      (chunk) => {
        roundReasoning += chunk;
        roundThink += chunk;
        reasoningAll += chunk;
        addSeg({ t: 'r' });
        emit('reasoning', { text: chunk });
      }
    );
    roundThink = '';
    roundText = '';
    mergeStats(stats, assistant.usage, assistant.timings);
    lastRoundReasoning = roundReasoning;
    // Surfaced upstream failure (200 SSE that carried an error event, or a
    // stream that aborted before [DONE]). Prefer showing the real reason over
    // "empty response" — the user sees "The model returned an empty response"
    // only when the server genuinely produced nothing without an error signal.
    if (assistant.streamError && !(assistant.content || '').trim() && !(assistant.reasoning || '').trim() && !assistant.tool_calls) {
      throw new Error(assistant.streamError);
    }
    const hasTools = Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0;

    if (!hasTools) {
      finalContent = assistant.content || '';
      if (assistant.streamError) finalError = `Model reported an error mid-reply: ${assistant.streamError}`;
      else if (!(assistant.content || '').trim() && !(assistant.reasoning || '').trim() && !assistant.sawDone && !assistant.sawAnyChunk) {
        finalError = 'The model closed the stream without any data.';
      }
      break;
    }

    // Remember which streamed calls carried malformed `arguments` so we answer them
    // with a tool error, then coerce every call into a replayable shape. Without this
    // the raw broken JSON is persisted and re-sent next round, breaking strict servers.
    const invalidArgIds = new Set();
    for (const tc of assistant.tool_calls) {
      const raw = tc.function?.arguments;
      if (typeof raw === 'string' && raw) {
        try {
          JSON.parse(raw);
        } catch {
          invalidArgIds.add(tc.id);
        }
      }
    }
    assistant.tool_calls = assistant.tool_calls.map(normalizeToolCall).filter(Boolean);
    if (!assistant.tool_calls.length) {
      finalContent = assistant.content || '';
      break;
    }

    // Some servers advertise their own tools (or the template mentions them), so the
    // model may ask for a tool we cannot run. Answer the call with an "unavailable"
    // tool result instead of discarding the reply, and let the model continue.
    const runnable = toolSchemas ? assistant.tool_calls.filter((tc) => toolIndex.has(tc.function.name)) : [];
    const unknown = assistant.tool_calls.filter((tc) => !runnable.includes(tc));

    if (!runnable.length) {
      for (const tc of assistant.tool_calls) addSeg({ t: 'tc', id: tc.id });
      insertAssistant(conversation.id, assistant.content || '', JSON.stringify(assistant.tool_calls), roundReasoning, JSON.stringify(roundSegs), roundFiles.length ? JSON.stringify(roundFiles) : null);
      messages.push({ role: 'assistant', content: assistant.content || '', tool_calls: assistant.tool_calls });
      for (const tc of assistant.tool_calls) {
        const resultText = unavailableToolResult(tc.function.name);
        msgInserter(db).run(conversation.id, 'tool', resultText, null, null, tc.id);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
        emit('tool_unavailable', { id: tc.id, name: tc.function.name });
      }
      if (round === maxRounds - 1) {
        finalContent = assistant.content || '';
        finalError = `The model kept requesting unavailable tools (${unknown.map((t) => t.function.name).join(', ')}).`;
      }
      continue;
    }

    // Persist the assistant tool-call message, then execute each call.
    const toolCallRow = insertAssistant(conversation.id, assistant.content || '', JSON.stringify(assistant.tool_calls), roundReasoning, JSON.stringify(roundSegs), null);
    messages.push({ role: 'assistant', content: assistant.content || '', tool_calls: assistant.tool_calls });

    for (const tc of assistant.tool_calls) {
      const name = tc.function.name;
      let args = {};
      let parseErr = null;
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (e) {
        parseErr = e;
      }
      if (!parseErr && invalidArgIds.has(tc.id)) {
        parseErr = new Error('arguments were not valid JSON');
        args = {};
      }

      const toolStartedAt = Date.now();
      emit('tool_call', { id: tc.id, name, arguments: args });
      addSeg({ t: 'tc', id: tc.id });
      let resultText;
      let denied = null;
      let cancelled = false;
      // Give this specific call its own abort signal so the user can cancel
      // just this tool (the model is then told it was cancelled and continues).
      const callSignal = toolControl?.begin ? toolControl.begin(tc.id) : null;
      try {
        if (parseErr) resultText = `Tool error: invalid JSON arguments (${parseErr.message})`;
        else if (!toolIndex.has(name)) resultText = unavailableToolResult(name);
        else {
          // Policy gate: mutating tools pause here until the user answers.
          const tool = toolIndex.get(name);
          if (toolNeedsApproval(tool) && !isPreApproved(conversation.id, name)) {
            const answer = await requestApproval({
              send: (event, data) => emit(event, data),
              conversationId: conversation.id,
              qualifiedName: name,
              args,
              signal: abortSignal
            });
            if (!answer.allowed) denied = answer.reason;
          }
          if (!denied) {
            if (callSignal?.aborted) {
              cancelled = true;
              resultText = cancelledToolResult(name);
            } else {
              try {
                resultText = await callTool(name, args, undefined, callSignal);
                if (callSignal?.aborted) { cancelled = true; resultText = cancelledToolResult(name); }
                // A successful write leaves a file the user may want to keep.
                const produced = describeProducedFile(name, args);
                if (produced) {
                  producedFiles.push(produced);
                  roundFiles.push(produced);
                  addSeg({ t: 'f', i: roundFiles.length - 1 });
                  emit('file_created', { id: tc.id, ...produced });
                }
              } catch (e) {
                if (e && (e.name === 'AbortError' || callSignal?.aborted)) { cancelled = true; resultText = cancelledToolResult(name); }
                else resultText = `Tool error: ${e.message}`;
              }
            }
          } else {
            resultText = denialResult(name, denied);
            emit('tool_denied', { id: tc.id, name, reason: denied });
          }
        }
      } finally {
        toolControl?.end?.(tc.id);
      }
      const toolMs = Date.now() - toolStartedAt;
      resultText = clampText(resultText);
      const toolRow = msgInserter(db).run(conversation.id, 'tool', resultText, null, null, tc.id);
      setToolExtras(toolRow.lastInsertRowid, toolMs, cancelled);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
      if (cancelled) emit('tool_cancelled', { id: tc.id, name, duration_ms: toolMs });
      emit('tool_result', { id: tc.id, name, result: resultText, duration_ms: toolMs, cancelled });
    }
    // Round complete: store the final layout (calls + files interleaved as they ran).
    setExtras(toolCallRow.lastInsertRowid, {
      segments: JSON.stringify(roundSegs),
      files: roundFiles.length ? JSON.stringify(roundFiles) : null
    });

    if (round === maxRounds - 1) {
      finalContent = assistant.content || '';
      finalError = `Stopped after ${maxRounds} tool rounds without a final answer.`;
    }
  }

  if (!finalContent && !finalError) finalError = 'The model returned an empty response.';
  } catch (err) {
    // The turn died mid-round: upstream stream error, user stop or a failed
    // tool round. Persist everything produced so far in arrival order so the
    // partial reply survives a reload, and mark it stopped.
    if (roundThink) addSeg({ t: 'r' });
    if (roundText) addSeg({ t: 't' });
    const aborted = err && (err.name === 'AbortError' || abortSignal.aborted);
    finalError = aborted ? 'Stopped.' : `Generation failed: ${err && err.message ? err.message : err}`;
    if (!aborted) console.error('[chat] generation failed:', err);
    partialThink = roundThink;
  }

  const durationMs = Date.now() - startedAt;
  const { pp, tg } = tokPerSecond(stats);
  const segsJson = roundSegs.length ? JSON.stringify(roundSegs) : null;
  const filesJson = producedFiles.length ? JSON.stringify(producedFiles) : null;
  const detailJson = stats.rounds.length ? JSON.stringify(stats.rounds) : null;
  // The largest prompt reported by the server is the real context the model saw
  // on its last round (each round re-sends the whole history, so the last round
  // is the fullest). This is what the context meter shows.
  const contextTokens = stats.rounds.reduce((m, r) => Math.max(m, r.prompt), 0);
  // Don't store a completely empty assistant row when nothing was produced.
  let saved = null;
  if (finalContent || segsJson || filesJson) {
    const info = msgInserter(db).run(conversation.id, 'assistant', finalContent, null, null, null);
    setExtras(info.lastInsertRowid, {
      reasoning: partialThink || lastRoundReasoning || null,
      segments: segsJson,
      files: filesJson,
      durationMs,
      promptTokens: stats.promptTokens || null,
      completionTokens: stats.completionTokens || null,
      pp: pp == null ? null : Math.round(pp * 10) / 10,
      tg: tg == null ? null : Math.round(tg * 10) / 10,
      tokenDetail: detailJson
    });
    saved = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  }
  emit('stats', {
    duration_ms: durationMs,
    prompt_tokens: stats.promptTokens || null,
    completion_tokens: stats.completionTokens || null,
    pp_tok_s: pp == null ? null : Math.round(pp * 10) / 10,
    tg_tok_s: tg == null ? null : Math.round(tg * 10) / 10,
    reasoning_chars: reasoningAll.length,
    context_tokens: contextTokens || null,
    context_window: cfg.contextWindow || null,
    rounds: stats.rounds,
    files: producedFiles
  });
  emit('done', { message: saved, error: finalError });
  return saved;
}

export function loadConversation(id) {
  const conv = db
    .prepare(
      `SELECT c.*, p.content AS prompt_content, p.name AS prompt_name
       FROM conversations c LEFT JOIN system_prompts p ON p.id = c.prompt_id
       WHERE c.id = ?`
    )
    .get(id);
  return conv || null;
}
