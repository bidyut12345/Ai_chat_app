/**
 * Example MCP server over stdio (only needs the MCP SDK).
 * Exposes two demo tools: `echo` and `get_weather`.
 *
 * Add it in the app under "MCP" settings with:
 *   transport: stdio
 *   name:      demo
 *   command:   node            (or the full path to node)
 *   args:      ["C:\\path\\to\\repo\\test\\mock-mcp-server.js"]
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the given text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text']
    }
  },
  {
    name: 'get_weather',
    description: 'Get current weather for a city.',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city']
    }
  }
];

const server = new Server({ name: 'demo-mcp-server', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] };
  }
  if (name === 'get_weather') {
    const city = args.city || 'unknown';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ city, condition: 'Partly cloudy', temp_c: 21, wind_kph: 12, source: 'demo MCP server' })
        }
      ]
    };
  }
  return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

await server.connect(new StdioServerTransport());
console.error('demo MCP server ready on stdio');
