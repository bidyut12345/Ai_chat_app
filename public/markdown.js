/**
 * Tiny dependency-free Markdown renderer.
 * HTML is escaped first, so model output can never inject markup.
 * Supports: fenced code blocks, inline code, bold/italic/strike, links,
 * headings, blockquotes, ordered/unordered lists, tables, paragraphs.
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

  // Images the agent produced are local filesystem paths (C:\dir\a.png,
  // ./a.png, /tmp/a.png, a.png). A browser cannot fetch those, so they are
  // routed through the conversation file API exposed by app.js as
  // window.conversationFileUrl(path).
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i;

  function isLocalImagePath(t) {
    if (!IMAGE_EXT_RE.test(t)) return false;
    if (/^data:/i.test(t)) return false;
    // A real scheme has 2+ chars before the colon. A single letter is a
    // Windows drive letter ("C:\..."), not a scheme.
    if (/^[a-z][a-z0-9+.-]+:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) return false;
    if (/[\\/]/.test(t)) {
      const first = t.split(/[\\/]/)[0];
      if (first === '' || first === '.' || first === '..') return true;
      // "example.com/cat.png": the first segment is a hostname, so remote.
      if (/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(first)) return false;
      return true;
    }
    // A bare "photo.png" is a file, not a host (hosts need a dotted TLD).
    return true;
  }

  function imageUrl(u) {
    const t = String(u || '').trim().replace(/&amp;/g, '&');
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(t)) return t;
    if (/^https?:\/\//i.test(t)) return t;
    if (isLocalImagePath(t)) {
      const api = global.conversationFileUrl;
      if (typeof api !== 'function') return '#';
      try {
        return api(t) || '#';
      } catch {
        return '#';
      }
    }
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return `https://${t}`;
    return '#';
  }

  function safeUrl(u) {
    const t = String(u || '').trim();
    if (/^(https?:|mailto:|#|\/)/i.test(t)) return t;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return `https://${t}`;
    return '#';
  }

  function inline(md) {
    let s = md;
    // inline code first (protect its contents)
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    // images then links
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
      const u = imageUrl(url.replace(/&amp;/g, '&'));
      return u === '#' ? escapeHtml(alt) : `<img src="${u}" alt="${alt}" loading="lazy">`;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) => {
      const u = safeUrl(url.replace(/&amp;/g, '&'));
      return `<a href="${u}" target="_blank" rel="noreferrer">${text}</a>`;
    });
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<>"']+)/g, (_, p, url) => `${p}<a href="${safeUrl(url)}" target="_blank" rel="noreferrer">${url}</a>`);
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
    return s;
  }

  function renderMarkdown(src) {
    if (src == null) return '';
    const text = escapeHtml(src).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
      para = [];
    };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code
      const fence = line.match(/^```([\w+-]*)\s*$/);
      if (fence) {
        flushPara();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++; // closing fence
        const code = buf.join('\n');
        out.push(
          `<div class="code-block"><button class="code-copy" type="button">copy</button>` +
            `<pre><code data-lang="${escapeHtml(lang)}">${code}</code></pre></div>`
        );
        continue;
      }

      if (!line.trim()) {
        flushPara();
        i++;
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const lvl = h[1].length;
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        i++;
        continue;
      }

      // `>` was already escaped to `&gt;` by escapeHtml, so match that form.
      if (/^&gt;\s?/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ''));
        out.push(`<blockquote>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flushPara();
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push(
          `<table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
            `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        );
        continue;
      }

      // lists
      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const ordered = !!ol;
        const items = [];
        while (i < lines.length) {
          const m = ordered ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/) : lines[i].match(/^\s*[-*+]\s+(.*)$/);
          if (!m) break;
          items.push(m[1]);
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara();
    return out.join('\n');
  }

  function splitRow(line) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  global.renderMarkdown = renderMarkdown;
  global.escapeHtml = escapeHtml;
})(window);
