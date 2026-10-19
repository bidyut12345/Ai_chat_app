/**
 * Drive one chat turn through the running app and print the SSE events.
 * Usage: node test/live-chat.mjs "message" [--tools]
 */
const APP = process.env.APP_URL || 'http://127.0.0.1:3000';
const msg = process.argv[2] || 'Reply with exactly: PONG';
const useTools = process.argv.includes('--tools');

async function api(method, p, body) {
  const r = await fetch(`${APP}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const t = await r.text();
  let d;
  try { d = t ? JSON.parse(t) : null; } catch { d = { raw: t } }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${d?.error || t}`);
  return d;
}

const conv = await api('POST', '/api/conversations', { title: 'live probe' });
console.log('conversation', conv.id);
const t0 = Date.now();

const res0 = await fetch(`${APP}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversation_id: conv.id, content: msg, use_tools: useTools })
});
console.log('POST /api/chat ->', res0.status, res0.headers.get('content-type'));
if (!res0.ok) {
  console.log('body:', (await res0.text()).slice(0, 800));
  await api('DELETE', `/api/conversations/${conv.id}`);
  process.exit(1);
}
const res = await fetch(`${APP}/api/chat/stream?conversation_id=${conv.id}&last_event_id=0`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let text = '';
const seen = [];
let done = null;

while (true) {
  const { done: fin, value } = await reader.read();
  if (fin) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split(/\r?\n\r?\n/);
  buf = parts.pop() ?? '';
  for (const p of parts) {
    let event = 'message';
    const data = [];
    for (const line of p.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    const d = JSON.parse(data.join('\n'));
    if (event === 'delta') text += d.text || '';
    else {
      seen.push(event);
      console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${event}`, JSON.stringify(d).slice(0, 300));
    }
    if (event === 'done') done = d;
  }
}

console.log('\n--- assistant text (%d chars) ---', text.length);
console.log(text || '(EMPTY)');
console.log('\nevents:', [...new Set(seen)].join(', ') || '(none)');
if (done?.error) console.log('error:', done.error);

const full = await api('GET', `/api/conversations/${conv.id}`);
console.log('persisted roles:', full.messages.map((m) => `${m.role}:${(m.content || '').length}c`).join(' '));
await api('DELETE', `/api/conversations/${conv.id}`);
console.log('\nRESULT:', text.trim() ? 'OK' : 'EMPTY REPLY');
