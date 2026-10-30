/**
 * MCP (Model Context Protocol) server manager.
 *
 * Each enabled row in the `mcp_servers` table becomes a client connection:
 *   transport = 'stdio'           -> spawns `command args...` locally
 *   transport = 'http'            -> Streamable HTTP MCP endpoint at `url`
 *   transport = 'sse'             -> legacy SSE MCP endpoint at `url`
 *
 * Tools are namespaced per server as `${serverName}__${toolName}` so multiple
 * servers can expose tools with the same name.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { db } from '../db.js';
import { createBuiltinTransport, stopAllBuiltin } from './builtin/index.js';
import { normalizePolicy, serverEnabled } from './builtin/policy.js';

const runtime = new Map(); // name -> { client, tools, status, error }

function parseJson(v, fallback) {
  try {
    const p = JSON.parse(v);
    return p ?? fallback;
  } catch {
    return fallback;
  }
}

/** Returns `{ transport, ready }`; `ready` resolves once a built-in server is up. */
function buildTransport(row) {
  if (row.transport === 'builtin') {
    const built = createBuiltinTransport(row.builtin_key);
    return { transport: built.transport, ready: built.ready };
  }
  if (row.transport === 'stdio') {
    if (!row.command) throw new Error('stdio transport requires a command');
    const args = parseJson(row.args, []);
    const env = parseJson(row.env, {});
    return {
      transport: new StdioClientTransport({
        command: row.command,
        args: Array.isArray(args) ? args.map(String) : [],
        env: { ...process.env, ...env },
        stderr: 'pipe'
      }),
      ready: null
    };
  }
  const headers = parseJson(row.headers, {});
  if (row.transport === 'sse') {
    return { transport: new SSEClientTransport(new URL(row.url), { requestInit: { headers } }), ready: null };
  }
  return { transport: new StreamableHTTPClientTransport(new URL(row.url), { requestInit: { headers } }), ready: null };
}

async function connectRow(row) {
  const client = new Client({ name: 'local-ai-chat-app', version: '1.0.0' }, { capabilities: {} });
  const { transport, ready } = buildTransport(row);
  client.onclose = () => {
    const entry = runtime.get(row.name);
    if (entry) {
      entry.status = 'disconnected';
      entry.tools = [];
    }
    runtime.delete(row.name);
  };
  if (ready) await ready;
  await client.connect(transport);
  let tools = [];
  try {
    const res = await client.listTools();
    tools = res.tools || [];
  } catch (e) {
    console.warn(`[mcp] listTools failed for ${row.name}:`, e.message);
  }
  runtime.set(row.name, {
    name: row.name,
    client,
    transport,
    tools,
    builtin: row.transport === 'builtin',
    builtinKey: row.builtin_key || null,
    approval: row.approval || 'auto',
    status: 'connected',
    error: null
  });
  return tools;
}

export async function connectServer(row) {
  const existing = runtime.get(row.name);
  if (existing) await disconnectServer(row.name).catch(() => {});
  try {
    const tools = await connectRow(row);
    return { name: row.name, status: 'connected', toolCount: tools.length };
  } catch (e) {
    runtime.set(row.name, {
      name: row.name,
      client: null,
      tools: [],
      status: 'error',
      error: e.message
    });
    throw e;
  }
}

export async function disconnectServer(name) {
  const entry = runtime.get(name);
  if (!entry) return;
  runtime.delete(name);
  try {
    if (entry.client) await entry.client.close();
  } catch {
    /* ignore */
  }
}

/** Connect every enabled server. Failures are recorded, not thrown. */
export async function connectAll() {
  const rows = db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name').all();
  const results = [];
  for (const row of rows) {
    try {
      const tools = await connectRow(row);
      results.push({ name: row.name, status: 'connected', toolCount: tools.length });
    } catch (e) {
      runtime.set(row.name, { name: row.name, client: null, tools: [], status: 'error', error: e.message });
      results.push({ name: row.name, status: 'error', error: e.message });
      console.warn(`[mcp] failed to connect "${row.name}": ${e.message}`);
    }
  }
  return results;
}

/**
 * Configured servers with live status. `env` and `headers` often hold API
 * tokens, so they are only included for admins (the MCP editor is admin-only).
 * Everyone else still gets the list, because the per-chat tool menu needs it.
 */
