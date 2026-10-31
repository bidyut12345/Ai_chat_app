/**
 * RiSriGPT Code Viewer & Syntax Highlighter
 * Zero external dependencies.
 * Provides syntax coloring, line numbers, copy button, language detection,
 * and JSON auto-formatting/prettifying for light and dark themes.
 */
(function (global) {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const LANG_NAMES = {
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    json: 'JSON',
    html: 'HTML',
    xml: 'XML',
    css: 'CSS',
    python: 'Python',
    sql: 'SQL',
    shell: 'Shell',
    powershell: 'PowerShell',
    markdown: 'Markdown',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    java: 'Java',
    rust: 'Rust',
    go: 'Go',
    php: 'PHP',
    ruby: 'Ruby',
    yaml: 'YAML',
    toml: 'TOML',
    ini: 'INI',
    text: 'Plain text'
  };

  function detectLanguage(filename) {
    if (!filename) return 'text';
    const name = String(filename).trim().toLowerCase();
    const base = name.split(/[\\/]/).pop() || name;

    if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'shell';
    if (base.startsWith('.env')) return 'shell';
    if (base === 'makefile' || base === 'gnumakefile') return 'shell';
    if (base === '.gitignore' || base === '.npmignore') return 'shell';

    const ext = base.includes('.') ? base.split('.').pop() : base;
    const map = {
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      json: 'json',
      jsonc: 'json',
      jsonl: 'json',
      html: 'html',
      htm: 'html',
      xhtml: 'html',
      xml: 'xml',
      svg: 'xml',
      css: 'css',
      scss: 'css',
      sass: 'css',
      less: 'css',
      py: 'python',
      pyw: 'python',
      ipynb: 'json',
      sql: 'sql',
      sh: 'shell',
      bash: 'shell',
      zsh: 'shell',
      ps1: 'powershell',
      psm1: 'powershell',
      psd1: 'powershell',
      md: 'markdown',
      markdown: 'markdown',
      c: 'c',
      h: 'c',
      cpp: 'cpp',
      hpp: 'cpp',
      cc: 'cpp',
      cxx: 'cpp',
      cs: 'csharp',
      java: 'java',
      rs: 'rust',
      go: 'go',
      php: 'php',
      rb: 'ruby',
      yaml: 'yaml',
      yml: 'yaml',
      toml: 'toml',
      ini: 'ini',
      cfg: 'ini',
      conf: 'ini',
      txt: 'text',
      log: 'text',
      csv: 'text',
      tsv: 'text'
    };

    return map[ext] || 'text';
  }

  // Regex rules for language tokenization using sticky flags (/y)
  const RULES = {
    javascript: [
      { type: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
      { type: 'string', regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/y },
      { type: 'regex', regex: /\/(?![*+?])(?:\\.|[^\/\r\n\\])+\/[gimsuy]*/y },
      { type: 'number', regex: /\b(?:0x[a-fA-F0-9]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b/y },
      { type: 'keyword', regex: /\b(?:async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|interface|type|enum|implements|declare|namespace|public|private|protected|readonly|as)\b/y },
      { type: 'bool', regex: /\b(?:true|false|null|undefined|NaN|Infinity)\b/y },
      { type: 'fn', regex: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/y },
      { type: 'type', regex: /\b[A-Z][a-zA-Z0-9_$]*\b/y },
      { type: 'op', regex: /=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\?|:|[+\-*\/%=&|^~<>!]/y },
      { type: 'punct', regex: /[{}()\[\];,.]/y }
    ],
    python: [
      { type: 'comment', regex: /#[^\n]*/y },
      { type: 'string', regex: /(?:[brufBRUF]{1,2})?(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/y },
      { type: 'number', regex: /\b(?:0x[a-fA-F0-9]+|0o[0-7]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?)\b/y },
      { type: 'keyword', regex: /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/y },
      { type: 'bool', regex: /\b(?:True|False|None)\b/y },
      { type: 'decorator', regex: /@[a-zA-Z_][a-zA-Z0-9_.]*/y },
      { type: 'fn', regex: /\b([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*\()/y },
      { type: 'type', regex: /\b[A-Z][a-zA-Z0-9_]*\b/y },
      { type: 'op', regex: /==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&|\||\^|~|\/\/|\*\*|[+\-*\/%<>=]/y },
      { type: 'punct', regex: /[{}()\[\];,:.]/y }
    ],
    json: [
      { type: 'prop', regex: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"/y },
      { type: 'number', regex: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y },
      { type: 'bool', regex: /\b(?:true|false|null)\b/y },
      { type: 'punct', regex: /[{}()\[\],:]/y }
    ],
    html: [
      { type: 'comment', regex: /<!--[\s\S]*?-->/y },
      { type: 'doctype', regex: /<!DOCTYPE[^>]*>/iy },
      { type: 'tag', regex: /<\/?[a-zA-Z0-9:-]+/y },
      { type: 'tag', regex: /\/?>/y },
      { type: 'attr', regex: /\b[a-zA-Z0-9_:-]+(?=\s*=)/y },
      { type: 'string', regex: /"[^"]*"|'[^']*'/y },
      { type: 'entity', regex: /&[a-zA-Z0-9#]+;/y },
      { type: 'op', regex: /=/y }
    ],
    css: [
      { type: 'comment', regex: /\/\*[\s\S]*?\*\//y },
      { type: 'atrule', regex: /@[a-zA-Z-]+/y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { type: 'color', regex: /#[a-fA-F0-9]{3,8}\b/y },
      { type: 'number', regex: /-?\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|deg|ms|s|fr|pt)?\b/y },
      { type: 'prop', regex: /\b[a-zA-Z-][a-zA-Z0-9-]*(?=\s*:)/y },
      { type: 'fn', regex: /\.[a-zA-Z_][a-zA-Z0-9_-]*/y },
      { type: 'type', regex: /#[a-zA-Z_][a-zA-Z0-9_-]*/y },
      { type: 'punct', regex: /[{}()\[\];:,]/y },
      { type: 'op', regex: /[>+~*]/y }
    ],
    sql: [
      { type: 'comment', regex: /--[^\n]*|\/\*[\s\S]*?\*\//y },
      { type: 'string', regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/y },
      { type: 'number', regex: /\b\d+(?:\.\d+)?\b/y },
      { type: 'keyword', regex: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|AND|OR|NOT|IN|IS|NULL|LIKE|AS|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|CHECK|CONSTRAINT|VALUES|EXISTS|BETWEEN|WITH|PRAGMA|ASC|DESC)\b/iy },
      { type: 'punct', regex: /[(),;.]/y },
      { type: 'op', regex: /<>|!=|<=|>=|=|<|>|\+|-|\*|\//y }
    ],
    shell: [
      { type: 'comment', regex: /#[^\n]*/y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { type: 'var', regex: /\$[a-zA-Z0-9_]+|\$\{[^}]+\}|\$_|\$[0-9]/y },
      { type: 'number', regex: /\b\d+\b/y },
      { type: 'keyword', regex: /\b(?:if|then|else|elif|fi|case|esac|for|while|until|do|done|in|function|select|time|return|exit|echo|export|set|unset|local|sudo|source|alias)\b/y },
      { type: 'op', regex: /\|\||&&|>>|>|<|\||&|==|!=|=/y },
      { type: 'punct', regex: /[{}()\[\];,]/y }
    ],
    powershell: [
      { type: 'comment', regex: /#[^\n]*|<#[\s\S]*?#>/y },
      { type: 'string', regex: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
      { type: 'var', regex: /\$[a-zA-Z0-9_:]+/y },
      { type: 'number', regex: /\b\d+\b/y },
      { type: 'keyword', regex: /\b(?:param|function|filter|process|begin|end|return|if|elseif|else|switch|foreach|for|while|do|until|break|continue|try|catch|finally|throw|trap)\b/iy },
      { type: 'fn', regex: /\b(?:Get|Set|New|Remove|Invoke|Start|Stop|Restart|Test|Write|Read|Enable|Disable)-[a-zA-Z0-9]+\b/iy },
      { type: 'op', regex: /-eq|-ne|-lt|-gt|-le|-ge|-like|-notlike|-match|-notmatch|-contains|-notcontains|-in|-notin|-replace|-join|-split|-and|-or|-not|\||=|==/iy },
      { type: 'punct', regex: /[{}()\[\];,]/y }
    ],
    markdown: [
      { type: 'keyword', regex: /^#{1,6}\s+[^\n]*/my },
      { type: 'comment', regex: /^>[^\n]*/my },
      { type: 'string', regex: /```[\s\S]*?```|`[^`\n]+`/y },
      { type: 'type', regex: /\*\*[^*]+\*\*|__[^_]+__/y },
      { type: 'fn', regex: /\[[^\]]+\]\([^)\s]+\)/y },
      { type: 'punct', regex: /^[*\-+]\s+/my }
    ],
    c: [
      { type: 'keyword', regex: /#\s*(?:include|define|ifdef|ifndef|endif|pragma|if|else|elif)[^\n]*/y },
      { type: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
      { type: 'string', regex: /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/y },
      { type: 'number', regex: /\b(?:0x[a-fA-F0-9]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]*)\b/y },
      { type: 'keyword', regex: /\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|int|long|register|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while)\b/y },
      { type: 'bool', regex: /\b(?:true|false|NULL)\b/y },
      { type: 'fn', regex: /\b([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*\()/y },
      { type: 'type', regex: /\b[A-Z][a-zA-Z0-9_]*\b/y },
      { type: 'op', regex: /->|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|[+\-*\/%=&|^~<>!]/y },
      { type: 'punct', regex: /[{}()\[\];,.]/y }
    ]
  };

  // Aliases for related syntaxes
  RULES.typescript = RULES.javascript;
  RULES.xml = RULES.html;
  RULES.svg = RULES.html;
  RULES.yaml = RULES.shell;
  RULES.toml = RULES.shell;
  RULES.ini = RULES.shell;
  RULES.cpp = RULES.c;
  RULES.csharp = RULES.c;
  RULES.java = RULES.c;
  RULES.rust = RULES.c;
  RULES.go = RULES.c;
  RULES.php = RULES.javascript;
  RULES.ruby = RULES.python;

  /**
   * Tokenizes and converts code text into an array of line HTML strings.
   * Every line is guaranteed to have fully-closed syntax spans.
   */
  function highlightToLines(code, lang) {
    const raw = String(code == null ? '' : code).replace(/\r\n/g, '\n');
    const rules = RULES[lang];
    const lines = [[]];

    const pushToken = (text, type) => {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push([]);
        if (parts[i].length > 0) {
          const escaped = escapeHtml(parts[i]);
          const html = type ? `<span class="syn-${type}">${escaped}</span>` : escaped;
          lines[lines.length - 1].push(html);
        }
      }
    };

    if (!rules || raw.length > 500000) {
      // Plain text or excessively huge file: escape line-by-line safely
      pushToken(raw, '');
      return lines.map((l) => l.join(''));
    }

    let pos = 0;
    const len = raw.length;

    while (pos < len) {
      let matched = false;
      for (let r = 0; r < rules.length; r++) {
        const rule = rules[r];
        rule.regex.lastIndex = pos;
        const m = rule.regex.exec(raw);
        if (m && m.index === pos) {
          pushToken(m[0], rule.type);
          pos += m[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        pushToken(raw[pos], '');
        pos++;
      }
    }

    return lines.map((l) => l.join(''));
  }

  /**
   * Builds an interactive, formatted code viewer with line numbers,
   * syntax highlighting, copy button, language indicator, and JSON prettifier.
   */
  function createCodeViewer(initialCode, filename, opts = {}) {
    let currentCode = String(initialCode == null ? '' : initialCode);
    let savedCode = currentCode;
    let isDirty = false;
    let isEditing = false;
    const lang = detectLanguage(filename);
    const langLabel = LANG_NAMES[lang] || lang.toUpperCase();

    // JSON auto-prettify check
    let isJson = lang === 'json';
    let canPrettify = false;
    let isPrettified = false;
    let originalJson = currentCode;

    if (isJson) {
      try {
        const parsed = JSON.parse(currentCode);
        canPrettify = true;
        const lineCount = currentCode.replace(/\r\n/g, '\n').split('\n').length;
        // Auto-format minified/dense JSON
        if (lineCount <= 2 && currentCode.length > 50) {
          currentCode = JSON.stringify(parsed, null, 2);
          savedCode = currentCode;
          isPrettified = true;
        }
      } catch {
        canPrettify = false;
      }
    }

    const container = document.createElement('div');
    container.className = 'code-viewer';

    // View box (syntax table)
    const viewBox = document.createElement('div');
    viewBox.className = 'code-viewer-scroll';
    container.appendChild(viewBox);

    const table = document.createElement('table');
    table.className = 'code-table';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    viewBox.appendChild(table);

    // Edit box (interactive code editor with gutter)
    const editBox = document.createElement('div');
    editBox.className = 'code-editor-wrap hidden';
    container.appendChild(editBox);

    const gutter = document.createElement('div');
    gutter.className = 'editor-gutter';
    editBox.appendChild(gutter);

    const textarea = document.createElement('textarea');
    textarea.className = 'editor-textarea';
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.autocapitalize = 'off';
    textarea.wrap = 'off';
    editBox.appendChild(textarea);

    // Header badges
    const badges = [];

    const badgeLang = document.createElement('span');
    badgeLang.className = 'code-badge';
    badgeLang.textContent = langLabel;
    badges.push(badgeLang);

    const badgeLines = document.createElement('span');
    badgeLines.className = 'code-lines-count muted';
    badges.push(badgeLines);

    const badgeDirty = document.createElement('span');
    badgeDirty.className = 'code-dirty-badge hidden';
    badgeDirty.textContent = '• Modified';
    badges.push(badgeDirty);

    // Format toggle button for JSON
    let btnFormat = null;
    if (canPrettify) {
      btnFormat = document.createElement('button');
      btnFormat.type = 'button';
      btnFormat.className = 'btn btn-ghost sm code-format-btn';
      btnFormat.title = isPrettified ? 'View original JSON' : 'Prettify / Format JSON';
      btnFormat.textContent = isPrettified ? 'Compact' : '✨ Format';
      btnFormat.onclick = () => {
        try {
          if (isPrettified) {
            currentCode = originalJson;
            isPrettified = false;
            btnFormat.textContent = '✨ Format';
          } else {
            const parsed = JSON.parse(currentCode);
            currentCode = JSON.stringify(parsed, null, 2);
            isPrettified = true;
            btnFormat.textContent = 'Compact';
          }
          savedCode = currentCode;
          textarea.value = currentCode;
          renderRows();
        } catch { /* ignore parse error */ }
      };
      badges.push(btnFormat);
    }

    // Copy button
    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'btn btn-ghost sm code-copy-btn';
    btnCopy.title = 'Copy code to clipboard';
    btnCopy.innerHTML = '📋 Copy';
    btnCopy.onclick = async () => {
      try {
        const textToCopy = isEditing ? textarea.value : currentCode;
        if (typeof global.copyText === 'function') {
          await global.copyText(textToCopy);
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(textToCopy);
        }
        btnCopy.innerHTML = '✓ Copied';
        btnCopy.classList.add('copied');
        setTimeout(() => {
          btnCopy.innerHTML = '📋 Copy';
          btnCopy.classList.remove('copied');
        }, 1600);
      } catch {
        btnCopy.textContent = 'Failed';
      }
    };
    badges.push(btnCopy);

    // Edit button
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn btn-ghost sm code-edit-btn';
    btnEdit.title = 'Edit file';
    btnEdit.innerHTML = '✏️ Edit';
    badges.push(btnEdit);

    // Save button
    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'btn btn-primary sm code-save-btn hidden';
    btnSave.title = 'Save changes (Ctrl+S)';
    btnSave.innerHTML = '💾 Save';
    btnSave.disabled = true;
    badges.push(btnSave);

    // Cancel button
    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'btn btn-ghost sm code-cancel-btn hidden';
    btnCancel.title = 'Cancel editing';
    btnCancel.innerHTML = '✕ Cancel';
    badges.push(btnCancel);

    function updateEditorGutter() {
      const lines = textarea.value.split('\n');
      const count = lines.length;
      let s = '';
      for (let i = 1; i <= count; i++) {
        s += `<div class="editor-line-num">${i}</div>`;
      }
      gutter.innerHTML = s;
      badgeLines.textContent = `${count} ${count === 1 ? 'line' : 'lines'}`;
    }

    function checkDirty() {
      isDirty = textarea.value !== savedCode;
      badgeDirty.classList.toggle('hidden', !isDirty);
      btnSave.disabled = !isDirty;
    }

    textarea.addEventListener('input', () => {
      updateEditorGutter();
      checkDirty();
    });

    textarea.addEventListener('scroll', () => {
      gutter.scrollTop = textarea.scrollTop;
    });

    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveEdits();
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const val = textarea.value;

        if (e.shiftKey) {
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          if (val.slice(lineStart, lineStart + 2) === '  ') {
            textarea.value = val.slice(0, lineStart) + val.slice(lineStart + 2);
            textarea.selectionStart = Math.max(lineStart, start - 2);
            textarea.selectionEnd = Math.max(lineStart, end - 2);
          } else if (val[lineStart] === ' ') {
            textarea.value = val.slice(0, lineStart) + val.slice(lineStart + 1);
            textarea.selectionStart = Math.max(lineStart, start - 1);
            textarea.selectionEnd = Math.max(lineStart, end - 1);
          }
        } else {
          textarea.value = val.slice(0, start) + '  ' + val.slice(end);
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }
        updateEditorGutter();
        checkDirty();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const val = textarea.value;
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const currentLine = val.slice(lineStart, start);
        const match = currentLine.match(/^(\s*)/);
        let indent = match ? match[1] : '';
        if (/[{\[:(]\s*$/.test(currentLine)) {
          indent += '  ';
        }
        const insert = '\n' + indent;
        textarea.value = val.slice(0, start) + insert + val.slice(start);
        textarea.selectionStart = textarea.selectionEnd = start + insert.length;
        updateEditorGutter();
        checkDirty();
        return;
      }
    });

    function setEditMode(editing) {
      isEditing = !!editing;
      if (isEditing) {
        textarea.value = currentCode;
        viewBox.classList.add('hidden');
        editBox.classList.remove('hidden');

        btnCopy.classList.add('hidden');
        if (btnFormat) btnFormat.classList.add('hidden');
        btnEdit.classList.add('hidden');

        btnSave.classList.remove('hidden');
        btnCancel.classList.remove('hidden');

        updateEditorGutter();
        checkDirty();
        setTimeout(() => textarea.focus(), 30);
      } else {
        editBox.classList.add('hidden');
        viewBox.classList.remove('hidden');

        btnCopy.classList.remove('hidden');
        if (btnFormat) btnFormat.classList.remove('hidden');
        btnEdit.classList.remove('hidden');

        btnSave.classList.add('hidden');
        btnCancel.classList.add('hidden');
        badgeDirty.classList.add('hidden');

        renderRows();
      }
    }

    btnEdit.onclick = () => setEditMode(true);

    btnCancel.onclick = () => {
      if (isDirty && !confirm('Discard unsaved changes?')) return;
      textarea.value = savedCode;
      currentCode = savedCode;
      isDirty = false;
      setEditMode(false);
    };

    async function saveEdits() {
      if (!isDirty && !isEditing) return;
      const newText = isEditing ? textarea.value : currentCode;
      if (typeof opts.onSave === 'function') {
        btnSave.disabled = true;
        const prevText = btnSave.innerHTML;
        btnSave.innerHTML = 'Saving…';
        try {
          await opts.onSave(newText);
          savedCode = newText;
          currentCode = newText;
          isDirty = false;
          badgeDirty.classList.add('hidden');
          btnSave.innerHTML = '✓ Saved';
          setTimeout(() => {
            btnSave.innerHTML = '💾 Save';
            btnSave.disabled = true;
          }, 1400);
          renderRows();
        } catch (err) {
          btnSave.innerHTML = prevText;
          btnSave.disabled = false;
          alert(err.message || 'Failed to save file');
        }
      }
    }

    btnSave.onclick = saveEdits;

    function renderRows() {
      tbody.innerHTML = '';
      const lineHtmls = highlightToLines(currentCode, lang);
      const total = lineHtmls.length;
      badgeLines.textContent = `${total} ${total === 1 ? 'line' : 'lines'}`;

      const frag = document.createDocumentFragment();
      for (let i = 0; i < total; i++) {
        const tr = document.createElement('tr');
        tr.className = 'code-row';

        const tdNum = document.createElement('td');
        tdNum.className = 'line-num';
        tdNum.dataset.line = String(i + 1);
        tdNum.textContent = String(i + 1);

        const tdCode = document.createElement('td');
        tdCode.className = 'line-code';
        const h = lineHtmls[i];
        if (h) {
          tdCode.innerHTML = h;
        } else {
          tdCode.innerHTML = ' ';
        }

        tr.appendChild(tdNum);
        tr.appendChild(tdCode);
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
    }

    renderRows();

    return {
      container,
      badges,
      getCode: () => (isEditing ? textarea.value : currentCode),
      setCode: (newCode) => {
        currentCode = String(newCode);
        savedCode = currentCode;
        textarea.value = currentCode;
        isDirty = false;
        renderRows();
      },
      isDirty: () => isDirty,
      setEditMode
    };
  }

  // Export to window/global
  global.detectLanguage = detectLanguage;
  global.highlightToLines = highlightToLines;
  global.createCodeViewer = createCodeViewer;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectLanguage, highlightToLines, createCodeViewer };
  }
})(typeof window !== 'undefined' ? window : globalThis);

