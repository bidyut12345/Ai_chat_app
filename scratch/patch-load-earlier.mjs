import fs from 'node:fs';

let code = fs.readFileSync('public/app.js', 'utf8');

// Target the previous declarations of showAllMessages and INITIAL_MSG_LIMIT
const targetDecl = [
  'let showAllMessages = false;',
  'const INITIAL_MSG_LIMIT = 50;'
].join('\r\n');

const replacementDecl = [
  '// How many recent user turns to display initially before showing the "Load earlier" banner.',
  'const INITIAL_USER_TURNS = 2;',
  '// How many additional user turns to load each time the user clicks "Load earlier".',
  'const USER_TURNS_STEP = 2;',
  'let visibleUserTurns = INITIAL_USER_TURNS;'
].join('\r\n');

if (!code.includes(targetDecl)) {
  console.error('targetDecl not found in public/app.js');
  process.exit(1);
}

code = code.replace(targetDecl, replacementDecl);

// Also replace openConversation's reset of showAllMessages
const targetOpen = '  showAllMessages = false;';
const replacementOpen = '  visibleUserTurns = INITIAL_USER_TURNS;';
if (!code.includes(targetOpen)) {
  console.error('targetOpen not found in public/app.js');
  process.exit(1);
}
code = code.replace(targetOpen, replacementOpen);

// Also replace newConversation's reset (if any) or ensure visibleUserTurns is reset there
const targetNew = "  state.fileChanges = [];\r\n  renderMessages();";
const replacementNew = "  state.fileChanges = [];\r\n  visibleUserTurns = INITIAL_USER_TURNS;\r\n  renderMessages();";
if (!code.includes(targetNew)) {
  console.error('targetNew not found in public/app.js');
  process.exit(1);
}
code = code.replace(targetNew, replacementNew);

// Replace renderMessages signature & scrollBottom call:
const targetSig = "function renderMessages() {";
const replacementSig = "function renderMessages(preserveScroll = false) {\r\n  const prevScrollHeight = $('#messages')?.scrollHeight || 0;\r\n  const prevScrollTop = $('#messages')?.scrollTop || 0;";
if (!code.includes(targetSig)) {
  console.error('targetSig not found in public/app.js');
  process.exit(1);
}
code = code.replace(targetSig, replacementSig);

// Replace renderMessages logic for loading earlier messages
const targetRender = [
  '  if (!showAllMessages && msgs.length > INITIAL_MSG_LIMIT) {',
  '    const hiddenCount = msgs.length - INITIAL_MSG_LIMIT;',
  "    const banner = el('div', { class: 'load-earlier-banner', style: 'text-align:center; padding:12px; margin-bottom:12px;' },",
  "      el('button', {",
  "        class: 'btn btn-sm',",
  '        onclick: () => { showAllMessages = true; renderMessages(); }',
  '      }, `📜 Load ${hiddenCount} earlier messages (${msgs.length} total)`)',
  '    );',
  '    box.append(banner);',
  '    for (let i = hiddenCount; i < msgs.length; i++) {',
  '      box.append(renderMessage(msgs[i]));',
  '    }',
  '  } else {',
  '    for (const m of msgs) box.append(renderMessage(m));',
  '  }'
].join('\r\n');

const replacementRender = [
  '  // User-turn based paging: display the most recent user messages + replies,',
  '  // with an expandable banner to load earlier turns in parts (or all at once).',
  '  const userIndices = [];',
  '  for (let i = 0; i < msgs.length; i++) {',
  "    if (msgs[i].role === 'user') userIndices.push(i);",
  '  }',
  '  const totalTurns = userIndices.length;',
  '  let startIndex = 0;',
  '  let hiddenTurns = 0;',
  '  if (totalTurns > visibleUserTurns && visibleUserTurns > 0) {',
  '    startIndex = userIndices[totalTurns - visibleUserTurns];',
  '    hiddenTurns = totalTurns - visibleUserTurns;',
  '  }',
  '',
  '  if (startIndex > 0) {',
  '    const hiddenMsgs = startIndex;',
  '    const nextStep = Math.min(USER_TURNS_STEP, hiddenTurns);',
  '    const stepLabel = nextStep === 1 ? "1 turn" : `${nextStep} turns`;',
  "    const banner = el('div', { class: 'load-earlier-banner' },",
  "      el('span', { class: 'load-earlier-info' }, `${hiddenTurns} earlier turn${hiddenTurns === 1 ? '' : 's'} (${hiddenMsgs} message${hiddenMsgs === 1 ? '' : 's'}) hidden`),",
  "      el('div', { class: 'load-earlier-actions' },",
  "        el('button', {",
  "          class: 'btn btn-sm load-earlier-btn',",
  '          onclick: () => {',
  '            visibleUserTurns += USER_TURNS_STEP;',
  '            renderMessages(true);',
  '          }',
  '        }, `📜 Load +${stepLabel}`),',
  "        el('button', {",
  "          class: 'btn btn-sm btn-ghost load-earlier-all',",
  '          onclick: () => {',
  '            visibleUserTurns = totalTurns;',
  '            renderMessages(true);',
  '          }',
  '        }, `Load all (${totalTurns})`)',
  '      )',
  '    );',
  '    box.append(banner);',
  '    for (let i = startIndex; i < msgs.length; i++) {',
  '      box.append(renderMessage(msgs[i]));',
  '    }',
  '  } else {',
  '    for (const m of msgs) box.append(renderMessage(m));',
  '  }'
].join('\r\n');

if (!code.includes(targetRender)) {
  console.error('targetRender not found in public/app.js');
  process.exit(1);
}

code = code.replace(targetRender, replacementRender);

const targetScroll = "  scrollBottom();\r\n  renderPillRail();";
const replacementScroll = [
  '  if (preserveScroll) {',
  '    const newScrollHeight = box.scrollHeight;',
  '    box.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);',
  '  } else {',
  '    scrollBottom();',
  '  }',
  '  renderPillRail();'
].join('\r\n');

if (!code.includes(targetScroll)) {
  console.error('targetScroll not found in public/app.js');
  process.exit(1);
}
code = code.replace(targetScroll, replacementScroll);

fs.writeFileSync('public/app.js', code, 'utf8');
console.log('Successfully patched public/app.js for turn-based partial loading');
