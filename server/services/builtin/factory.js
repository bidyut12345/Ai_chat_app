/**
 * Shared plumbing for the in-process built-in MCP servers.
 *
 * Each built-in server is a real MCP `Server` connected to its client through
 * an `InMemoryTransport` pair, so its tools flow through exactly the same
 * discovery, namespacing and invocation path as an external stdio/HTTP server.
 *
 * A tool is `{ name, description, inputSchema, readOnly, handler }`. Handlers
 * return a string (or throw); throwing produces an MCP tool error the model
 * can read and recover from.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PolicyError } from './policy.js';

const MAX_TEXT = 100000;

function clamp(s) {
  const str = String(s ?? '');
  return str.length > MAX_TEXT ? `${str.slice(0, MAX_TEXT)}\n...[truncated]` : str;
}

/** Build the MCP server side for a tool list and link it to a client transport. */
export function createBuiltinServer(name, version, tools) {
  const server = new Server({ name, version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      annotations: {
        readOnlyHint: !!t.readOnly,
        destructiveHint: !!t.destructive,
        openWorldHint: false
      }
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool "${req.params.name}"`);
    try {
      const out = await tool.handler(req.params.arguments || {});
      return { content: [{ type: 'text', text: clamp(out) }], isError: false };
    } catch (e) {
      const prefix = e instanceof PolicyError ? 'Access denied' : 'Error';
      return { content: [{ type: 'text', text: `${prefix}: ${e.message}` }], isError: true };
    }
  });

  const pair = InMemoryTransport.createLinkedPair();
  // The SDK types the pair as [client, server]; connect both ends.
  const connectPromise = server.connect(pair[1]);
  return { transport: pair[0], ready: connectPromise };
}
