/**
 * Probe an OpenAI-compatible server: streaming shape, reasoning_content,
 * tool calling support. Usage: node test/probe-server.mjs [baseUrl]
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:8080/v1').replace(/\/+$/, '');
const MODEL = process.argv[3] || '';

async function models() {
  const r = await fetch(`${BASE}/models`);
  const j = await r.json();
  return (j.data || []).map((m) => m.id);
}

async function stream(body, label) {
  console.log(`\n=== ${label} ===`);
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: true })
  });
  console.log('status', res.status, '| content-type', res.headers.get('content-type'));
  if (!res.ok) return console.log('body:', (await res.text()).slice(0, 400));

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let raw = '';
  const keys = new Set();
  let content = '';
  let reasoning = '';
  let toolCalls = 0;
  let events = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    raw += chunk;
    buf += chunk;
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? '';
    for (const p of parts) {
      events++;
      for (const line of p.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        let j;
        try { j = JSON.parse(d); } catch { console.log('  !! non-JSON data line:', d.slice(0, 120)); continue; }
        const delta = j?.choices?.[0]?.delta;
        if (delta) {
          for (const k of Object.keys(delta)) keys.add(k);
          if (typeof delta.content === 'string') content += delta.content;
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
          if (delta.reasoning) reasoning += delta.reasoning;
          if (Array.isArray(delta.tool_calls)) toolCalls += delta.tool_calls.length;
        }
      }
    }
  }

  console.log('sse events:', events, '| delta keys:', [...keys].join(',') || '(none)');
  console.log('content chars:', content.length, '| reasoning chars:', reasoning.length, '| tool_call deltas:', toolCalls);
  console.log('content:', JSON.stringify(content.slice(0, 200)));
  if (reasoning) console.log('reasoning:', JSON.stringify(reasoning.slice(0, 120)));
  if (!content && !reasoning && !toolCalls) console.log('RAW (first 600):', raw.slice(0, 600));
  return { content, reasoning, toolCalls };
}

const ids = await models();
const model = MODEL || ids[0];
console.log('base:', BASE, '| model:', model);

await stream({ model, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], max_tokens: 200 }, 'plain stream');

await stream(
  {
    model,
    messages: [{ role: 'user', content: 'What is 121 * 3? Use the calculator tool.' }],
    max_tokens: 400,
    tools: [
      {
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Evaluate an arithmetic expression',
          parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] }
        }
      }
    ]
  },
  'with tools'
);
