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
 *
 * The tool list comes from ../src/tools.mjs, shared with the MCP server, so DSH
 * gets every tool and every option the moment MCP does. That module is
 * deliberately free of static `node:*` imports so it can be loaded here.
 */

import { TOOLS } from '../src/tools.mjs';

export const name = 'agent-browser';

/** Services injected into this plugin's fiber by the cordis loader. */
export const inject = ['shell', 'tools'];

/** A rendered page is routinely >100 kB of Markdown; do not let the cap eat it. */
const STDOUT_MAX_BYTES = 4_000_000;

/** Output value schema — no `required`, explicit `additionalProperties`. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, command: { type: 'string' } },
  additionalProperties: false,
};

/** Single-quote escape: URLs and JS expressions must never reach the shell raw. */
export function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {import('cordis').Context} ctx
 * @param {{cli?: string, timeoutMs?: number}} [config]
 */
export function apply(ctx, config = {}) {
  // Services arrive via the `inject` array above, not ctx.get(): the loader
  // only exposes declared services on the fiber context.
  const shell = ctx.shell;
  const tools = ctx.tools;
  // Optional service, read like dsh-tool-bash does — never declared in inject.
  const sandboxPolicy = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
  if (shell === undefined || tools === undefined) {
    console.error('[agent-browser] shell or tools service unavailable; no tools registered');
    return;
  }
  const cli = config.cli ?? process.env.AGENT_BROWSER_CLI ?? 'npx -y @truenix/agent-browser';
  const timeoutMs = config.timeoutMs ?? 180000;

  for (const spec of TOOLS) {
    ctx.effect(() => tools.register({
      name: spec.name,
      description: spec.description,
      // Tool `parameters` use the dialect where `required` IS allowed, which is
      // exactly the JSON Schema the shared catalogue already carries.
      parameters: spec.inputSchema,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const command = `${cli} ${spec.cli(args).map(quote).join(' ')}`;
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
        // The CLI reports rate limits and unrendered pages on stderr; on a
        // successful run that is the only place the agent would learn of them.
        const warnings = stderr.split('\n')
          .filter((line) => line.startsWith('agent-browser: warning: '))
          .map((line) => `\n\n[agent-browser warning] ${line.slice('agent-browser: warning: '.length)}`)
          .join('');
        return { text: (stdout || '(empty result)') + note + warnings, command };
      },
    }));
  }

  console.log(`[agent-browser] registered ${TOOLS.length} local browser tools via "${cli}"`);
}

// NOTE: no default export. The cordis loader's unwrapExports() prefers
// exports.default when present; a `{ name, apply }` default WITHOUT `inject`
// would shadow the module-level `inject` export and every ctx.<service> read
// would throw "cannot get property X without inject".
