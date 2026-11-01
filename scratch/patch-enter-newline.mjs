import fs from 'node:fs';

let js = fs.readFileSync('public/highlight.js', 'utf8');

// Target the Tab and Enter handling block
const targetTab = [
  '        updateEditorGutter();',
  '        checkDirty();',
  '        return;',
  '      }',
  '',
  "      if (e.key === 'Enter') {",
  '        e.preventDefault();',
  '        const start = textarea.selectionStart;',
  '        const val = textarea.value;',
  "        const lineStart = val.lastIndexOf('\\n', start - 1) + 1;",
  '        const currentLine = val.slice(lineStart, start);',
  '        const match = currentLine.match(/^(\\s*)/);',
  "        let indent = match ? match[1] : '';",
  '        if (/[{\\[:(]\\s*$/.test(currentLine)) {',
  "          indent += '  ';",
  '        }',
  "        const insert = '\\n' + indent;",
  '        textarea.value = val.slice(0, start) + insert + val.slice(start);',
  '        textarea.selectionStart = textarea.selectionEnd = start + insert.length;',
  '        updateEditorGutter();',
  '        checkDirty();',
  '        return;',
  '      }'
].join('\r\n');

const replacementTab = [
  '        updateEditorHighlight();',
  '        updateEditorGutter();',
  '        checkDirty();',
  '        return;',
  '      }',
  '',
  "      if (e.key === 'Enter') {",
  '        e.preventDefault();',
  '        const start = textarea.selectionStart;',
  '        const end = textarea.selectionEnd;',
  '        const val = textarea.value;',
  "        const lineStart = val.lastIndexOf('\\n', start - 1) + 1;",
  '        const currentLine = val.slice(lineStart, start);',
  '        const match = currentLine.match(/^(\\s*)/);',
  "        let indent = match ? match[1] : '';",
  '        if (/[{\\[:(]\\s*$/.test(currentLine)) {',
  "          indent += '  ';",
  '        }',
  "        const insert = '\\n' + indent;",
  '',
  '        // Use document.execCommand if supported so native undo/redo works,',
  '        // falling back to direct value slice assignment.',
  "        let inserted = false;",
  '        try {',
  "          inserted = document.execCommand('insertText', false, insert);",
  '        } catch { /* fall back */ }',
  '        if (!inserted) {',
  '          textarea.value = val.slice(0, start) + insert + val.slice(end);',
  '          textarea.selectionStart = textarea.selectionEnd = start + insert.length;',
  '        }',
  '        updateEditorHighlight();',
  '        updateEditorGutter();',
  '        checkDirty();',
  '        return;',
  '      }'
].join('\r\n');

if (!js.includes(targetTab)) {
  console.error('targetTab not found in public/highlight.js');
  process.exit(1);
}

js = js.replace(targetTab, replacementTab);

fs.writeFileSync('public/highlight.js', js, 'utf8');
console.log('Successfully updated Enter and Tab handlers in public/highlight.js');

