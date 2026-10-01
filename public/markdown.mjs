/**
 * A small, safe markdown renderer for Claude's replies.
 *
 * No npm dependency, and no sanitiser needed: **every byte of the source is
 * HTML-escaped**, and the only markup in the output is markup this file
 * writes. There is no raw-HTML passthrough at all (a `<details>` in a reply
 * shows as text), and a link is emitted only for `http(s)`/`mailto` URLs and
 * in-page `#anchors`. Anything else (`javascript:`, `data:`, `file:`, a
 * relative path) is shown as plain text.
 *
 * Covers: ATX and setext headings, paragraphs, bold / italic /
 * strikethrough / inline code, fenced code, links, bullet / numbered / task
 * lists (nested by indent), block quotes, horizontal rules, GitHub pipe
 * tables, and HTML comments (dropped, as GitHub does).
 *
 * Pure: a string in, an HTML string out. No DOM, so it is testable in node.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** `a/b/../c.md` → `a/c.md`; null when it climbs above the root. */
export function resolveRelative(base, target) {
  const parts = String(base || '').split('/').slice(0, -1);
  for (const seg of String(target).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** A heading's anchor id, GitHub-style, namespaced so it cannot collide
 *  with an id the page itself uses. */
export function slugify(text) {
  return 'md-' + String(text).toLowerCase().trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * One link's href, decided. Returns `{kind, href}` where kind is `ext`
 * (opens a new tab), `anchor` (`href` is a heading id) or `none` (rendered as text).
 */
export function classifyLink(url, docPath = '') {
  const u = String(url || '').trim().replace(/^<|>$/g, '');
  if (/^https?:\/\//i.test(u) || /^mailto:[^\s]+$/i.test(u)) {
    return { kind: 'ext', href: u };
  }
  if (u.startsWith('#')) return { kind: 'anchor', href: slugify(decodeSafe(u.slice(1))) };
  // any other scheme — javascript:, data:, vbscript:, file:, … — and
  // anything protocol-relative is refused outright
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//') || u.includes('\\')) {
    return { kind: 'none', href: null };
  }
  return { kind: 'none', href: null };
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── inline ───────────────────────────────────────────────────────────

const PH = '\u0000';

function renderInline(src, ctx) {
  const slots = [];
  const keep = (html) => `${PH}${slots.push(html) - 1}${PH}`;
  let s = String(src).replace(/\u0000/g, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // code spans first: nothing inside them is markdown
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g,
    (_, _t, code) => keep(`<code>${escapeHtml(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`));
  // backslash escapes
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c) => keep(escapeHtml(c)));
  // Links keep only their TAGS as placeholders; the text between stays in
  // the stream, so it is escaped and emphasised with everything else.
  const wrap = (u, text) => {
    const [open, close] = linkTags(u, ctx);
    return keep(open) + text + keep(close);
  };
  // autolinks <https://…>
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/gi, (_, u) => wrap(u, u));
  // images: never loaded — the alt text, linked when the target is safe
  s = s.replace(/!\[([^\]]*)\]\(([^()\s]*(?:\([^()\s]*\))?[^()\s]*)(?:\s+"[^"]*")?\)/g,
    (_, alt, u) => wrap(u, `🖼 ${alt || u}`));
  // links [text](url "title")
  s = s.replace(/\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()\s]*\))?[^()\s]*)(?:\s+"[^"]*")?\s*\)/g,
    (_, text, u) => wrap(u, text));
  // bare URLs
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()\u0000]+[^\s<>().,;:!?'"\u0000])/g,
    (_, pre, u) => pre + wrap(u, u));

  s = escapeHtml(s);
  // emphasis on the escaped text; placeholders pass through untouched
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>');
  s = s.replace(/\*(?=[^\s*])([^*])\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_]|[^\s_])_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  // hard break: two trailing spaces before a newline
  s = s.replace(/ {2,}\n/g, '<br>\n');

  return s.replace(new RegExp(`${PH}(\\d+)${PH}`, 'g'), (_, n) => slots[Number(n)]);
}

