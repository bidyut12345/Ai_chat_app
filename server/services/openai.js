/**
 * Minimal OpenAI-compatible client built on global fetch (Node 18+).
 * Works with any server exposing /chat/completions: OpenAI, LM Studio,
 * Ollama (openai endpoint), llama.cpp server, vLLM, LocalAI, KoboldCpp, etc.
 */
import { getSetting } from '../db.js';

export function runtimeConfig(overrides = {}) {
  const baseUrl = (overrides.baseUrl || getSetting('api_base_url') || 'http://localhost:1234/v1')
    .trim()
    .replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: (overrides.apiKey ?? getSetting('api_key') ?? '').trim(),
    model: (overrides.model || getSetting('model') || '').trim(),
    temperature: numOrUndef(overrides.temperature ?? getSetting('temperature')),
    maxTokens: intOrUndef(overrides.maxTokens ?? getSetting('max_tokens')),
    maxToolRounds: parseToolRounds(getSetting('max_tool_rounds')),
    reasoningEffort: normalizeEffort(overrides.reasoningEffort ?? getSetting('reasoning_effort')),
    contextWindow: intOrUndef(overrides.contextWindow ?? getSetting('context_window')),
    // Auto-compress thresholds (tokens). compressAt=0 disables.
    contextCompressAt: intOrUndef(overrides.contextCompressAt ?? getSetting('context_compress_at')) || 0,
    contextKeep: intOrUndef(overrides.contextKeep ?? getSetting('context_keep')) || 0
  };
}

const REASONING_EFFORTS = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** 'auto' (or blank) means "don't send reasoning_effort" — let the server decide. */
export function normalizeEffort(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return REASONING_EFFORTS.includes(s) ? s : 'auto';
}
export { REASONING_EFFORTS };

/** Blank, 0 or "unlimited" means the tool-calling loop is uncapped. */
function parseToolRounds(v) {
  const s = String(v ?? '').trim();
  if (s === '' || /^unlimited$/i.test(s)) return Infinity;
  const n = parseInt(s, 10);
  return Number.isNaN(n) || n <= 0 ? Infinity : n;
}

function numOrUndef(v) {
  const n = Number(v);
  return v === '' || v == null || Number.isNaN(n) ? undefined : n;
}
function intOrUndef(v) {
  const n = parseInt(v, 10);
  return v === '' || v == null || Number.isNaN(n) ? undefined : n;
}

function headers(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/** Strip trailing route fragments users often paste (e.g. ".../v1/chat/completions"). */
function chatUrl(baseUrl) {
  let b = baseUrl.replace(/\/chat\/completions$/i, '');
  return `${b}/chat/completions`;
}

export async function listModels(cfg) {
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: headers(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to list models (${res.status}): ${text || res.statusText}`);
  }
  const json = await res.json();
  const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

/**
 * Call /chat/completions.
 *  - stream: false -> returns parsed JSON body
 *  - stream: true  -> returns the raw Response; caller consumes the body.
 *    onDelta(text) is invoked for each content delta; tool_calls are
 *    accumulated and returned via the promise from consumeChatStream().
 */
export async function chatCompletion(cfg, body, { stream = false, signal } = {}) {
  const payload = { ...body, model: body.model || cfg.model, stream: !!stream };
  // Streaming responses only include token counters in a final usage chunk if
  // the client asks for it. Without this, prompt/completion tokens stay 0.
  if (stream && payload.stream_options == null) {
    payload.stream_options = { include_usage: true };
  }
  let res = await fetch(chatUrl(cfg.baseUrl), {
    method: 'POST',
    headers: { ...headers(cfg.apiKey), Accept: stream ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(payload),
    signal: signal || AbortSignal.timeout(600000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || text;
    } catch {
      /* keep raw */
    }
    // Some OpenAI-compatible servers reject the stream_options field. Retry once
    // without it so streaming still works (token counts then fall back to 0).
    if (payload.stream_options && res.status === 400 && /stream_options/i.test(msg)) {
      delete payload.stream_options;
      res = await fetch(chatUrl(cfg.baseUrl), {
        method: 'POST',
        headers: { ...headers(cfg.apiKey), Accept: stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(payload),
        signal: signal || AbortSignal.timeout(600000)
      });
      if (res.ok) {
        if (stream) return res;
        return res.json();
      }
      const t2 = await res.text().catch(() => '');
      try { msg = JSON.parse(t2)?.error?.message || t2; } catch { msg = t2; }
      throw new Error(`Upstream error ${res.status}: ${msg || res.statusText}`);
    }
    throw new Error(`Upstream error ${res.status}: ${msg || res.statusText}`);
  }
  if (stream) return res;
  return res.json();
}

/**
 * Consume an SSE chat-completion stream.
 * Calls onDelta(chunkText) as text arrives and resolves with the fully
 * assembled assistant message ({ content, tool_calls }).
 */
export async function consumeChatStream(res, onDelta, onReasoning) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let timings = null;
  let streamError = null;
  let sawDone = false;
  let sawAnyChunk = false;
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sawAnyChunk = true;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { sawDone = true; continue; }
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        // Some servers report a generation failure inside a 200 SSE stream
        // (e.g. "status=200 outcome=stream_error"). Capture it so the caller
        // shows the real reason instead of "empty response".
        if (json?.error) {
          streamError = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
        }
        // llama.cpp / vLLM style servers report counters on the last chunk.
        if (json?.usage && typeof json.usage === 'object') usage = json.usage;
        if (json?.timings && typeof json.timings === 'object') timings = json.timings;
        const choice = json?.choices?.[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === 'string' && /error|refusal/i.test(choice.finish_reason) && !streamError) {
          streamError = choice.finish_reason;
        }
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content.length) {
          content += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        // Reasoning models stream their chain of thought separately.
        const think = typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
        if (think) {
          reasoning += think;
          if (onReasoning) onReasoning(think);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || `call_${idx}_${Date.now()}`,
                type: 'function',
                function: { name: '', arguments: '' }
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }
  return {
    content,
    reasoning,
    usage,
    timings,
    streamError,
    sawDone,
    sawAnyChunk,
    tool_calls: toolCalls.filter((t) => t && t.function.name).length ? toolCalls : undefined
  };
}

/**
 * A tool result message telling the model the tool is unavailable.
 * Used when a server advertises its own tools that we cannot execute.
 */
export function unavailableToolResult(name) {
  return `Tool "${name}" is not available in this environment. Do not call tools; answer the question directly.`;
}

/** Convert MCP tool descriptors to OpenAI function-calling format. */
export function mcpToolsToOpenAi(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      // Namespaced (`server__tool`) so several servers can expose the same tool name.
      name: t.qualifiedName || t.name,
      description: t.description || '',
      parameters: t.inputSchema && Object.keys(t.inputSchema).length
        ? t.inputSchema
        : { type: 'object', properties: {} }
    }
  }));
}
