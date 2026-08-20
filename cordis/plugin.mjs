/**
 * DSH / Cordis plugin — registers hardened local browser tools on the host.
 *
 * WHY THIS SHELLS OUT INSTEAD OF USING THE CLIENT DIRECTLY
 * -------------------------------------------------------
 * A dynamic Cordis host half runs in a restricted evaluator whose only globals
 * are `ctx`, `harness`, `console`, `btoa`/`atob` and `TextEncoder`/`TextDecoder`.
 * There is no `WebSocket`, no `fetch`, no `Buffer` and no `node:*` import, so a
 * CDP connection cannot be opened inside the sandbox at all.
 *
 * The host DOES expose a `shell` service, so this plugin runs the package CLI as
 * a subprocess. Every side effect stays owned by the plugin fiber (tool
 * registrations are disposed on stop/update) while the browser work happens in
 * an ordinary Node process.
 *
 * Contracts encoded here, each learned from a failed activation:
 *   1. the output VALUE schema rejects `required` and demands an explicit
 *      `additionalProperties` (tool `parameters` use a different dialect where
 *      `required` IS allowed)
 *   2. shell results carry stdout/stderr as CollectedOutput
 *      `{ text, truncated, spillPath }` — not strings
 *   3. foreground stdout is capped; a rendered page needs a larger explicit budget
 *   4. `shell.resolve()` defaults the sandbox policy to something restrictive
 *      that can hide `/dev/dri`; without the session's real policy the browser
 *      falls back to software rendering
 */

export const name = 'agent-browser';

/** A rendered page is routinely >100 kB of Markdown; do not let the cap eat it. */
const STDOUT_MAX_BYTES = 4_000_000;

/** Output value schema — no `required`, explicit `additionalProperties`. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, command: { type: 'string' } },
  additionalProperties: false,
};

export const TOOL_SPECS = [
  {
    name: 'browser_markdown',
    description:
      'Render a URL in a real local browser and return it as Markdown. Runs on this machine — no remote service, '
      + 'no quota — with full WebGL/video/ServiceWorker support, and is not trivially flagged as automation. '
      + 'Best default for reading a web page: roughly 8x fewer tokens than raw HTML.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http/https URL to load.' },
        wholePage: { type: 'boolean', description: 'Include the whole body instead of only the main/article element.' },
      },
      required: ['url'],
    },
    build: (args) => (args.wholePage === true ? ['markdown', args.url, '--raw'] : ['markdown', args.url]),
  },
  {
    name: 'browser_text',
    description: 'Render a URL in a local browser and return only its visible text. Use when page structure does not matter.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http/https URL to load.' },
        mainOnly: { type: 'boolean', description: 'Restrict extraction to the main/article element.' },
      },
      required: ['url'],
    },
    build: (args) => (args.mainOnly === true ? ['text', args.url, '--main'] : ['text', args.url]),
  },
  {
    name: 'browser_links',
    description: 'Render a URL and return every anchor as {text, href} JSON. Useful for crawling or locating a target page.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http/https URL to load.' } },
      required: ['url'],
    },
    build: (args) => ['links', args.url],
  },
  {
    name: 'browser_evaluate',
    description: 'Render a URL then evaluate a JavaScript expression in the page and return its value. Use for precise extraction (querySelector, counts, embedded JSON).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http/https URL to load.' },
        expression: { type: 'string', description: 'JavaScript expression evaluated in page context; its value is returned.' },
      },
      required: ['url', 'expression'],
    },
    build: (args) => ['eval', args.url, args.expression],
  },
  {
    name: 'browser_screenshot',
    description: 'Render a URL and save a PNG screenshot, returning the path. View it afterwards with the image-reading tool.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http/https URL to load.' },
        out: { type: 'string', description: 'Output PNG path (default browser-screenshot.png).' },
        fullPage: { type: 'boolean', description: 'Capture the entire scrollable document.' },
      },
      required: ['url'],
    },
    build: (args) => {
      const argv = ['screenshot', args.url, '-o', args.out || 'browser-screenshot.png'];
      if (args.fullPage === true) argv.push('--full');
      return argv;
    },
  },
  {
    name: 'browser_probe',
    description: 'Report the local browser binary, version, GPU availability and live capability flags.',
    parameters: { type: 'object', properties: {} },
    build: () => ['probe'],
  },
];

/** Single-quote escape: URLs and JS expressions must never reach the shell raw. */
export function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import('cordis').Context} ctx
 * @param {{cli?: string, timeoutMs?: number}} [config]
 */
export function apply(ctx, config = {}) {
  const shell = ctx.get('shell');
  const tools = ctx.get('tools');
  if (shell === undefined || tools === undefined) {
    console.error('[agent-browser] shell or tools service unavailable; no tools registered');
    return;
  }
  const sandboxPolicy = ctx.get('sandboxPolicy');
  const cli = config.cli ?? process.env.AGENT_BROWSER_CLI ?? 'npx -y @truenix/agent-browser';
  const timeoutMs = config.timeoutMs ?? 180000;

  for (const spec of TOOL_SPECS) {
    ctx.effect(() => tools.register({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const command = `${cli} ${spec.build(args).map(quote).join(' ')}`;
        const request = { command, timeoutMs, stdoutMaxBytes: STDOUT_MAX_BYTES, signal: exec?.signal };
        // Resolve the session's real policy rather than accepting the
        // executor's restrictive default, which can hide GPU render nodes.
        if (sandboxPolicy !== undefined) {
          try { request.sandboxPolicy = sandboxPolicy.resolve(); } catch { /* fall back */ }
        }
        const result = await shell.run(shell.resolve(request));
        const stdout = (result.stdout?.text ?? '').trim();
        const stderr = (result.stderr?.text ?? '').trim();
        if (result.exitCode !== 0) {
          throw new Error(`${spec.name} failed (exit ${result.exitCode}): ${stderr || stdout || 'no output'}`);
        }
        const note = result.stdout?.truncated
          ? `\n\n[truncated by the shell output cap${result.stdout.spillPath ? `; complete output at ${result.stdout.spillPath}` : ''}]`
          : '';
        return { text: (stdout || '(empty result)') + note, command };
      },
    }));
  }

  console.log(`[agent-browser] registered ${TOOL_SPECS.length} local browser tools via "${cli}"`);
}

export default { name, apply };