/** The opening and closing tag for one link — or a plain span when the
 *  target is not one this viewer will follow. */
function linkTags(url, ctx) {
  const { kind, href } = classifyLink(url, ctx.docPath);
  if (kind === 'ext') {
    return [`<a class="md-ext" href="${escapeHtml(href)}" target="_blank" `
      + 'rel="noopener noreferrer">', '</a>'];
  }
  if (kind === 'doc') {
    return [`<a class="md-doc" href="#" data-doc="${escapeHtml(href)}" `
      + `title="${escapeHtml(href)}">`, '</a>'];
  }
  if (kind === 'anchor') {
    return [`<a class="md-anchor" href="#" data-anchor="${escapeHtml(href)}">`, '</a>'];
  }
  return [`<span class="md-nolink" title="${escapeHtml(String(url))}">`, '</span>'];
}

// ── blocks ───────────────────────────────────────────────────────────

const RE = {
  fence: /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?(.*)$/,
  item: /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  delim: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  comment: /^\s*<!--/,
};

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let tick = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '\\|'; i += 1; continue; }
    if (c === '`') tick = tick ? 0 : 1;
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isBlockStart(line) {
  return RE.fence.test(line) || RE.atx.test(line) || RE.hr.test(line)
    || RE.quote.test(line) || RE.item.test(line) || RE.comment.test(line);
}

function renderBlocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    // HTML comment block — dropped whole
    if (RE.comment.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i += 1;
      i += 1;
      continue;
    }

    let m = RE.fence.exec(line);
    if (m) {
      const [, indent, marker, lang] = m;
      const body = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim().startsWith(marker[0].repeat(marker.length))
            && /^\s*([`~])\1*\s*$/.test(l)) { i += 1; break; }
        body.push(indent ? l.replace(new RegExp(`^ {0,${indent.length}}`), '') : l);
        i += 1;
      }
      const cls = lang ? ` class="lang-${escapeHtml(lang.replace(/[^\w+-]/g, ''))}"` : '';
      out.push(`<pre class="md-code"><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    m = RE.atx.exec(line);
    if (m) {
      const level = m[1].length;
      const text = m[2] || '';
      out.push(`<h${level} id="${escapeHtml(slugify(text))}">`
        + `${renderInline(text, ctx)}</h${level}>`);
      i += 1;
      continue;
    }

    if (RE.hr.test(line)) { out.push('<hr>'); i += 1; continue; }

    if (RE.quote.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim()) {
        const q = RE.quote.exec(lines[i]);
        body.push(q ? q[1] : lines[i]);
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(body, ctx)}</blockquote>`);
      continue;
    }

    if (RE.item.test(line)) {
      i = renderList(lines, i, ctx, out);
      continue;
    }

    // a pipe table: a header row, then the delimiter row
    if (line.includes('|') && i + 1 < lines.length && RE.delim.test(lines[i + 1])
        && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'c' : r ? 'r' : l ? 'l' : '';
      });
      const cell = (tag, c, n) => {
        const al = aligns[n] ? ` class="al-${aligns[n]}"` : '';
        return `<${tag}${al}>${renderInline(c, ctx)}</${tag}>`;
      };
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(`<tr>${head.map((_, n) => cell('td', cells[n] ?? '', n)).join('')}</tr>`);
        i += 1;
      }
      out.push('<div class="md-table"><table><thead><tr>'
        + head.map((c, n) => cell('th', c, n)).join('')
        + `</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }

    // a paragraph — or a setext heading when underlined
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])
           && !RE.setext.test(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && RE.delim.test(lines[i + 1])) break;
      para.push(lines[i]);
      i += 1;
    }
    if (i < lines.length && lines[i].trim() && RE.setext.test(lines[i])) {
      const level = lines[i].trim()[0] === '=' ? 1 : 2;
      const text = para.join(' ');
      out.push(`<h${level} id="${escapeHtml(slugify(text))}">`
        + `${renderInline(text, ctx)}</h${level}>`);
      i += 1;
      continue;
    }
    out.push(`<p>${renderInline(para.map((l) => l.replace(/^\s+/, '')).join('\n'), ctx)}</p>`);
  }
  return out.join('\n');
}

