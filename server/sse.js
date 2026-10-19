/**
 * Server-Sent Events helpers.
 */
export function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': ok\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sseError(res, message) {
  const msg = String(message && message.message ? message.message : message);
  if (res.writableEnded) {
    console.warn(`[sse] error after stream closed: ${msg}`);
    return;
  }
  sseSend(res, 'error', { message: msg });
  res.end();
}
