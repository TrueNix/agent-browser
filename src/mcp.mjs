/**
 * MCP server exposing a hardened local browser as agent tools.
 *
 * Speaks JSON-RPC 2.0 over newline-delimited stdio, which is what MCP stdio
 * transports use. Implemented directly rather than via the MCP SDK to keep the
 * package dependency-free — the wire format is small and stable.
 *
 * Each tool call gets its own isolated browser context, so tasks never share
 * cookies, storage or cache.
 *
 * The tool list itself lives in ./tools.mjs, shared with every other surface,
 * so MCP and DSH can never drift apart again.
 */
import { readFileSync } from 'node:fs';
import { withBrowser, withSession } from './client.mjs';
import { findTool, toolCatalogue } from './tools.mjs';

const PROTOCOL_VERSION = '2024-11-05';
// Read the real version rather than repeating it here, where it silently sat at
// 1.0.0 across two releases. package.json always ships in the tarball.
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

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
      reply(id, { tools: toolCatalogue('mcp') });
      return;
    }

    if (method === 'tools/call') {
      const tool = findTool(params?.name);
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
