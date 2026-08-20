#!/usr/bin/env node
/**
 * Smoke tests against a real local browser.
 *
 * Set AGENT_BROWSER_SKIP_NETWORK=1 to run only the checks that need no browser.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withBrowser, BrowserSession, buildWebglPatch } from '../src/client.mjs';
import { findBrowser, deriveIdentity, hasGpu } from '../src/browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'src', 'cli.mjs');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name} (${Date.now() - started}ms)\n       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- offline

console.log('\nidentity and discovery (offline)');

await test('finds a browser binary', () => {
  assert(findBrowser() !== null, 'no Chrome/Chromium found; set AGENT_BROWSER_BIN');
});

await test('derives a clean UA from a --version line', () => {
  const id = deriveIdentity('Google Chrome 151.0.7922.169');
  assert(!/Headless/i.test(id.userAgent), 'UA must not contain Headless');
  assert(id.userAgent.includes('Chrome/151.0.0.0'), `expected reduced UA, got ${id.userAgent}`);
  assert(id.metadata.brands.some((b) => b.brand === 'Google Chrome' && b.version === '151'),
    'Client Hints brands must match the binary version');
});

await test('strips Headless from a real UA string', () => {
  const id = deriveIdentity('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/151.0.0.0 Safari/537.36');
  assert(!/Headless/i.test(id.userAgent), `still headless: ${id.userAgent}`);
});

await test('open() refuses to run without an endpoint', async () => {
  let threw = false;
  try { await BrowserSession.open({}); } catch { threw = true; }
  assert(threw, 'open() must require an endpoint');
});

await test('the WebGL patch keeps a native-looking toString', () => {
  const src = buildWebglPatch('V', 'R');
  assert(src.includes('new Proxy'), 'must wrap the native function in a Proxy');
  assert(src.includes('37445') && src.includes('37446'), 'must handle both UNMASKED_* parameters');
});

if (process.env.AGENT_BROWSER_SKIP_NETWORK === '1') {
  console.log('\nskipping browser tests (AGENT_BROWSER_SKIP_NETWORK=1)');
  report();
}

// ---------------------------------------------------------------- live

console.log('\nlive browser');

await test('launches, navigates and reports status', async () => {
  await withBrowser({}, async (session) => {
    const state = await session.navigate('https://example.com');
    assert(state.title === 'Example Domain', `unexpected title: ${state.title}`);
    assert(state.status === 200, `expected 200, got ${state.status}`);
  });
});

await test('does not announce itself as automation', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    const v = JSON.parse(await session.evaluate(
      'JSON.stringify({wd:navigator.webdriver,headless:/Headless/i.test(navigator.userAgent),'
      + 'screen:screen.width+"x"+screen.height,outer:outerWidth+"x"+outerHeight})',
    ));
    assert(v.wd === false, `navigator.webdriver must be false, got ${v.wd}`);
    assert(v.headless === false, 'UA must not contain Headless');
    assert(v.screen === v.outer, `window/screen must agree, got ${v.outer} vs ${v.screen}`);
  });
});

await test('page and worker agree (no inconsistency tell)', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    const diff = await session.evaluate(`(async () => {
      const src = 'self.onmessage=()=>postMessage({ua:navigator.userAgent,langs:JSON.stringify(navigator.languages)})';
      const w = new Worker(URL.createObjectURL(new Blob([src], {type:'application/javascript'})));
      const got = await new Promise(r => { w.onmessage = e => r(e.data); w.postMessage(1); setTimeout(() => r(null), 5000); });
      if (!got) return 'worker timeout';
      const out = [];
      if (got.ua !== navigator.userAgent) out.push('userAgent');
      if (got.langs !== JSON.stringify(navigator.languages)) out.push('languages');
      return out.join(',');
    })()`);
    assert(diff === '', `page/worker mismatch on: ${diff}`);
  });
});

await test('runs full JavaScript (WebGL, ServiceWorker, video)', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    const v = JSON.parse(await session.evaluate(
      'JSON.stringify({webgl:!!document.createElement("canvas").getContext("webgl"),'
      + 'sw:"serviceWorker" in navigator,video:typeof document.createElement("video").canPlayType})',
    ));
    assert(v.webgl === true, 'WebGL must be available');
    assert(v.sw === true, 'ServiceWorker must be available');
    assert(v.video === 'function', 'video playback API must be available');
  });
});

await test('markdown conversion handles a large document', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://en.wikipedia.org/wiki/WebAssembly', { timeoutMs: 60000 });
    const md = await session.markdown({ main: true });
    assert(md.length > 5000, `markdown too short (${md.length})`);
    assert(md.includes('WebAssembly'), 'expected the subject in the output');
    assert(md.includes(']('), 'expected at least one markdown link');
    const html = await session.html();
    assert(html.length > md.length * 2, 'markdown should be far smaller than html');
  });
});

await test('captures a real PNG screenshot', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    const png = await session.screenshot();
    assert(png.length > 1000, `screenshot too small: ${png.length}`);
    assert(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'not a PNG');
  });
});

await test('extracts links and an accessibility tree', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    const links = await session.links();
    assert(links.length > 0 && links[0].href.startsWith('http'), 'expected an absolute link');
    const tree = await session.accessibilityTree();
    assert(tree.some((n) => n.role === 'heading'), 'expected a heading node');
  });
});

await test('isolated contexts do not share storage', async () => {
  const write = await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    return session.evaluate('localStorage.setItem("probe","1"), localStorage.getItem("probe")');
  });
  assert(write === '1', 'first context should write its own value');
  const read = await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    return session.evaluate('localStorage.getItem("probe")');
  });
  assert(read === null, `storage leaked across contexts: ${read}`);
});

await test('reports an unreachable host instead of an empty page', async () => {
  let threw = false;
  try {
    await withBrowser({}, async (session) => {
      await session.navigate('https://this-domain-really-should-not-exist-91723.example', { timeoutMs: 25000 });
    });
  } catch { threw = true; }
  assert(threw, 'a failed navigation must reject');
});

await test('real GPU produces a hardware renderer string', async () => {
  if (!hasGpu()) { console.log('       (no /dev/dri on this machine — skipped)'); return; }
  await withBrowser({ gpu: true }, async (session) => {
    await session.navigate('https://example.com');
    const r = await session.evaluate(
      '(()=>{const c=document.createElement("canvas").getContext("webgl");'
      + 'const d=c.getExtension("WEBGL_debug_renderer_info");'
      + 'return c.getParameter(d.UNMASKED_RENDERER_WEBGL)})()',
    );
    assert(!/SwiftShader/i.test(r), `expected hardware rendering, got ${r}`);
  });
});

// ---------------------------------------------------------------- cli + mcp

console.log('\nCLI and MCP');

await test('CLI does not truncate large output through a pipe', async () => {
  const { stdout } = await run(process.execPath, [CLI, 'markdown', 'https://en.wikipedia.org/wiki/WebAssembly']);
  assert(stdout.length > 70000, `expected >70000 bytes, got ${stdout.length} (pipe truncation regression)`);
});

await test('MCP handshake and tool list', async () => {
  const got = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ], 2);
  assert(got.find((m) => m.id === 1)?.result?.serverInfo?.name === 'agent-browser', 'bad serverInfo');
  const tools = got.find((m) => m.id === 2)?.result?.tools ?? [];
  assert(tools.length >= 8, `expected >=8 tools, got ${tools.length}`);
  assert(tools.every((t) => t.name && t.description && t.inputSchema), 'every tool needs name/description/inputSchema');
});

await test('MCP renders a page', async () => {
  const got = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_markdown', arguments: { url: 'https://example.com' } } },
  ], 2);
  const call = got.find((m) => m.id === 2);
  assert(!call?.result?.isError, `tool errored: ${JSON.stringify(call?.result).slice(0, 200)}`);
  assert((call?.result?.content?.[0]?.text ?? '').includes('Example Domain'), 'unexpected content');
});

await test('MCP screenshot returns an image block', async () => {
  const got = await mcpExchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 's', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_screenshot', arguments: { url: 'https://example.com' } } },
  ], 2);
  const block = got.find((m) => m.id === 2)?.result?.content?.[0];
  assert(block?.type === 'image' && block.mimeType === 'image/png', `expected a PNG image block, got ${block?.type}`);
  assert(Buffer.from(block.data, 'base64').length > 1000, 'image too small');
});

report();

// ---------------------------------------------------------------- helpers

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => child.kill(), 200000);
  });
}

function mcpExchange(messages, expected) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const received = [];
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP exchange timed out')); }, 200000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const i = buffer.indexOf('\n');
        if (i < 0) break;
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try { const m = JSON.parse(line); if (m.id !== undefined) received.push(m); } catch { /* ignore */ }
        if (received.length >= expected) { clearTimeout(timer); child.kill(); resolve(received); return; }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
  process.exit(failed > 0 ? 1 : 0);
}
