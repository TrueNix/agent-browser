/**
 * The one tool catalogue every harness derives from.
 *
 * There used to be two hand-maintained lists — nine tools in the MCP server,
 * six in the DSH/Cordis plugin — so `browser_html`, `browser_accessibility_tree`
 * and `browser_pdf` simply did not exist for DSH users, and every new option
 * had to be added in two places or silently diverge. This module is the single
 * source of truth; the surfaces are thin adapters over it.
 *
 * Each entry carries BOTH ways of being driven, because harnesses come in two
 * shapes:
 *
 *   run(session, args)  in-process — the harness can hold a CDP session
 *                       (MCP server, the library, your own Node code)
 *   cli(args) -> argv   out-of-process — the harness can only run a command
 *                       (DSH/Cordis, shell tooling, anything sandboxed)
 *
 * A harness that speaks neither can still consume `toolCatalogue(format)`, which
 * emits the schemas in the shape OpenAI, Anthropic or MCP clients expect.
 *
 * ── CONSTRAINT ────────────────────────────────────────────────────────────────
 * This module must have NO STATIC `node:*` IMPORTS. A dynamic Cordis host half
 * runs in a restricted evaluator with no node builtins, and it imports this
 * file. The two `run` bodies that need `node:fs` reach for it with a DYNAMIC
 * import, which is never evaluated on a path that cannot support it.
 */

const url = { type: 'string', description: 'Absolute http/https URL to load.' };

/**
 * Offered on every tool that loads a page. Cheap to ignore, and the answer when
 * an agent gets back an empty-looking shell: the content renders after load.
 */
const waitUntil = {
  type: 'string',
  enum: ['domcontentloaded', 'load', 'idle'],
  description:
    'When to consider the page ready. "load" is the default. Use "idle" when content '
    + 'arrives after the load event (client-rendered apps) and the result looks empty.',
};

const evaluationWorld = {
  type: 'string',
  enum: ['isolated', 'main'],
  description:
    'JavaScript world to use. "isolated" is the default and avoids page-installed detector hooks. '
    + 'Use "main" only when the expression needs page-defined globals or patched prototypes.',
};

/** Nav flags shared by every out-of-process tool form. */
const navFlags = (args) => (args.waitUntil ? ['--wait', args.waitUntil] : []);

const linkStyle = {
  type: 'string',
  enum: ['inline', 'relative', 'text'],
  description:
    'How to render links. "inline" keeps [text](absolute-url) and is the default. '
    + '"relative" drops the site origin from same-site URLs. "text" drops URLs entirely — '
    + 'roughly half the output on a link-dense page, so prefer it when you only need to read.',
};

