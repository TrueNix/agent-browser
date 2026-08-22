/**
 * In-page extraction routines, injected via Runtime.evaluate.
 *
 * IMPORTANT — why these are iterative, not recursive:
 * a natural recursive DOM walk consumes one JS stack frame per nesting level,
 * which blows up on deeply nested real-world documents and on any engine with
 * a tighter recursion budget than desktop V8 (embedded engines, workers under
 * memory pressure). The converter below walks the DOM with an EXPLICIT STACK,
 * so JS call depth stays O(1) no matter how deeply the document nests, and it
 * uses native `innerText` for leaf-ish inline constructs instead of descending
 * into them. That also makes it markedly faster on large pages.
 *
 * These are serialized with Function.prototype.toString(), so each function
 * must be entirely self-contained: no imports, no closures over module scope.
 */

/** Choose the interesting root element of the document. */
export const rootPicker = function pickRoot(main) {
  if (!main) return document.body || document.documentElement;
  const candidates = ['main', 'article', '[role="main"]', '#content', '#main', '#mw-content-text'];
  for (let i = 0; i < candidates.length; i += 1) {
    const found = document.querySelector(candidates[i]);
    if (found && (found.innerText || '').trim().length > 200) return found;
  }
  return document.body || document.documentElement;
};

/**
 * Compact, recursion-free HTML -> Markdown converter.
 *
 * @param {Element} root
 * @param {{links?: 'inline'|'relative'|'text', maxRows?: number}} [options]
 *   links    'inline'   [text](https://absolute)      — default, navigable
 *            'relative' [text](/same-origin/path)     — drops the origin prefix
 *            'text'     text                          — drops URLs entirely
 *   maxRows  cap on data-table rows; 0 means no cap. Truncation is announced.
 */
