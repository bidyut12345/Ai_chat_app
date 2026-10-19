/**
 * Mock OpenAI-compatible server for end-to-end testing.
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream + non-stream, with tool-calling)
 *
 * Behaviour: if the request offers tools and the last user message contains
 * "weather", it emits a tool call first; the following round answers in text.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8899);

// Last /v1/chat/completions body, exposed on GET /v1/__last-chat-request so tests
// can assert stable per-conversation cache fields (user / prompt_cache_key).
let lastChatRequest = null;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Strict history validation, like OpenAI-compatible servers enforce: every
 * assistant tool call must have an id and parseable `arguments`, and every
 * `role:"tool"` message must reference a tool call that is still in the history.
 */
function validateMessages(messages) {
  const problems = [];
  const ids = new Set();
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls != null) {
      if (!Array.isArray(m.tool_calls)) {
        problems.push(`messages[${i}].tool_calls must be an array`);
        return;
      }
      for (const tc of m.tool_calls) {
        if (!tc?.id) problems.push(`messages[${i}] tool call missing id`);
        else ids.add(tc.id);
        const raw = tc?.function?.arguments;
        if (raw) {
          try {
            JSON.parse(raw);
          } catch {
            problems.push(`messages[${i}] tool call arguments are not valid JSON: ${String(raw).slice(0, 60)}`);
          }
        }
      }
    }
    if (m.role === 'tool' && !ids.has(m.tool_call_id)) {
      problems.push(`messages[${i}] orphaned tool result (no matching tool call id ${m.tool_call_id})`);
    }
  });
  return problems;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-gpt' }, { id: 'mock-llama-3.1-8b' }] }));
  }

  if (req.method === 'GET' && url.pathname === '/v1/__last-chat-request') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(lastChatRequest ?? { error: 'no chat request recorded yet' }));
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    lastChatRequest = body;
    // Behave like a strict server: reject a history the app failed to sanitize.
    const problems = validateMessages(body.messages || []);
    if (problems.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: problems.join('; ') } }));
    }
    const hasTool = (m) => m.role === 'tool';
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    const wantsTool = Array.isArray(body.tools) && body.tools.length && /weather/i.test(lastUser?.content || '');
    // Simulates a server that advertises its OWN tools: it asks for a tool that was
    // never offered in the request. The client must not discard the reply over this.
    const wantsBogus = /unavailable tool/i.test(lastUser?.content || '');
    // Simulates a model that emits truncated/malformed tool-call arguments. The
    // client must survive the turn and replay a sanitized history afterwards.
    const wantsBroken = /invalid json/i.test(lastUser?.content || '');
    // Explicit scripted call: "call files__read_file with {"path":"x"}" lets a test
    // drive any tool, including the built-in ones.
    const scripted = /\bcall\s+([A-Za-z0-9_]+(?:__[A-Za-z0-9_]+)?)\s*(?:with\s+)?(\{[\s\S]*\})?\s*$/i.exec(lastUser?.content || '');
    const alreadyCalled = (body.messages || []).some(hasTool);
    // Prefer a weather-ish tool so the demo MCP server returns useful output.
    const pickTool = (body.tools || []).find((t) => /weather/i.test(t.function?.name || '')) || (body.tools || [])[0];
    const callName = wantsBogus ? 'server_injected_calculator' : scripted ? scripted[1] : pickTool?.function?.name;
    const callArgs = wantsBogus
      ? '{"expr":"121*3"}'
      : scripted
        ? scripted[2] || '{}'
        : '{"city":"Berlin"}';

    if (wantsBroken && Array.isArray(body.tools) && body.tools.length && !alreadyCalled) {
      const brokenName = pickTool?.function?.name;
      if (brokenName) {
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          // Truncated JSON arguments, streamed in fragments like a real cut-off generation.
          sse(res, {
            choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_broken', function: { name: brokenName, arguments: '{"path": "notes.txt", "content' } }] } }]
          });
          sse(res, {
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ': broken' } }] } }]
          });
          sse(res, {
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 40, completion_tokens: 9 }
          });
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call_broken', type: 'function', function: { name: brokenName, arguments: '{"path": broken' } }]
            }
          }]
        }));
      }
    }

    if (((wantsTool && pickTool) || wantsBogus || (scripted && Array.isArray(body.tools))) && !alreadyCalled) {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const toolName = callName;
        const argParts = [callArgs.slice(0, 8), callArgs.slice(8)];
        // Stream the tool call in two argument fragments, like real servers do.
        sse(res, {
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: toolName, arguments: argParts[0] } }] } }]
        });
        sse(res, {
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argParts[1] } }] } }]
        });
        sse(res, {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 40, completion_tokens: 9 },
          timings: { prompt_ms: 20, prompt_per_second: 2000, predicted_ms: 90, predicted_per_second: 100 }
        });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: callName, arguments: callArgs } }]
              }
            }
          ]
        })
      );
    }

    const reply = `You said: "${(lastUser?.content || '').slice(0, 60)}". This is a mock reply from the test server.`;    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Reasoning arrives before the answer, like llama.cpp / OpenRouter do it.
      for (const word of 'Thinking about it. '.split(/(?<=\s)/)) {
        sse(res, { choices: [{ index: 0, delta: { reasoning_content: word } }] });
      }
      for (const word of reply.split(/(?<=\s)/)) {
        sse(res, { choices: [{ index: 0, delta: { content: word } }] });
      }
      sse(res, {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
        timings: { prompt_ms: 60, prompt_per_second: 2000, predicted_ms: 300, predicted_per_second: 100 }
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `no route ${url.pathname}` } }));
});

server.listen(PORT, () => console.log(`mock openai-compatible server on http://127.0.0.1:${PORT}/v1`));
