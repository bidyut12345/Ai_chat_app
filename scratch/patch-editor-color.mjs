import fs from 'node:fs';

let js = fs.readFileSync('public/highlight.js', 'utf8');

// 1. Replace the editBox inner structure in createCodeViewer
const targetEditBox = [
  '    // Edit box (interactive code editor with gutter)',
  '    const editBox = document.createElement(\'div\');',
  '    editBox.className = \'code-editor-wrap hidden\';',
  '    container.appendChild(editBox);',
  '',
  '    const gutter = document.createElement(\'div\');',
  '    gutter.className = \'editor-gutter\';',
  '    editBox.appendChild(gutter);',
  '',
  '    const textarea = document.createElement(\'textarea\');',
  '    textarea.className = \'editor-textarea\';',
  '    textarea.spellcheck = false;',
  '    textarea.autocomplete = \'off\';',
  '    textarea.autocapitalize = \'off\';',
  '    textarea.wrap = \'off\';',
  '    editBox.appendChild(textarea);'
].join('\r\n');

const replacementEditBox = [
  '    // Edit box (interactive code editor with syntax-colored overlay and gutter)',
  '    const editBox = document.createElement(\'div\');',
  '    editBox.className = \'code-editor-wrap hidden\';',
  '    container.appendChild(editBox);',
  '',
  '    const gutter = document.createElement(\'div\');',
  '    gutter.className = \'editor-gutter\';',
  '    editBox.appendChild(gutter);',
  '',
  '    const editorStage = document.createElement(\'div\');',
  '    editorStage.className = \'editor-stage\';',
  '    editBox.appendChild(editorStage);',
  '',
  '    const highlightLayer = document.createElement(\'pre\');',
  '    highlightLayer.className = \'editor-highlight-layer\';',
  '    highlightLayer.setAttribute(\'aria-hidden\', \'true\');',
  '    editorStage.appendChild(highlightLayer);',
  '',
  '    const textarea = document.createElement(\'textarea\');',
  '    textarea.className = \'editor-textarea\';',
  '    textarea.spellcheck = false;',
  '    textarea.autocomplete = \'off\';',
  '    textarea.autocapitalize = \'off\';',
  '    textarea.wrap = \'off\';',
  '    editorStage.appendChild(textarea);'
].join('\r\n');

if (!js.includes(targetEditBox)) {
  console.error('targetEditBox not found');
  process.exit(1);
}
js = js.replace(targetEditBox, replacementEditBox);

// 2. Add updateEditorHighlight and wire it up
const targetUpdate = [
  '    function updateEditorGutter() {',
  '      const lines = textarea.value.split(\'\\n\');',
  '      const count = lines.length;',
  '      let s = \'\';',
  '      for (let i = 1; i <= count; i++) {',
  '        s += `<div class="editor-line-num">${i}</div>`;',
  '      }',
  '      gutter.innerHTML = s;',
  '      badgeLines.textContent = `${count} ${count === 1 ? \'line\' : \'lines\'}`;',
  '    }'
].join('\r\n');

const replacementUpdate = [
  '    function updateEditorHighlight() {',
  '      const text = textarea.value;',
  '      const lines = highlightToLines(text, lang);',
  '      // Ensure trailing newline renders properly in pre layer so cursor does not misalign',
  '      highlightLayer.innerHTML = lines.join(\'\\n\') + (text.endsWith(\'\\n\') ? \'\\n\' : \'\');',
  '    }',
  '',
  '    function updateEditorGutter() {',
  '      const lines = textarea.value.split(\'\\n\');',
  '      const count = lines.length;',
  '      let s = \'\';',
  '      for (let i = 1; i <= count; i++) {',
  '        s += `<div class="editor-line-num">${i}</div>`;',
  '      }',
  '      gutter.innerHTML = s;',
  '      badgeLines.textContent = `${count} ${count === 1 ? \'line\' : \'lines\'}`;',
  '    }'
].join('\r\n');

if (!js.includes(targetUpdate)) {
  console.error('targetUpdate not found');
  process.exit(1);
}
js = js.replace(targetUpdate, replacementUpdate);

// 3. Update input and scroll event listeners
const targetListeners = [
  '    textarea.addEventListener(\'input\', () => {',
  '      updateEditorGutter();',
  '      checkDirty();',
  '    });',
  '',
  '    textarea.addEventListener(\'scroll\', () => {',
  '      gutter.scrollTop = textarea.scrollTop;',
  '    });'
].join('\r\n');

const replacementListeners = [
  '    textarea.addEventListener(\'input\', () => {',
  '      updateEditorHighlight();',
  '      updateEditorGutter();',
  '      checkDirty();',
  '    });',
  '',
  '    textarea.addEventListener(\'scroll\', () => {',
  '      gutter.scrollTop = textarea.scrollTop;',
  '      highlightLayer.scrollTop = textarea.scrollTop;',
  '      highlightLayer.scrollLeft = textarea.scrollLeft;',
  '    });'
].join('\r\n');

if (!js.includes(targetListeners)) {
  console.error('targetListeners not found');
  process.exit(1);
}
js = js.replace(targetListeners, replacementListeners);

// 4. Update setEditMode to trigger updateEditorHighlight
const targetSetEdit = [
  '        updateEditorGutter();',
  '        checkDirty();',
  '        setTimeout(() => textarea.focus(), 30);'
].join('\r\n');

const replacementSetEdit = [
  '        updateEditorHighlight();',
  '        updateEditorGutter();',
  '        checkDirty();',
  '        setTimeout(() => textarea.focus(), 30);'
].join('\r\n');

if (!js.includes(targetSetEdit)) {
  console.error('targetSetEdit not found');
  process.exit(1);
}
js = js.replace(targetSetEdit, replacementSetEdit);

fs.writeFileSync('public/highlight.js', js, 'utf8');
console.log('Successfully updated public/highlight.js');