export const htmlToMarkdown = function convert(root, options) {
  if (!root) return '';
  const opts = options || {};
  const linkStyle = opts.links || 'inline';
  const maxRows = opts.maxRows === undefined ? 60 : opts.maxRows;
  const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
    ? location.origin
    : '';

  const SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, CANVAS: 1, IFRAME: 1,
    NAV: 1, FOOTER: 1, ASIDE: 1, FORM: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1,
    AUDIO: 1, VIDEO: 1, TEMPLATE: 1,
  };

  const norm = (value) => (value || '').replace(/\s+/g, ' ');
  const flat = (el) => norm(el.innerText || el.textContent || '').trim();
  const out = [];

  /** Render one anchor under the active link style. Shared by both walkers. */
  const renderLink = (node, text) => {
    if (!text) return '';
    if (linkStyle === 'text') return text;
    const href = node.getAttribute('href') || '';
    // An in-page or javascript: target is not somewhere an agent can navigate,
    // so the URL is pure cost.
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return text;
    let target = node.href || href;
    if (linkStyle === 'relative' && origin && target.indexOf(origin) === 0) {
      target = target.slice(origin.length) || '/';
    }
    return '[' + text + '](' + target + ')';
  };

  /**
   * Render a table cell's INLINE markup, iteratively.
   *
   * This used to be `innerText`, which silently dropped every link, code span
   * and emphasis inside the cell. On a table-based layout that is the entire
   * page: Hacker News has 229 anchors and none of them survived.
   */
  const renderCell = (cell) => {
    const parts = [];
    const stack = [];
    const kids = cell.childNodes;
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.nodeType === 3) { parts.push(norm(node.nodeValue)); continue; }
      if (node.nodeType !== 1) continue;

      const tag = node.tagName;
      if (SKIP[tag]) continue;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') continue;

      if (tag === 'A') { parts.push(renderLink(node, flat(node))); continue; }
      if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
        const text = flat(node);
        if (text) parts.push('`' + text + '`');
        continue;
      }
      if (tag === 'STRONG' || tag === 'B') {
        const text = flat(node);
        if (text) parts.push('**' + text + '**');
        continue;
      }
      if (tag === 'EM' || tag === 'I') {
        const text = flat(node);
        if (text) parts.push('*' + text + '*');
        continue;
      }
      if (tag === 'IMG') {
        const alt = node.getAttribute('alt');
        if (alt) parts.push('![' + alt + '](' + (node.src || '') + ')');
        continue;
      }
      if (tag === 'BR' || tag === 'P' || tag === 'DIV' || tag === 'LI') { parts.push(' '); }

      const grand = node.childNodes;
      for (let i = grand.length - 1; i >= 0; i -= 1) stack.push(grand[i]);
    }
    // A cell must stay on one line, and a raw pipe would break the table.
    return parts.join('').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  };

  /** Rows belonging to THIS table, not to a table nested inside one of its cells. */
  const ownRows = (table) => {
    const found = [];
    const all = table.querySelectorAll('tr');
    for (let i = 0; i < all.length; i += 1) {
      let owner = all[i].parentNode;
      while (owner && owner !== table && owner.tagName !== 'TABLE') owner = owner.parentNode;
      if (owner === table) found.push(all[i]);
    }
    return found;
  };

  // Frames are either {node, depth, marker} to visit, or {text} to emit.
  const stack = [{ node: root, depth: 0 }];

  const pushChildren = (node, depth) => {
    const kids = node.childNodes;
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ node: kids[i], depth });
  };

  while (stack.length > 0) {
    const frame = stack.pop();

    if (frame.text !== undefined) { out.push(frame.text); continue; }

    const node = frame.node;
    if (!node) continue;

    if (node.nodeType === 3) { out.push(norm(node.nodeValue)); continue; }
    if (node.nodeType !== 1) continue;

    const tag = node.tagName;
    if (SKIP[tag]) continue;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') continue;

    // --- constructs read via innerText, never descended into ---
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
      const text = flat(node);
      if (text) out.push(`\n\n${'#'.repeat(Number(tag.charAt(1)))} ${text}\n\n`);
      continue;
    }
    if (tag === 'PRE') {
      const code = (node.innerText || '').replace(/\s+$/, '');
      if (code) out.push(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
      continue;
    }
    if (tag === 'A') {
      const rendered = renderLink(node, flat(node));
      if (rendered) out.push(rendered);
      continue;
    }
    if (tag === 'STRONG' || tag === 'B') {
      const text = flat(node);
      if (text) out.push(`**${text}**`);
      continue;
    }
    if (tag === 'EM' || tag === 'I') {
      const text = flat(node);
      if (text) out.push(`*${text}*`);
      continue;
    }
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
      const text = flat(node);
      if (text) out.push(`\`${text}\``);
      continue;
    }
    if (tag === 'IMG') {
      const alt = node.getAttribute('alt');
      if (alt) out.push(`![${alt}](${node.src || ''})`);
      continue;
    }
    if (tag === 'BR') { out.push('\n'); continue; }
    if (tag === 'HR') { out.push('\n\n---\n\n'); continue; }

    if (tag === 'TABLE') {
      const rows = ownRows(node);
      // A LAYOUT table is not data. Sites built on nested tables (Hacker News,
      // most older dashboards) collapse into one enormous unreadable cell when
      // forced into pipe syntax, so descend into them like any other container
      // and let the real content render normally. A table is treated as data
      // only when it has more than one row and holds no table of its own.
      const isData = rows.length > 1 && node.querySelector('table') === null;
      if (!isData) {
        out.push('\n');
        pushChildren(node, frame.depth);
        continue;
      }

      const limit = maxRows > 0 ? Math.min(rows.length, maxRows) : rows.length;
      const cellsOf = (tr) => {
        const kids = tr.children;
        const values = [];
        for (let i = 0; i < kids.length; i += 1) values.push(renderCell(kids[i]));
        return values;
      };
      const head = cellsOf(rows[0]);
      if (head.length === 0) continue;
      const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
      for (let i = 1; i < limit; i += 1) lines.push(`| ${cellsOf(rows[i]).join(' | ')} |`);
      // Never truncate silently. An agent cannot tell clipped data from complete
      // data, and a confident conclusion drawn from half a table is the exact
      // failure this whole project exists to prevent.
      if (limit < rows.length) {
        lines.push('', `_[table truncated: ${limit - 1} of ${rows.length - 1} rows shown]_`);
      }
      out.push(`\n\n${lines.join('\n')}\n\n`);
      continue;
    }

    // --- containers we descend into, using the explicit stack ---
    if (tag === 'UL' || tag === 'OL') {
      const ordered = tag === 'OL';
      const kids = node.children;
      const items = [];
      for (let i = 0; i < kids.length; i += 1) if (kids[i].tagName === 'LI') items.push(kids[i]);
      if (items.length === 0) continue;
      out.push('\n');
      stack.push({ text: '\n' });
      for (let i = items.length - 1; i >= 0; i -= 1) {
        stack.push({ node: items[i], depth: frame.depth + 1, marker: ordered ? `${i + 1}. ` : '- ' });
      }
      continue;
    }

    if (tag === 'LI') {
      const indent = '  '.repeat(Math.max(0, frame.depth - 1));
      out.push(`\n${indent}${frame.marker || '- '}`);
      pushChildren(node, frame.depth);
      continue;
    }

    if (tag === 'P') {
      out.push('\n\n');
      stack.push({ text: '\n\n' });
      pushChildren(node, frame.depth);
      continue;
    }

    if (tag === 'BLOCKQUOTE') {
      // Marked inline rather than per-line; a full re-indent would need a second
      // pass over the output, which is not worth the tokens.
      out.push('\n\n> ');
      stack.push({ text: '\n\n' });
      pushChildren(node, frame.depth);
      continue;
    }

    if (tag === 'DIV' || tag === 'SECTION' || tag === 'MAIN' || tag === 'ARTICLE'
      || tag === 'HEADER' || tag === 'DL' || tag === 'DD' || tag === 'DT'
      || tag === 'TBODY' || tag === 'THEAD' || tag === 'TR') {
      out.push('\n');
      pushChildren(node, frame.depth);
      continue;
    }

    pushChildren(node, frame.depth);
  }

  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
};
