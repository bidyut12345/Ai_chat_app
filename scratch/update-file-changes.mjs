import fs from 'node:fs';

let s = fs.readFileSync('public/app.js', 'utf8');

const target = [
  '  // Files this turn changed, shown under the user message that asked for them.',
  "  if (m.role === 'user') {",
  '    const changes = (state.fileChanges || []).filter((c) => c.message_id === m.id);',
  '    if (changes.length) body.append(fileChangeList(changes));',
  '  }',
  "  if (m.role === 'assistant') {",
  "    const stats = el('div', { class: 'msg-stats' }, statsText(m));",
  '    body.append(stats);',
  '    // Expandable per-round token breakdown (processed / generated per part).',
  '    if (m.prompt_tokens || m.completion_tokens || parseTokenDetail(m.token_detail).length) {',
  '      body.append(',
  "        el('details', { class: 'token-detail-wrap' },",
  "          el('summary', {}, 'token breakdown'),",
  '          tokenBreakdown(m))',
  '      );',
  '    }',
  '  }'
].join('\r\n');

const replacement = [
  "  if (m.role === 'assistant') {",
  "    const stats = el('div', { class: 'msg-stats' }, statsText(m));",
  '    body.append(stats);',
  '    // Expandable per-round token breakdown (processed / generated per part).',
  '    if (m.prompt_tokens || m.completion_tokens || parseTokenDetail(m.token_detail).length) {',
  '      body.append(',
  "        el('details', { class: 'token-detail-wrap' },",
  "          el('summary', {}, 'token breakdown'),",
  '          tokenBreakdown(m))',
  '      );',
  '    }',
  '    // Files this turn changed, shown at the end of the generated assistant message.',
  '    const userMsg = priorUserMessage(m);',
  '    const changes = (state.fileChanges || []).filter((c) => (userMsg ? c.message_id === userMsg.id : false));',
  '    if (changes.length) body.append(fileChangeList(changes));',
  '  }'
].join('\r\n');

if (!s.includes(target)) {
  console.error('Target not found in public/app.js');
  process.exit(1);
}

s = s.replace(target, replacement);

const anchor = "/** True when an assistant reply exists after this user message. */\r\nfunction hasReplyAfter(m) {";
const helper = [
  '/**',
  ' * Find the user message that started this assistant turn.',
  ' */',
  'function priorUserMessage(m) {',
  "  if (!m || m.role !== 'assistant') return null;",
  '  return [...state.messages]',
  '    .reverse()',
  "    .find((x) => x.role === 'user' && x.id < m.id) || null;",
  '}',
  '',
  ''
].join('\r\n');

if (!s.includes('function priorUserMessage(')) {
  if (!s.includes(anchor)) {
    console.error('Anchor not found in public/app.js');
    process.exit(1);
  }
  s = s.replace(anchor, helper + anchor);
}

fs.writeFileSync('public/app.js', s, 'utf8');
console.log('Successfully updated public/app.js');

