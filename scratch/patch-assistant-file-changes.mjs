import fs from 'node:fs';

let code = fs.readFileSync('public/app.js', 'utf8');

// 1. Add isLastAssistantInTurn helper right after priorUserMessage
const helperTarget = [
  'function priorUserMessage(m) {',
  "  if (!m || m.role !== 'assistant') return null;",
  '  return [...state.messages]',
  '    .reverse()',
  "    .find((x) => x.role === 'user' && x.id < m.id) || null;",
  '}'
].join('\r\n');

const helperReplacement = [
  'function priorUserMessage(m) {',
  "  if (!m || m.role !== 'assistant') return null;",
  '  return [...state.messages]',
  '    .reverse()',
  "    .find((x) => x.role === 'user' && x.id < m.id) || null;",
  '}',
  '',
  '/**',
  ' * True when this assistant message is the final assistant response of its turn',
  ' * (i.e. not followed by another assistant message in the same turn before a new user message).',
  ' */',
  'function isLastAssistantInTurn(m) {',
  "  if (!m || m.role !== 'assistant') return false;",
  '  const idx = state.messages.findIndex((x) => x.id === m.id);',
  '  if (idx === -1) return true;',
  '  for (let i = idx + 1; i < state.messages.length; i++) {',
  '    const next = state.messages[i];',
  "    if (next.role === 'user') break;",
  "    if (next.role === 'assistant') return false;",
  '  }',
  '  return true;',
  '}'
].join('\r\n');

if (!code.includes(helperTarget)) {
  console.error('Helper target not found in public/app.js');
  process.exit(1);
}

code = code.replace(helperTarget, helperReplacement);

// 2. Update renderMessage check for file-changes
const renderTarget = [
  '    // Files this turn changed, shown at the end of the generated assistant message.',
  '    const userMsg = priorUserMessage(m);',
  '    const changes = (state.fileChanges || []).filter((c) => (userMsg ? c.message_id === userMsg.id : false));',
  '    if (changes.length) body.append(fileChangeList(changes));'
].join('\r\n');

const renderReplacement = [
  '    // Files this turn changed: show only once at the end of the turn (on the final assistant message),',
  '    // not repeated after intermediate tool-call assistant steps.',
  '    if (isLastAssistantInTurn(m)) {',
  '      const userMsg = priorUserMessage(m);',
  '      const changes = (state.fileChanges || []).filter((c) => (userMsg ? c.message_id === userMsg.id : false));',
  '      if (changes.length) body.append(fileChangeList(changes));',
  '    }'
].join('\r\n');

if (!code.includes(renderTarget)) {
  console.error('Render target not found in public/app.js');
  process.exit(1);
}

code = code.replace(renderTarget, renderReplacement);

fs.writeFileSync('public/app.js', code, 'utf8');
console.log('Successfully updated public/app.js');