/** A list starting at `start`; returns the index after it. Items nest by
 *  indentation: a line indented past the marker belongs to the item. */
function renderList(lines, start, ctx, out) {
  const first = RE.item.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = RE.item.exec(lines[i]);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const body = [m[3] || ''];
    i += 1;
    let blankRun = false;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { blankRun = true; body.push(''); i += 1; continue; }
      const indent = l.length - l.trimStart().length;
      if (indent >= Math.min(contentIndent, baseIndent + 2)) {
        if (blankRun) loose = true;
        blankRun = false;
        body.push(l.slice(Math.min(indent, contentIndent)));
        i += 1;
        continue;
      }
      // lazy continuation: unindented text straight after the item's text
      if (!blankRun && !isBlockStart(l) && indent > baseIndent - 1
          && !(RE.item.test(l))) {
        body.push(l.trim());
        i += 1;
        continue;
      }
      break;
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    items.push(body);
    // a blank line followed by another item of this list keeps the list going
    if (i < lines.length && !lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const n = j < lines.length ? RE.item.exec(lines[j]) : null;
      if (n && n[1].length === baseIndent && /\d/.test(n[2]) === ordered) {
        loose = true;
        i = j;
      }
    }
  }
  const lis = items.map((body) => {
    let task = '';
    const t = /^\[([ xX])\][ \t]+/.exec(body[0]);
    if (t) {
      task = `<span class="md-task">${t[1] === ' ' ? '☐' : '☑'}</span> `;
      body[0] = body[0].slice(t[0].length);
    }
    let html = renderBlocks(body, ctx);
    if (!loose) html = html.replace(/<p>([\s\S]*?)<\/p>/g, '$1');
    return `<li>${task}${html}</li>`;
  });
  const startAttr = ordered && parseInt(first[2], 10) !== 1
    ? ` start="${parseInt(first[2], 10)}"` : '';
  out.push(ordered ? `<ol${startAttr}>${lis.join('')}</ol>` : `<ul>${lis.join('')}</ul>`);
  return i;
}

// ── frontmatter ──────────────────────────────────────────────────────

/** `{fields: [[key, value]], body}` — YAML frontmatter, flat; comments
 *  dropped, lists shown as written. */
export function splitFrontmatter(text) {
  const src = String(text ?? '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { fields: [], body: src };
  const fields = [];
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s*(.*)$/.exec(raw);
    if (item && fields.length) {
      const last = fields[fields.length - 1];
      last[1] = last[1] ? `${last[1]}, ${item[1]}` : item[1];
      continue;
    }
    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1].trim();
    let value = kv[2];
    // an inline `# comment` on a control field (never on free text)
    if (!['summary', 'ks_target'].includes(key)) value = value.replace(/\s+#.*$/, '');
    fields.push([key, value.trim().replace(/^(['"])(.*)\1$/, '$2')]);
  }
  return { fields, body: src.slice(m[0].length) };
}

/**
 * Markdown → HTML. `docPath` is kept for API compatibility; relative links
 * are never rendered as links here.
 */
export function renderMarkdown(text, { docPath = '' } = {}) {
  const { fields, body } = splitFrontmatter(text);
  const ctx = { docPath };
  const lines = body.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  let front = '';
  if (fields.length) {
    front = '<dl class="md-front">' + fields.map(([k, v]) =>
      `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('') + '</dl>';
  }
  return front + renderBlocks(lines, ctx);
}
