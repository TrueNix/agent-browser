/**
 * MCP server exposing a hardened local browser as agent tools.
 *
 * Speaks JSON-RPC 2.0 over newline-delimited stdio, which is what MCP stdio
 * transports use. Implemented directly rather than via the MCP SDK to keep the
 * package dependency-free — the wire format is small and stable.
 *
 * Each tool call gets its own isolated browser context, so tasks never share
 * cookies, storage or cache.
 */
import { readFileSync } from 'node:fs';
import { withBrowser, withSession } from './client.mjs';

const PROTOCOL_VERSION = '2024-11-05';
// Read the real version rather than repeating it here, where it silently sat at
// 1.0.0 across two releases. package.json always ships in the tarball.
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return '0.0.0'; }
})();
const urlProperty = { type: 'string', description: 'Absolute http/https URL to load.' };

const TOOLS = [
  {
    name: 'browser_markdown',
    description:
      'Render a URL in a real local browser and return it as Markdown. Best default for reading a web page: '
      + 'roughly 8x fewer tokens than raw HTML while keeping headings, links, lists, code and tables.',
    inputSchema: {
      type: 'object',
      properties: {
        url: urlProperty,
        wholePage: { type: 'boolean', description: 'Include the whole body instead of only the main/article element.' },
      },
      required: ['url'],
    },
    run: (session, args) => session.markdown({ main: args.wholePage !== true }),
  },
  {
    name: 'browser_text',
    description: 'Render a URL and return only its visible text. Use when page structure does not matter.',
    inputSchema: {
      type: 'object',
      properties: { url: urlProperty, mainOnly: { type: 'boolean', description: 'Restrict to the main/article element.' } },
      required: ['url'],
    },
    run: (session, args) => session.text({ main: args.mainOnly === true }),
  },
  {
    name: 'browser_html',
    description: 'Render a URL and return the full serialized DOM after JavaScript has run. Token-heavy — prefer browser_markdown unless exact markup matters.',
    inputSchema: { type: 'object', properties: { url: urlProperty }, required: ['url'] },
    run: (session) => session.html(),
  },
  {
    name: 'browser_links',
    description: 'Render a URL and return every anchor as {text, href} JSON. Useful for crawling or locating a target page.',
    inputSchema: { type: 'object', properties: { url: urlProperty }, required: ['url'] },
    run: (session) => session.links(),
  },
  {
    name: 'browser_screenshot',
    description: 'Render a URL and return a PNG screenshot as an image. Real browser rendering, so WebGL, video and canvas appear correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        url: urlProperty,
        fullPage: { type: 'boolean', description: 'Capture the entire scrollable document.' },
        width: { type: 'number', description: 'Window width in px (default 1920).' },
        height: { type: 'number', description: 'Window height in px (default 1080).' },
      },
      required: ['url'],
    },
    image: true,
    run: (session, args) => session.screenshot({ fullPage: args.fullPage === true }),
  },
  {
    name: 'browser_evaluate',
    description: 'Render a URL then evaluate a JavaScript expression in the page and return its value. Use for precise extraction (querySelector, counts, embedded JSON).',
    inputSchema: {
      type: 'object',
      properties: {
        url: urlProperty,
        expression: { type: 'string', description: 'JS expression evaluated in page context; its value is returned.' },
      },
      required: ['url', 'expression'],
    },
    run: (session, args) => session.evaluate(args.expression),
  },
  {
    name: 'browser_accessibility_tree',
    description: 'Render a URL and return a filtered accessibility tree (role/name/value) — a compact structural view of the page for reasoning about UI.',
    inputSchema: { type: 'object', properties: { url: urlProperty }, required: ['url'] },
    run: (session) => session.accessibilityTree(),
  },
  {
    name: 'browser_pdf',
    description: 'Render a URL to PDF and return the byte length plus the saved path.',
    inputSchema: {
      type: 'object',
      properties: { url: urlProperty, out: { type: 'string', description: 'Output path (default page.pdf).' } },
      required: ['url'],
    },
    run: async (session, args) => {
      const { writeFileSync } = await import('node:fs');
      const bytes = await session.pdf();
      const file = args.out || 'page.pdf';
      writeFileSync(file, bytes);
      return { path: file, bytes: bytes.length };
    },
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
  },
];

/** Attach to a running browser when configured, otherwise launch a hardened one. */
function runSession(body) {
  const endpoint = process.env.AGENT_BROWSER_ENDPOINT;
  if (endpoint) return withSession({ endpoint, stealth: true }, body);
  return withBrowser({ headless: true, gpu: 'auto', stealth: true }, body);
}

export async function startMcpServer() {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const handle = async (message) => {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    if (method === 'initialize') {
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-browser', version: VERSION },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') { if (!isNotification) reply(id, {}); return; }

    if (method === 'tools/list') {
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    }

    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) { fail(id, -32602, `unknown tool: ${params?.name}`); return; }
      const args = params.arguments ?? {};
      try {
        const value = await runSession(async (session) => {
          if (!tool.noNavigate) {
            if (!args.url) throw new Error(`${tool.name} requires "url"`);
            // No device-metrics override: the launch geometry is already
            // consistent, and 1280x720 is a known automation fingerprint.
            await session.navigate(args.url);
          }
          return tool.run(session, args);
        });

        if (tool.image) {
          reply(id, { content: [{ type: 'image', data: value.toString('base64'), mimeType: 'image/png' }] });
          return;
        }
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        reply(id, { content: [{ type: 'text', text: text || '(empty result)' }] });
      } catch (err) {
        // MCP convention: tool failures come back as isError content, not a
        // protocol error, so the agent can read and react to the message.
        reply(id, { content: [{ type: 'text', text: `browser error: ${err.message}` }], isError: true });
      }
      return;
    }

    if (!isNotification) fail(id, -32601, `method not found: ${method}`);
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      handle(message).catch((err) => {
        if (message.id !== undefined && message.id !== null) fail(message.id, -32603, err.message);
      });
    }
  });

  process.stderr.write('agent-browser MCP server ready on stdio\n');
  await new Promise((resolve) => process.stdin.on('end', resolve));
}
