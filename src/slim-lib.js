/**
 * SLIM — JavaScript Parser & Converter v2.0
 * Structured LLM Instruction Markup
 *
 * © 2026 Sasidhar Nagandla. MIT License.
 * Made with passion by Sasidhar — https://slimformat.org
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SLIM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIRECTIVE_KEYWORDS = new Set(['CALL','ASSERT','YIELD','EMIT','LOG','ABORT','WAIT','RETRY']);
  const HEADER_KEY_RE  = /^@(\+?)([a-z][a-z0-9_-]*)$/;
  const DIRECTIVE_RE   = /^>\s+([A-Z]+)(.*)$/;
  // v1 block syntax (kept for backward compat)
  const BLOCK_OPEN_RE  = /^===\s+([A-Z][A-Z0-9_]*)(?:\s+\[([^\]]+)\])?$/;
  const BLOCK_CLOSE_RE = /^===\s+\/([A-Z][A-Z0-9_]*)$/;
  // v2 section syntax
  const SECTION_RE     = /^::([A-Za-z][A-Za-z0-9_]*)(?:\s+(\S+))?$/;
  const NESTED_RE      = /^:::([A-Za-z][A-Za-z0-9_]*)(?:\s+(\S+))?$/;

  // Hard limits to prevent resource exhaustion (Finding 6 / DoS guard)
  const MAX_INPUT_CHARS  = 1 * 1024 * 1024; // 1 MB
  const MAX_LINES        = 50_000;
  const MAX_COERCE_DEPTH = 5;

  // ── HTML escape helper (used by highlight) ───────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Type coercion ────────────────────────────────────────────
  // depth guard prevents unbounded recursion on deeply nested comma lists
  function coerce(v, _depth) {
    _depth = (_depth || 0);
    if (typeof v !== 'string') return v;
    v = v.trim();
    if (v.length > 1024) return v;                                 // length guard (Finding 12)
    if (v.toLowerCase() === 'true')  return true;
    if (v.toLowerCase() === 'false') return false;
    if (['null','none'].includes(v.toLowerCase())) return null;
    if (/^-?\d+$/.test(v))       return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v))  return parseFloat(v);
    if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
    if (_depth < MAX_COERCE_DEPTH && v.includes(','))
      return v.split(',').map(p => p.trim()).filter(Boolean).map(p => coerce(p, _depth + 1));
    return v;
  }

  // ── Variable interpolation ───────────────────────────────────
  // Uses hasOwnProperty to avoid prototype chain leakage (Finding 15)
  function interpolate(text, vars) {
    return text.replace(/\$([a-zA-Z][a-zA-Z0-9_]*)(\.[a-zA-Z0-9_.[\]]*)?/g, (m, key, tail) => {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return m;
      const val = vars[key];
      return (Array.isArray(val) ? val.join(', ') : String(val)) + (tail || '');
    });
  }

  // ── v1 Block extractor (=== NAME ... === /NAME) ──────────────
  function extractBlocks(lines, offset) {
    const blocks = Object.create(null), out = [], errors = [];
    let i = 0;
    while (i < lines.length) {
      const stripped = lines[i].trim();
      const mO = BLOCK_OPEN_RE.exec(stripped);
      if (mO) {
        const name = mO[1], typeTag = mO[2] || null, start = offset + i;
        const content = []; i++; let closed = false;
        while (i < lines.length) {
          const inner = lines[i].trim();
          const mC = BLOCK_CLOSE_RE.exec(inner);
          if (mC && mC[1].toUpperCase() === name) { closed = true; break; }
          content.push(lines[i].replace(/\s+$/, ''));
          i++;
        }
        if (!closed) { errors.push({ line: start, message: `Unclosed block: ${name}` }); i++; continue; }
        blocks[name] = {
          name, typeTag, lineStart: start,
          content: content.map(l => l.trim().startsWith('\\===') ? l.replace('\\===', '===') : l).join('\n')
        };
        out.push(`=== ${name}`); i++; continue;
      }
      out.push(lines[i].replace(/\s+$/, '')); i++;
    }
    return { blocks, outLines: out, errors };
  }

  // ── v2 Section extractor (::NAME type, :::NAME type) ─────────
  function extractSections(lines) {
    const sections = Object.create(null);
    let openName = null, openType = null, content = [];
    function flush() {
      if (openName) {
        sections[openName] = { name: openName, type: openType, content: content.join('\n') };
        openName = null; openType = null; content = [];
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], t = raw.trim();
      // :::NAME (nested) — no blank-line requirement
      if (t.startsWith(':::') && !t.startsWith('::::')) {
        const m = NESTED_RE.exec(t);
        if (m) { flush(); openName = m[1]; openType = m[2] || null; continue; }
      }
      // ::NAME (top-level) — requires blank line before (or start of file)
      if (t.startsWith('::') && !t.startsWith(':::')) {
        const prev = i > 0 ? lines[i - 1].trim() : '';
        if (i === 0 || prev === '') {
          const m = SECTION_RE.exec(t);
          if (m) { flush(); openName = m[1]; openType = m[2] || null; continue; }
        }
      }
      if (openName) content.push(/^\\::/.test(raw) ? raw.slice(1).replace(/\s+$/, '') : raw.replace(/\s+$/, ''));
    }
    flush();
    return sections;
  }

  // ── Main parser ──────────────────────────────────────────────
  function parse(text) {
    // Input size guard — prevents memory/CPU exhaustion (Finding 6)
    if (typeof text !== 'string') return _emptyDoc();
    if (text.length > MAX_INPUT_CHARS)
      return _emptyDoc([{ line: 0, message: `Input too large (max ${MAX_INPUT_CHARS / 1024}KB)` }]);

    const lines = text.split('\n');
    if (lines.length > MAX_LINES)
      return _emptyDoc([{ line: 0, message: `Too many lines (max ${MAX_LINES})` }]);

    const errors = [], warnings = [];
    // Object.create(null) severs prototype chain — prevents prototype pollution (Finding 7)
    const headers = Object.create(null), llmHeaders = Object.create(null);
    let i = 0, inHeader = true;

    while (i < lines.length && inHeader) {
      const stripped = lines[i].trim();
      if (stripped === '' || stripped === '---') { i++; continue; }
      const ci = stripped.indexOf(': ');
      const m = HEADER_KEY_RE.exec(ci >= 0 ? stripped.substring(0, ci) : stripped);
      if (m && ci >= 0) {
        const plus = m[1] === '+', key = m[2];
        let val = stripped.substring(ci + 2);
        while (i + 1 < lines.length && lines[i + 1].startsWith('  ')) { i++; val += ' ' + lines[i].trim(); }
        if (plus) llmHeaders[key] = coerce(val);
        else      headers[key]    = coerce(val);
      } else { inHeader = false; continue; }
      i++;
    }

    // Detect version and choose appropriate extractor
    const version = String(Object.prototype.hasOwnProperty.call(headers, 'slim') ? headers['slim'] : '2.0');
    const rawBodyLines = lines.slice(i);
    let blocks, bodyLines;
    if (version === '1.0') {
      const result = extractBlocks(rawBodyLines, i);
      blocks = result.blocks; bodyLines = result.outLines; errors.push(...result.errors);
    } else {
      blocks = extractSections(rawBodyLines);
      bodyLines = rawBodyLines.map(l => l.replace(/\s+$/, ''));
    }

    const directives = [];
    for (let ln = 0; ln < bodyLines.length; ln++) {
      const m = DIRECTIVE_RE.exec(bodyLines[ln].trim());
      if (m && DIRECTIVE_KEYWORDS.has(m[1]))
        directives.push({ keyword: m[1], args: m[2].trim(), line: i + ln });
    }

    // Merge with Object.assign to a null-prototype object (Finding 7)
    const variables = Object.assign(Object.create(null), headers, llmHeaders);
    return {
      version,
      headers, llmHeaders, bodyLines, blocks, directives, variables, errors, warnings,
      toLlmText() {
        const out = [];
        for (const k of Object.keys(llmHeaders)) out.push(`@+${k}: ${llmHeaders[k]}`);
        if (out.length) out.push('');
        for (const l of bodyLines) { if (!l.trim().startsWith('~')) out.push(l); }
        return interpolate(out.join('\n'), variables);
      },
      get tokenEstimate() { return Math.max(1, Math.round(this.toLlmText().length / 4)); }
    };
  }

  function _emptyDoc(errors) {
    const h = Object.create(null), lh = Object.create(null), v = Object.create(null);
    return {
      version: '2.0', headers: h, llmHeaders: lh, bodyLines: [], blocks: Object.create(null),
      directives: [], variables: v, errors: errors || [], warnings: [],
      toLlmText() { return ''; },
      get tokenEstimate() { return 0; }
    };
  }

  // ── Sanitizer ────────────────────────────────────────────────
  function sanitizeUserContent(text) {
    if (typeof text !== 'string') return '';
    text = text.replace(/\\/g, '\\\\');
    for (const s of ['@', '$', '>', '~'])
      text = text.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `\\${s}`);
    // Escape :: only at line start (mid-line :: is safe — common in C++, CSS)
    text = text.split('\n').map(l => /^::/.test(l) ? '\\' + l : l).join('\n');
    return text;
  }

  // ── Token estimator (1 token ≈ 4 chars) ─────────────────────
  function estimateTokens(text) {
    if (typeof text !== 'string') return 0;
    return Math.max(1, Math.round(text.length / 4));
  }

  // ── Inline Markdown stripper ────────────────────────────────
  // Removes decorators that cost tokens but add no semantic value for LLMs.
  // Called on every non-code, non-blank body line.
  function _stripInline(s) {
    // Bold+italic combined: ***text*** / ___text___
    s = s.replace(/\*{3}(.+?)\*{3}/g, '$1');
    s = s.replace(/_{3}(.+?)_{3}/g, '$1');
    // Bold: **text** / __text__
    s = s.replace(/\*{2}(.+?)\*{2}/g, '$1');
    s = s.replace(/_{2}(.+?)_{2}/g, '$1');
    // Italic: *text* — guard against list bullets (lone * at start)
    s = s.replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1');
    // Italic: _text_ — only when not inside a word (keeps variable_names safe)
    s = s.replace(/(?<![a-zA-Z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?![a-zA-Z0-9_])/g, '$1');
    // Strikethrough: ~~text~~
    s = s.replace(/~~(.+?)~~/g, '$1');
    // Inline images mid-line: ![alt](url) → alt text only
    s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt);
    // Links: [text](url) → text  (URLs are expensive tokens)
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Reference-style links: [text][ref] → text
    s = s.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
    // HTML tags: only strip known HTML element names — guards against <placeholder text> being destroyed
    s = s.replace(/<\/?(a|abbr|b|blockquote|br|caption|cite|code|col|colgroup|dd|del|details|dfn|div|dl|dt|em|figcaption|figure|footer|h[1-6]|header|hr|i|img|input|ins|kbd|label|li|main|mark|nav|ol|p|pre|q|s|section|small|span|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|time|tr|u|ul|var)(?:\s[^>]*)?\s*\/?>/gi, '');
    // Collapse multiple spaces left by removals
    s = s.replace(/  +/g, ' ').trim();
    return s;
  }

  // ── Markdown → SLIM v2 converter ─────────────────────────────
  function mdToSlm(markdown) {
    if (typeof markdown !== 'string') return '';
    const lines = markdown.split('\n');
    // Only emit @slim: 2.0 when source has YAML frontmatter.
    // Plain files have no metadata to convey and pay a pure token penalty for the header.
    const hasYaml = lines.length > 0 && lines[0].trim() === '---';
    const slmHeaders = hasYaml ? ['@slim: 2.0'] : [];
    let i = 0;

    // ── YAML front-matter → @headers ────────────────────────────
    if (lines[0] && lines[0].trim() === '---') {
      i = 1;
      while (i < lines.length && lines[i].trim() !== '---') {
        const ci = lines[i].indexOf(':');
        if (ci > 0) {
          const key = lines[i].substring(0, ci).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
          const val = lines[i].substring(ci + 1).trim().replace(/^["']|["']$/g, '');
          if (key && val) slmHeaders.push(`@${key}: ${val}`);
        }
        i++;
      }
      i++; // skip closing ---
    }

    const body = [];
    let codeCount = 0;

    while (i < lines.length) {
      const raw = lines[i];
      const t   = raw.trim();

      // ── Code fences → ::CODE_N type (verbatim, no close tag) ───
      if (/^(`{3,}|~{3,})/.test(t)) {
        const fm = t.match(/^(`+|~+)(.*)/);
        const codeFence = fm[1];
        const lang = fm[2].trim();
        codeCount++;
        const secName = `CODE_${codeCount}`;
        body.push('::' + secName + (lang ? ' ' + lang : ' raw'));
        i++;
        while (i < lines.length) {
          const inner = lines[i];
          const innerT = inner.trim();
          if (innerT.startsWith(codeFence)) { i++; break; }
          // Escape :: at line start inside verbatim content
          const escaped = /^::/.test(inner) ? '\\' + inner : inner;
          body.push(escaped.replace(/\s+$/, ''));
          i++;
        }
        continue;
      }

      // ── HTML comments → ~ or strip ──────────────────────────────
      if (t.startsWith('<!--') && t.endsWith('-->')) {
        const c = t.slice(4, -3).trim();
        if (c) body.push(`~ ${c}`);
        i++; continue;
      }
      if (t.startsWith('<!--')) {
        while (i < lines.length && !lines[i].includes('-->')) i++;
        i++; continue;
      }

      // ── Blank lines: strip entirely — LLMs parse structure from headings/bullets,
      // not visual whitespace. Removing blank lines is the single biggest token win
      // on plain-prose agent files that have no other Markdown decoration to strip.
      if (t === '') { i++; continue; }

      // ── Horizontal rules → strip (pure decoration) ───────────────
      if (/^[-*_]{3,}\s*$/.test(t)) { i++; continue; }

      // ── Setext-style headings → ATX style ────────────────────────
      const nextT = (lines[i + 1] || '').trim();
      if (nextT && /^=+$/.test(nextT) && t.length > 0) {
        body.push('# ' + _stripInline(t)); i += 2; continue;
      }
      if (nextT && /^-{2,}$/.test(nextT) && t.length > 0) {
        body.push('## ' + _stripInline(t)); i += 2; continue;
      }

      // ── Link reference definitions: [id]: url → strip ────────────
      // Already inlined [text] references, so definitions are dead weight
      if (/^\[[^\]]+\]:\s*https?:\/\/\S+/.test(t)) { i++; continue; }

      // ── Standalone badge / image lines → strip ────────────────────
      if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(t)) { i++; continue; }

      // ── Table separator rows |---|---| → strip ────────────────────
      if (/^\|[\s\-:|]+\|$/.test(t) && !/[a-zA-Z0-9]/.test(t)) { i++; continue; }

      // ── Compact table cell padding ────────────────────────────────
      if (t.startsWith('|') && t.endsWith('|')) {
        const compact = t.replace(/\|\s+/g, '| ').replace(/\s+\|/g, ' |');
        const indent  = raw.match(/^(\s*)/)[1];
        body.push(indent + _stripInline(compact));
        i++; continue;
      }

      // ── List item markers → strip (keeps indentation; LLMs infer list structure) ──
      const listM = raw.match(/^(\s*)([-*+])\s+(.*)/);
      if (listM) {
        const content = _stripInline(listM[3]);
        if (content) body.push(listM[1] + content);
        i++; continue;
      }
      const ordM = raw.match(/^(\s*)\d+\.\s+(.*)/);
      if (ordM) {
        const content = _stripInline(ordM[2]);
        if (content) body.push(ordM[1] + content);
        i++; continue;
      }

      // ── Pre-existing SLIM section markers → pass through verbatim ────
      // Handles .md files that already embed ::NAME type markers; content
      // must not have strip_inline() applied (e.g. <placeholder> values intact)
      if (/^:::?[A-Za-z][A-Za-z0-9_]*(?:\s+\S+)?$/.test(t)) {
        body.push(t);
        i++;
        while (i < lines.length) {
          const inner = lines[i];
          if (inner.trim() === '') break;
          const escaped = /^::/.test(inner) ? '\\' + inner : inner;
          body.push(escaped.replace(/\s+$/, ''));
          i++;
        }
        continue;
      }

      // ── All other lines: strip inline decorators ─────────────────
      const indent  = raw.match(/^(\s*)/)[1];
      const cleaned = _stripInline(t);
      if (cleaned) body.push(indent + cleaned);
      i++;
    }

    // Strip trailing blank lines
    while (body.length && body[body.length - 1] === '') body.pop();

    const headerPart = slmHeaders.length ? slmHeaders.join('\n') + '\n\n' : '';
    return headerPart + body.join('\n').trimEnd() + '\n';
  }

  // ── JSON → SLIM v2 converter ──────────────────────────────────
  function jsonToSlm(jsonText) {
    if (typeof jsonText !== 'string') return '@slim: 2.0\n';
    let obj;
    try { obj = JSON.parse(jsonText); }
    catch (e) { return `@slim: 2.0\n\n~ JSON parse error: ${escHtml(String(e.message))}\n`; }

    if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
      return `@slim: 2.0\n\n~ JSON root must be an object\n`;

    const headers = ['@slim: 2.0'];
    const sections = [];

    // Use Object.keys (not for...in) to avoid prototype chain enumeration (Finding 7)
    for (const key of Object.keys(obj)) {
      // Neutralise __proto__, constructor, toString etc. (Finding 7)
      if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const safeKey = key.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^-+|-+$/g, '') || 'key';
      const val = obj[key];
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || val === null) {
        headers.push(`@${safeKey}: ${val}`);
      } else {
        const bName = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'BLOCK';
        const content = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        sections.push(`::${bName} json\n${content}`);
      }
    }

    return headers.join('\n') + '\n\n' + sections.join('\n\n') + '\n';
  }

  // ── YAML → SLIM v2 converter ─────────────────────────────────
  function yamlToSlm(yamlText) {
    if (typeof yamlText !== 'string') return '@slim: 2.0\n';

    const lines = yamlText.split('\n');
    const headers = ['@slim: 2.0'];
    const sections = [];
    let i = 0;

    // Skip leading document separator
    while (i < lines.length && lines[i].trim() === '---') i++;

    while (i < lines.length) {
      const raw = lines[i];
      const t   = raw.trim();

      if (t === '' || t === '---' || t === '...') { i++; continue; }

      // YAML comment → SLIM comment
      if (t.startsWith('#')) {
        const c = t.slice(1).trim();
        if (c) sections.push('~ ' + c);
        i++; continue;
      }

      // Top-level key at column 0
      const km = raw.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:([ \t](.*))?$/);
      if (!km) { i++; continue; }

      const key = km[1];
      const val = (km[3] || '').trim();
      // Neutralise prototype-polluting key names (same guard as jsonToSlm)
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') { i++; continue; }

      const safeKey = key.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^-+|-+$/g, '') || 'key';
      const secName = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'SECTION';
      const isBlock = val === '' || val === '|' || val === '>' || val === '|-' || val === '>-';

      if (!isBlock) {
        // Scalar: strip inline comment and surrounding quotes
        const clean = val
          .replace(/\s+#\s.*$/, '')
          .replace(/^["'](.*)["']$/, '$1')
          .trim();
        if (clean) headers.push('@' + safeKey + ': ' + clean);
        i++;
      } else {
        // Complex/multi-line block: collect all indented child lines
        i++;
        const content = [];
        while (i < lines.length) {
          const childRaw = lines[i];
          const childT   = childRaw.trim();
          if (childT !== '' && !/^[ \t]/.test(childRaw)) break;
          if (childT !== '') {
            if (childT.startsWith('#')) {
              const c = childT.slice(1).trim();
              if (c) content.push('~ ' + c);
            } else {
              const stripped = childRaw
                .replace(/^[ \t]+/, '')
                .replace(/^-\s+/, '')
                .replace(/\s+#\s[^'"]*$/, '')
                .replace(/^["'](.*)["']$/, '$1')
                .trim();
              if (stripped) content.push(stripped);
            }
          }
          i++;
        }
        if (content.length) sections.push('::' + secName + '\n' + content.join('\n'));
      }
    }

    const body = sections.join('\n\n').trim();
    return headers.join('\n') + '\n\n' + (body ? body + '\n' : '');
  }

  // ── slimToLlmText — strip orchestrator @header zone ─────────
  // Returns only the body zone — what the LLM actually receives.
  // Mirrors Python slim_to_llm_text() in tests/md_to_slm.py.
  function slimToLlmText(slm) {
    if (typeof slm !== 'string' || !slm) return slm || '';
    const idx = slm.indexOf('\n\n');
    if (idx === -1) return slm;
    const headerCandidate = slm.slice(0, idx);
    if (headerCandidate.split('\n').every(ln => ln === '' || ln.startsWith('@'))) {
      return slm.slice(idx + 2);
    }
    return slm;
  }

  // ── SLIM syntax highlighter (returns HTML) ───────────────────
  // All regex replacements use function callbacks — never string $1 back-references
  // This eliminates replacement-string metachar injection (Finding 1)
  function highlight(slmText) {
    if (typeof slmText !== 'string') return '';
    return slmText
      .split('\n')
      .map(line => {
        // HTML-escape the full line first — this is the security boundary
        const esc = escHtml(line);
        const t = line.trim();

        if (t.startsWith('~'))
          return `<span class="sl-comment">${esc}</span>`;

        if (/^@\+[a-z]/.test(t))
          // Function callback: k and p are substrings of esc (already HTML-safe)
          return esc.replace(/^(@\+[a-z][a-z0-9_-]*)(:)/, (_, k, p) =>
            `<span class="sl-llm-key">${k}</span><span class="sl-punct">${p}</span>`);

        if (/^@[a-z]/.test(t))
          return esc.replace(/^(@[a-z][a-z0-9_-]*)(:)/, (_, k, p) =>
            `<span class="sl-key">${k}</span><span class="sl-punct">${p}</span>`);

        // v1 === blocks and v2 :: / ::: sections both get sl-block styling
        if (/^===/.test(t) || /^:::?[A-Za-z]/.test(t))
          return `<span class="sl-block">${esc}</span>`;

        if (/^>\s+[A-Z]/.test(t))
          return `<span class="sl-directive">${esc}</span>`;

        if (/^#/.test(t))
          return `<span class="sl-heading">${esc}</span>`;

        // Function callback for variable spans — v is a substring of esc
        return esc.replace(/(\$[a-zA-Z][a-zA-Z0-9_]*)/g, (_, v) =>
          `<span class="sl-var">${v}</span>`);
      })
      .join('\n');
  }

  return { parse, mdToSlm, jsonToSlm, yamlToSlm, slimToLlmText, sanitizeUserContent, estimateTokens, highlight };
});