export const TOOLS = [
  {
    name: 'browser_markdown',
    description:
      'Read a WHOLE web page as Markdown, rendered in a real browser so JavaScript runs. The right '
      + 'default when you need to read, summarise or search the page. If you only need one specific '
      + 'fact — a count, a heading, the top N items, an embedded JSON blob — use browser_evaluate '
      + 'instead: it returns tens of bytes where this returns tens of kilobytes. Set links:"text" '
      + 'when you will not be navigating; URLs are 36-81% of the output on a link-dense page.',
    inputSchema: {
      type: 'object',
      properties: {
        url,
        wholePage: { type: 'boolean', description: 'Include the whole body instead of only the main/article element.' },
        links: linkStyle,
        maxRows: { type: 'number', description: 'Cap on table rows (default 60, 0 for no cap). Truncation is stated in the output.' },
        waitUntil,
      },
      required: ['url'],
    },
    run: (session, args) => session.markdown({
      main: args.wholePage !== true,
      links: args.links || 'inline',
      maxRows: args.maxRows,
    }),
    cli: (args) => {
      const argv = ['markdown', args.url, ...navFlags(args)];
      if (args.wholePage === true) argv.push('--raw');
      if (args.links) argv.push('--links', args.links);
      if (args.maxRows !== undefined) argv.push('--max-rows', String(args.maxRows));
      return argv;
    },
  },
  {
    name: 'browser_text',
    description: 'Render a URL in a local browser and return only its visible text. Use when page structure does not matter.',
    inputSchema: {
      type: 'object',
      properties: { url, mainOnly: { type: 'boolean', description: 'Restrict to the main/article element.' }, waitUntil },
      required: ['url'],
    },
    run: (session, args) => session.text({ main: args.mainOnly === true }),
    cli: (args) => ['text', args.url, ...navFlags(args), ...(args.mainOnly === true ? ['--main'] : [])],
  },
  {
    name: 'browser_html',
    description:
      'Render a URL and return the full serialized DOM after JavaScript has run. Token-heavy — '
      + 'prefer browser_markdown unless exact markup matters.',
    inputSchema: { type: 'object', properties: { url, waitUntil }, required: ['url'] },
    run: (session) => session.html(),
    cli: (args) => ['html', args.url, ...navFlags(args)],
  },
  {
    name: 'browser_links',
    description:
      'Render a URL and return every anchor as {text, href} JSON, plus the total found and whether '
      + 'the list was capped. Useful for crawling or locating a target page.',
    inputSchema: {
      type: 'object',
      properties: { url, limit: { type: 'number', description: 'Maximum links to return (default 500, 0 for no cap).' }, waitUntil },
      required: ['url'],
    },
    run: (session, args) => session.links({ limit: args.limit ?? 500 }),
    cli: (args) => {
      const argv = ['links', args.url, ...navFlags(args)];
      if (args.limit !== undefined) argv.push('--limit', String(args.limit));
      return argv;
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Render a URL and capture a PNG screenshot. Real browser rendering, so WebGL, video and canvas appear correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        url,
        fullPage: { type: 'boolean', description: 'Capture the entire scrollable document.' },
        out: { type: 'string', description: 'Output path, for harnesses that read the image from disk.' },
        waitUntil,
      },
      required: ['url'],
    },
    image: true,
    run: (session, args) => session.screenshot({ fullPage: args.fullPage === true }),
    cli: (args) => {
      const argv = ['screenshot', args.url, ...navFlags(args), '-o', args.out || 'browser-screenshot.png'];
      if (args.fullPage === true) argv.push('--full');
      return argv;
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Render a URL, evaluate a JavaScript expression in the page, and return ONLY that value. The '
      + 'cheapest way to answer a specific question about a page — prefer it over browser_markdown '
      + 'whenever the answer is small. Measured: three targeted questions across three heavy pages '
      + 'cost 235 bytes this way versus 77 kB of rendered Markdown. Good for querySelector, counts, '
      + 'the first N items, text near a keyword, and embedded JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        url,
        expression: { type: 'string', description: 'JS expression evaluated in page context; its value is returned.' },
        world: evaluationWorld,
        waitUntil,
      },
      required: ['url', 'expression'],
    },
    run: (session, args) => session.evaluate(args.expression, { world: args.world || 'isolated' }),
    cli: (args) => [
      'eval', args.url, ...navFlags(args),
      ...(args.world ? ['--world', args.world] : []),
      args.expression,
    ],
  },
  {
    name: 'browser_accessibility_tree',
    description:
      'Render a URL and return a filtered accessibility tree (role/name/value) — a compact structural '
      + 'view of the page for reasoning about UI. Bounded, and reports the total so a capped result '
      + 'is never mistaken for a complete one.',
    inputSchema: {
      type: 'object',
      properties: { url, limit: { type: 'number', description: 'Maximum nodes to return (default 1500, 0 for no cap).' }, waitUntil },
      required: ['url'],
    },
    run: (session, args) => session.accessibilityTree({ limit: args.limit ?? 1500 }),
    cli: (args) => {
      const argv = ['a11y', args.url, ...navFlags(args)];
      if (args.limit !== undefined) argv.push('--limit', String(args.limit));
      return argv;
    },
  },
  {
    name: 'browser_pdf',
    description: 'Render a URL to PDF and return the byte length plus the saved path.',
    inputSchema: {
      type: 'object',
      properties: { url, out: { type: 'string', description: 'Output path (default page.pdf).' } },
      required: ['url'],
    },
    run: async (session, args) => {
      // Dynamic, so this module stays importable where node builtins do not exist.
      const { writeFileSync } = await import('node:fs');
      const bytes = await session.pdf();
      const file = args.out || 'page.pdf';
      writeFileSync(file, bytes);
      return { path: file, bytes: bytes.length };
    },
    cli: (args) => ['pdf', args.url, '-o', args.out || 'page.pdf'],
  },
  {
    name: 'browser_probe',
    description: 'Report the local browser binary, version, GPU availability and live capability flags.',
    inputSchema: { type: 'object', properties: {} },
    noNavigate: true,
    run: async (session) => {
      const { findBrowser, hasGpu, browserVersion } = await import('./browser.mjs');
      const binary = findBrowser();
      await session.navigate('https://example.com');
      const capabilities = JSON.parse(await session.evaluate(
        `JSON.stringify({webgl:!!document.createElement('canvas').getContext('webgl'),`
        + `serviceWorker:'serviceWorker' in navigator,`
        + `video:typeof document.createElement('video').canPlayType,`
        + `webdriver:navigator.webdriver,headlessInUA:/Headless/i.test(navigator.userAgent)})`,
      ));
      return { binary, version: binary ? browserVersion(binary) : null, gpuAvailable: hasGpu(), capabilities };
    },
    cli: () => ['probe'],
  },
];

/** Look one up by name. */
export function findTool(name) {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * The catalogue in whatever shape a harness expects.
 *
 * Anything that can read JSON Schema can be wired up from this without the
 * project needing to know the framework exists.
 *
 * @param {'mcp'|'openai'|'anthropic'} [format]
 */
export function toolCatalogue(format = 'mcp') {
  return TOOLS.map(({ name, description, inputSchema }) => {
    if (format === 'openai') {
      return { type: 'function', function: { name, description, parameters: inputSchema } };
    }
    if (format === 'anthropic') {
      return { name, description, input_schema: inputSchema };
    }
    return { name, description, inputSchema };
  });
}