export function statusList({ includeSecrets = false } = {}) {
  const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY name').all();
  return rows.map((r) => {
    const entry = runtime.get(r.name);
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      builtin_key: r.builtin_key || null,
      builtin: r.transport === 'builtin',
      approval: r.approval || 'auto',
      enabled: !!r.enabled,
      command: r.command || '',
      args: parseJson(r.args, []) || [],
      url: r.url || '',
      env: includeSecrets ? parseJson(r.env, {}) || {} : {},
      headers: includeSecrets ? parseJson(r.headers, {}) || {} : {},
      status: !r.enabled ? 'disabled' : entry ? entry.status : 'disconnected',
      error: entry?.error || null,
      tools: entry?.tools || []
    };
  });
}

/**
 * All tools from all connected servers, namespaced and in MCP shape.
 * Pass the conversation to hide the built-in tool sets it has switched off.
 */
export function allTools(conversation) {
  const policy = conversation ? normalizePolicy(conversation) : null;
  const out = [];
  for (const entry of runtime.values()) {
    if (entry.status !== 'connected') continue;
    if (policy && policy.disabledServers.has(entry.name)) continue;
    if (policy && entry.builtinKey === 'files' && !policy.filesEnabled) continue;
    if (policy && entry.builtinKey === 'shell' && !policy.shellEnabled) continue;
    for (const t of entry.tools) {
      out.push({
        ...t,
        server: entry.name,
        builtin: !!entry.builtin,
        approval: entry.approval || 'auto',
        qualifiedName: `${entry.name}__${t.name}`
      });
    }
  }
  return out;
}

/**
 * Execute a tool call. `qualifiedName` is `${server}__${tool}`.
 * Returns a plain-text-friendly result string for the model.
 *
 * Built-in servers are exempt from the client-side timeout: their own tools
 * enforce timeouts (a build or a dev server can legitimately outlive a minute).
 */
export async function callTool(qualifiedName, args, timeoutMs = 60000, signal = null) {
  const sep = qualifiedName.indexOf('__');
  if (sep === -1) throw new Error(`Invalid tool name "${qualifiedName}"`);
  const server = qualifiedName.slice(0, sep);
  const tool = qualifiedName.slice(sep + 2);
  const entry = runtime.get(server);
  if (!entry || entry.status !== 'connected' || !entry.client) {
    throw new Error(`MCP server "${server}" is not connected`);
  }
  // A chat can switch a server off: never run a tool it should not see, even
  // if the model echoes a name from an earlier turn.
  if (!serverEnabled(server)) {
    throw new Error(`MCP server "${server}" is disabled for this chat`);
  }
  if (signal?.aborted) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
  // SDK signature: callTool(params, resultSchema = CallToolResultSchema, options)
  const opts = signal ? { signal } : undefined;
  const call = entry.client.callTool({ name: tool, arguments: args ?? {} }, undefined, opts);
  // When cancelled, resolve quickly with an AbortError instead of waiting for
  // the (possibly long-running) tool or its timeout to settle.
  const abortP = signal
    ? new Promise((_, rej) => signal.addEventListener('abort', () => {
        const e = new Error('cancelled'); e.name = 'AbortError'; rej(e);
      }, { once: true }))
    : null;
  // Race losers must not surface as unhandled rejections once the call settles.
  abortP?.catch(() => {});
  const racers = [call];
  if (abortP) racers.push(abortP);
  let timer = null;
  if (!entry.builtin) {
    racers.push(new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`Tool call "${qualifiedName}" timed out`)), timeoutMs);
      timer.unref?.();
    }));
  }
  try {
    const res = await Promise.race(racers);
    return normalizeToolResult(res);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeToolResult(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  const content = res.content;
  let text = '';
  if (Array.isArray(content)) {
    text = content
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[image ${c.mimeType || ''} base64 omitted]`;
        if (c.type === 'resource') return `[resource ${c.resource?.uri || ''}]`;
        return JSON.stringify(c);
      })
      .join('\n');
  } else if (content != null) {
    text = typeof content === 'string' ? content : JSON.stringify(content);
  }
  if (res.structuredContent && !text) text = JSON.stringify(res.structuredContent);
  // The built-in servers already label their failures; do not stack prefixes.
  if (res.isError && !/^(Tool error|Error|Access denied):/i.test(text)) text = `Tool error: ${text || 'unknown error'}`;
  return text;
}

/** Look up one connected tool descriptor (includes MCP annotations). */
export function findTool(qualifiedName) {
  return allTools().find((t) => t.qualifiedName === qualifiedName) || null;
}

export function stopAll() {
  stopAllBuiltin();
  return Promise.all([...runtime.keys()].map((n) => disconnectServer(n)));
}
