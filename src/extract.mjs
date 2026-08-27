/**
 * In-page extraction routines, injected via Runtime.evaluate.
 *
 * IMPORTANT — why these are iterative, not recursive:
 * a natural recursive DOM walk consumes one JS stack frame per nesting level,
 * which blows up on deeply nested real-world documents and on any engine with
 * a tighter recursion budget than desktop V8 (embedded engines, workers under
 * memory pressure). The converter below walks the DOM with an EXPLICIT STACK,
 * so JS call depth stays O(1) no matter how deeply the document nests, and it
 * caches one computed-style state per element while descending. That keeps the
 * visibility pass linear instead of re-walking every node's ancestor chain.
 *
 * These are serialized with Function.prototype.toString(), so each function
 * must be entirely self-contained: no imports, no closures over module scope.
 */

/** Choose the interesting root element of the document. */
export const rootPicker = function pickRoot(main) {
  if (!main) return document.body || document.documentElement;
  const SKIP = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, CANVAS: 1, IFRAME: 1,
    NAV: 1, FOOTER: 1, ASIDE: 1, FORM: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1,
    AUDIO: 1, VIDEO: 1, TEMPLATE: 1,
  };
  const states = new WeakMap();
  const stateOf = (element) => {
    const cached = states.get(element);
    if (cached) return cached;
    let style = null;
    try { if (typeof getComputedStyle === 'function') style = getComputedStyle(element); } catch { /* detached element */ }
    const aria = (element.getAttribute('aria-hidden') || '').trim().toLowerCase();
    const opacity = style ? parseFloat(style.opacity) : 1;
    const state = {
      hardHidden: element.hasAttribute('hidden') || element.hasAttribute('inert') || aria === 'true'
        || style?.display === 'none' || opacity === 0 || style?.contentVisibility === 'hidden',
      textVisible: !style || (style.visibility !== 'hidden' && style.visibility !== 'collapse'),
    };
    states.set(element, state);
    return state;
  };
  // Compute capped rendered-text counts for the whole document in one
  // postorder pass. Besides avoiding repeated candidate subtree walks, starting
  // at body means candidates below a pruned ancestor never receive a count.
  const counts = new WeakMap();
  const countRoot = document.body || document.documentElement;
  const stack = countRoot ? [{ node: countRoot, exit: false }] : [];
  while (stack.length > 0) {
    const frame = stack.pop();
    const node = frame.node;
    if (frame.exit) {
      let count = frame.direct;
      for (let i = 0; i < frame.children.length && count <= 200; i += 1) {
        count += counts.get(frame.children[i]) || 0;
      }
      counts.set(node, Math.min(201, count));
      continue;
    }
    if (SKIP[node.tagName] || stateOf(node).hardHidden) {
      counts.set(node, 0);
      continue;
    }

    const state = stateOf(node);
    const children = [];
    let direct = 0;
    if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
      const elements = node.children;
      for (let i = 0; i < elements.length; i += 1) {
        if (elements[i].tagName === 'SUMMARY') { children.push(elements[i]); break; }
      }
    } else {
      const nodes = node.childNodes;
      for (let i = 0; i < nodes.length; i += 1) {
        if (nodes[i].nodeType === 1) children.push(nodes[i]);
        else if (nodes[i].nodeType === 3 && state.textVisible && direct <= 200) {
          direct += (nodes[i].nodeValue || '').replace(/\s+/g, ' ').trim().length;
        }
      }
    }
    stack.push({ node, exit: true, direct: Math.min(201, direct), children });
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], exit: false });
    }
  }
  const candidates = ['main', 'article', '[role="main"]', '#content', '#main', '#mw-content-text'];
  for (let i = 0; i < candidates.length; i += 1) {
    const found = document.querySelectorAll(candidates[i]);
    for (let j = 0; j < found.length; j += 1) {
      if ((counts.get(found[j]) || 0) > 200) return found[j];
    }
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

  const TEXT_BREAK = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, DIV: 1, DL: 1, DT: 1, DD: 1,
    FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    HEADER: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, TABLE: 1,
    TBODY: 1, TD: 1, TFOOT: 1, TH: 1, THEAD: 1, TR: 1, UL: 1,
  };

  // Cache LOCAL state once per element. Hard-hidden state prunes a subtree;
  // visibility only controls that element's own text because a descendant may
  // legally override `visibility:hidden` with `visibility:visible`.
  const states = new WeakMap();
  const stateOf = (element) => {
    const cached = states.get(element);
    if (cached) return cached;
    let style = null;
    try { if (typeof getComputedStyle === 'function') style = getComputedStyle(element); } catch { /* detached element */ }
    const aria = (element.getAttribute('aria-hidden') || '').trim().toLowerCase();
    const opacity = style ? parseFloat(style.opacity) : 1;
    const state = {
      hardHidden: element.hasAttribute('hidden') || element.hasAttribute('inert') || aria === 'true'
        || style?.display === 'none' || opacity === 0 || style?.contentVisibility === 'hidden',
      textVisible: !style || (style.visibility !== 'hidden' && style.visibility !== 'collapse'),
    };
    states.set(element, state);
    return state;
  };

  // The converter is public, so its root is not guaranteed to come from
  // rootPicker(). This is the one ancestor walk; descendant state is carried
  // by pruning instead of re-walking the chain for every node.
  const blockedByAncestor = (element) => {
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      if (stateOf(current).hardHidden) return true;
    }
    return false;
  };

  const pushTextChildren = (stack, element, textVisible) => {
    // A closed details element renders only its first direct summary. Direct
    // text and every other child belong to the collapsed disclosure body.
    if (element.tagName === 'DETAILS' && !element.hasAttribute('open')) {
      const children = element.children;
      for (let i = 0; i < children.length; i += 1) {
        if (children[i].tagName === 'SUMMARY') {
          stack.push({ node: children[i], textVisible });
          break;
        }
      }
      return;
    }
    const children = element.childNodes;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], textVisible });
    }
  };

  const norm = (value) => (value || '').replace(/\s+/g, ' ');
  const visibleText = (element, preserveWhitespace) => {
    const parts = [];
    const stack = [{ node: element, textVisible: true }];
    const separator = preserveWhitespace ? '\n' : ' ';
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame.text !== undefined) { parts.push(frame.text); continue; }
      const node = frame.node;
      if (node.nodeType === 3) {
        if (frame.textVisible) parts.push(node.nodeValue || '');
        continue;
      }
      if (node.nodeType !== 1 || SKIP[node.tagName]) continue;
      const state = stateOf(node);
      if (state.hardHidden) continue;
      if (node.tagName === 'BR') {
        if (state.textVisible) parts.push(separator);
        continue;
      }
      const separated = node !== element && TEXT_BREAK[node.tagName];
      if (separated) {
        parts.push(separator);
        stack.push({ text: separator });
      }
      pushTextChildren(stack, node, state.textVisible);
    }
    const text = parts.join('');
    return preserveWhitespace ? text : norm(text).trim();
  };
  const flat = (element) => visibleText(element, false);
  if (blockedByAncestor(root.parentElement)) return '';
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
    const cellState = stateOf(cell);
    if (cellState.hardHidden) return '';
    const parts = [];
    const stack = [];
    pushTextChildren(stack, cell, cellState.textVisible);

    while (stack.length > 0) {
      const frame = stack.pop();
      const node = frame.node;
      if (!node) continue;
      if (node.nodeType === 3) {
        if (frame.textVisible) parts.push(norm(node.nodeValue));
        continue;
      }
      if (node.nodeType !== 1) continue;

      const tag = node.tagName;
      if (SKIP[tag]) continue;
      const state = stateOf(node);
      if (state.hardHidden) continue;

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
        if (alt && state.textVisible) parts.push('![' + alt + '](' + (node.src || '') + ')');
        continue;
      }
      if ((tag === 'BR' && state.textVisible) || tag === 'P' || tag === 'DIV' || tag === 'LI') {
        parts.push(' ');
      }

      pushTextChildren(stack, node, state.textVisible);
    }
    // A cell must stay on one line, and a raw pipe would break the table.
    return parts.join('').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  };

  /** Find this table's rendered rows in one pass, stopping at nested tables. */
  const scanTable = (table) => {
    const rows = [];
    const stack = [];
    const children = table.children;
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    let nested = false;
    while (stack.length > 0) {
      const node = stack.pop();
      const state = stateOf(node);
      if (state.hardHidden) continue;
      if (node.tagName === 'TABLE') { nested = true; continue; }
      if (node.tagName === 'TR') rows.push(node);
      const descendants = node.children;
      for (let i = descendants.length - 1; i >= 0; i -= 1) stack.push(descendants[i]);
    }
    return { rows, nested };
  };

  // Frames are either {node, depth, marker, textVisible} to visit, or {text} to emit.
  const stack = [{ node: root, depth: 0, textVisible: true }];

  const pushChildren = (node, depth, textVisible) => {
    if (node.tagName === 'DETAILS' && !node.hasAttribute('open')) {
      const children = node.children;
      for (let i = 0; i < children.length; i += 1) {
        if (children[i].tagName === 'SUMMARY') {
          stack.push({ node: children[i], depth, textVisible });
          break;
        }
      }
      return;
    }
    const kids = node.childNodes;
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ node: kids[i], depth, textVisible });
    }
  };

  while (stack.length > 0) {
    const frame = stack.pop();

    if (frame.text !== undefined) { out.push(frame.text); continue; }

    const node = frame.node;
    if (!node) continue;

    if (node.nodeType === 3) {
      if (frame.textVisible) out.push(norm(node.nodeValue));
      continue;
    }
    if (node.nodeType !== 1) continue;

    const tag = node.tagName;
    if (SKIP[tag]) continue;
    const state = stateOf(node);
    if (state.hardHidden) continue;

    // --- constructs read via innerText, never descended into ---
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') {
      const text = flat(node);
      if (text) out.push(`\n\n${'#'.repeat(Number(tag.charAt(1)))} ${text}\n\n`);
      continue;
    }
    if (tag === 'PRE') {
      const code = visibleText(node, true).replace(/\s+$/, '');
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
      if (alt && state.textVisible) out.push(`![${alt}](${node.src || ''})`);
      continue;
    }
    if (tag === 'BR') { if (state.textVisible) out.push('\n'); continue; }
    if (tag === 'HR') { if (state.textVisible) out.push('\n\n---\n\n'); continue; }

    if (tag === 'TABLE') {
      const scanned = scanTable(node);
      const rows = scanned.rows;
      // A LAYOUT table is not data. Sites built on nested tables (Hacker News,
      // most older dashboards) collapse into one enormous unreadable cell when
      // forced into pipe syntax, so descend into them like any other container
      // and let the real content render normally. A table is treated as data
      // only when it has more than one row and holds no table of its own.
      const isData = rows.length > 1 && !scanned.nested;
      if (!isData) {
        out.push('\n');
        pushChildren(node, frame.depth, state.textVisible);
        continue;
      }

      const limit = maxRows > 0 ? Math.min(rows.length, maxRows) : rows.length;
      const cellsOf = (tr) => {
        const kids = tr.children;
        const values = [];
        for (let i = 0; i < kids.length; i += 1) {
          // A non-rendered cell still occupies a semantic column. Keeping an
          // empty placeholder prevents later cells from shifting left.
          values.push(renderCell(kids[i]));
        }
        return values;
      };
      const matrix = [];
      for (let i = 0; i < limit; i += 1) matrix.push(cellsOf(rows[i]));
      const head = matrix[0];
      if (head.length === 0) continue;
      if (!matrix.some((values) => values.some((value) => value))) continue;
      const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
      for (let i = 1; i < matrix.length; i += 1) lines.push(`| ${matrix[i].join(' | ')} |`);
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
      for (let i = 0; i < kids.length; i += 1) {
        if (kids[i].tagName === 'LI' && !stateOf(kids[i]).hardHidden) items.push(kids[i]);
      }
      if (items.length === 0) continue;
      out.push('\n');
      stack.push({ text: '\n' });
      for (let i = items.length - 1; i >= 0; i -= 1) {
        stack.push({
          node: items[i],
          depth: frame.depth + 1,
          marker: ordered ? `${i + 1}. ` : '- ',
          textVisible: state.textVisible,
        });
      }
      continue;
    }

    if (tag === 'LI') {
      const indent = '  '.repeat(Math.max(0, frame.depth - 1));
      out.push(`\n${indent}${frame.marker || '- '}`);
      pushChildren(node, frame.depth, state.textVisible);
      continue;
    }

    if (tag === 'P') {
      out.push('\n\n');
      stack.push({ text: '\n\n' });
      pushChildren(node, frame.depth, state.textVisible);
      continue;
    }

    if (tag === 'BLOCKQUOTE') {
      // Marked inline rather than per-line; a full re-indent would need a second
      // pass over the output, which is not worth the tokens.
      out.push('\n\n> ');
      stack.push({ text: '\n\n' });
      pushChildren(node, frame.depth, state.textVisible);
      continue;
    }

    if (tag === 'DIV' || tag === 'SECTION' || tag === 'MAIN' || tag === 'ARTICLE'
      || tag === 'HEADER' || tag === 'DL' || tag === 'DD' || tag === 'DT'
      || tag === 'TBODY' || tag === 'THEAD' || tag === 'TR') {
      out.push('\n');
      pushChildren(node, frame.depth, state.textVisible);
      continue;
    }

    pushChildren(node, frame.depth, state.textVisible);
  }

  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
};
