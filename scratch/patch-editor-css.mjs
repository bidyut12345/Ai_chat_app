import fs from 'node:fs';

let css = fs.readFileSync('public/styles.css', 'utf8');

const targetCSS = [
  '.editor-textarea {',
  '  flex: 1;',
  '  min-width: 0;',
  '  min-height: 0;',
  '  background: transparent;',
  '  color: var(--text);',
  '  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;',
  '  font-size: 12px;',
  '  line-height: 18px;',
  '  tab-size: 2;',
  '  -moz-tab-size: 2;',
  '  border: none;',
  '  outline: none;',
  '  resize: none;',
  '  white-space: pre;',
  '  overflow: auto;',
  '  padding: 6px 12px;',
  '  box-sizing: border-box;',
  '  caret-color: var(--accent);',
  '}'
].join('\r\n');

const replacementCSS = [
  '.editor-stage {',
  '  flex: 1;',
  '  min-width: 0;',
  '  min-height: 0;',
  '  position: relative;',
  '  overflow: hidden;',
  '  background: transparent;',
  '}',
  '',
  '.editor-highlight-layer {',
  '  position: absolute;',
  '  inset: 0;',
  '  margin: 0;',
  '  padding: 6px 12px;',
  '  box-sizing: border-box;',
  '  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;',
  '  font-size: 12px;',
  '  line-height: 18px;',
  '  tab-size: 2;',
  '  -moz-tab-size: 2;',
  '  white-space: pre;',
  '  overflow: hidden;',
  '  pointer-events: none;',
  '  user-select: none;',
  '  -webkit-user-select: none;',
  '  color: var(--text);',
  '  background: transparent;',
  '  border: none;',
  '}',
  '',
  '.editor-textarea {',
  '  position: absolute;',
  '  inset: 0;',
  '  width: 100%;',
  '  height: 100%;',
  '  margin: 0;',
  '  padding: 6px 12px;',
  '  box-sizing: border-box;',
  '  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;',
  '  font-size: 12px;',
  '  line-height: 18px;',
  '  tab-size: 2;',
  '  -moz-tab-size: 2;',
  '  white-space: pre;',
  '  overflow: auto;',
  '  border: none;',
  '  outline: none;',
  '  resize: none;',
  '  background: transparent;',
  '  color: transparent;',
  '  -webkit-text-fill-color: transparent;',
  '  caret-color: var(--accent);',
  '}'
].join('\r\n');

if (!css.includes(targetCSS)) {
  console.error('targetCSS not found in public/styles.css');
  process.exit(1);
}

css = css.replace(targetCSS, replacementCSS);
fs.writeFileSync('public/styles.css', css, 'utf8');
console.log('Successfully updated editor styles in public/styles.css');

