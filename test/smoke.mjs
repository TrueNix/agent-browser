#!/usr/bin/env node
/**
 * Smoke tests against a real local browser.
 *
 * Set AGENT_BROWSER_SKIP_NETWORK=1 to run only the checks that need no browser.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withBrowser, BrowserSession, buildWebglPatch } from '../src/client.mjs';
import { findBrowser, deriveIdentity, hasGpu, launchBrowser, reapAbandoned } from '../src/browser.mjs';
import { addToPackageJson, removeFromPackageJson } from '../src/install.mjs';
import { TOOLS, findTool, toolCatalogue } from '../src/tools.mjs';
import { quote } from '../cordis/plugin.mjs';

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

// The fallback UA used to be hardcoded to "X11; Linux x86_64". On a Mac that
// contradicts navigator.platform ("MacIntel") — a page contradicting itself,
// which is worse than not spoofing at all.
await test('the fallback UA describes the host, not always Linux', () => {
  const mac = deriveIdentity('Google Chrome 151.0.7922.169', { platform: 'darwin', arch: 'arm64' });
  assert(/Macintosh/.test(mac.userAgent), `expected a macOS token, got ${mac.userAgent}`);
  assert(mac.metadata.platform === 'macOS', `expected the macOS client hint, got ${mac.metadata.platform}`);
  assert(mac.metadata.architecture === 'arm', `Apple Silicon is arm, got ${mac.metadata.architecture}`);

  const win = deriveIdentity('Google Chrome 151.0.7922.169', { platform: 'win32', arch: 'x64' });
  assert(/Windows NT/.test(win.userAgent), `expected a Windows token, got ${win.userAgent}`);
  assert(win.metadata.platform === 'Windows', `expected the Windows client hint, got ${win.metadata.platform}`);

  const linux = deriveIdentity('Google Chrome 151.0.7922.169', { platform: 'linux', arch: 'x64' });
  assert(/X11; Linux x86_64/.test(linux.userAgent), `expected a Linux token, got ${linux.userAgent}`);
  assert(linux.metadata.architecture === 'x86', 'x64 maps to the x86 client hint');
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

// A spawn failure used to arrive as an unhandled 'error' event, which killed the
// whole process: the CLI's catch never ran and an MCP server died mid-session.
await test('an unlaunchable binary rejects instead of killing the process', async () => {
  // Not named agentbrowser-*: that prefix is the reaper's, and a test fixture
  // has no business looking like a real profile.
  const home = mkdtempSync(join(tmpdir(), 'ab-fixture-'));
  const fake = join(home, 'not-executable');
  writeFileSync(fake, '#!/nope\n');
  chmodSync(fake, 0o644);
  let message = null;
  try { await launchBrowser({ binary: fake, timeoutMs: 3000 }); }
  catch (err) { message = err.message; }
  assert(message !== null, 'launchBrowser must reject for a binary it cannot spawn');
  assert(/failed to start/.test(message), `expected a start failure, got: ${message}`);
  rmSync(home, { recursive: true, force: true });
});

await test('the WebGL patch keeps a native-looking toString', () => {
  const src = buildWebglPatch('V', 'R');
  assert(src.includes('new Proxy'), 'must wrap the native function in a Proxy');
  assert(src.includes('37445') && src.includes('37446'), 'must handle both UNMASKED_* parameters');
});

console.log('\nabandoned-browser reaping (offline)');

// A SIGKILLed run cannot clean up after itself — measured at 14 orphaned Chrome
// processes and a profile directory that lived forever. The reaper is what
// bounds that to one orphan instead of one per interrupted call.
await test('reaps a profile whose owner is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbrowser-'));
  // pid 2^22 is above the default pid_max, so it can never be live.
  writeFileSync(join(dir, 'agent-browser-owner.json'),
    JSON.stringify({ ownerPid: 4194304, chromePid: null, started: Date.now() }));
  reapAbandoned();
  assert(!existsSync(dir), 'an abandoned profile must be removed');
});

await test('never reaps a profile a live process owns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbrowser-'));
  writeFileSync(join(dir, 'agent-browser-owner.json'),
    JSON.stringify({ ownerPid: process.pid, chromePid: null, started: Date.now() }));
  try {
    reapAbandoned();
    assert(existsSync(dir), 'a live sibling\'s profile must survive the sweep');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('leaves an unattributable profile alone until it settles', () => {
  // No marker at all — an older build, or a launch still in progress.
  const dir = mkdtempSync(join(tmpdir(), 'agentbrowser-'));
  try {
    reapAbandoned();
    assert(existsSync(dir), 'a fresh unmarked profile must not be deleted mid-launch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log('\nDSH profile wiring (offline)');

// The bundle entry is what actually loads the tools. install() used to key the
// whole decision off the dependency and report "already installed" over a
// profile whose tools were never wired.
await test('install wires the bundle even when the dependency is already there', () => {
  const pkg = { name: 'web', dependencies: { '@truenix/agent-browser': '^1.0.0' } };
  const result = addToPackageJson(pkg);
  assert(result.changed, 'a profile missing the bundle entry is not fully installed');
  assert(result.addedBundle && !result.addedDependency, 'only the bundle entry was missing');
  assert(pkg.dsh.profile.bundles.includes('@truenix/agent-browser'), 'bundle entry must be present');
});

// A published installer that wires profiles to the previous major is a silent
// downgrade, so the range must track this package's own version.
await test('install pins the profile to this major', () => {
  const pkg = {};
  addToPackageJson(pkg);
  const range = pkg.dependencies['@truenix/agent-browser'];
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert(range === `^${version}`, `expected ^${version}, got ${range}`);
});

await test('install is a no-op once dependency and bundle are both wired', () => {
  const pkg = {
    dependencies: { '@truenix/agent-browser': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@truenix/agent-browser'] } },
  };
  assert(!addToPackageJson(pkg).changed, 'a fully wired profile must not be rewritten');
  assert(pkg.dsh.profile.bundles.length === 2, 'bundles must not be duplicated');
});

await test('uninstall survives a profile with no dsh block', () => {
  const pkg = { dependencies: { '@truenix/agent-browser': '^1.0.0' } };
  const result = removeFromPackageJson(pkg);
  assert(result.changed, 'the dependency should still be removed');
  assert(!pkg.dependencies['@truenix/agent-browser'], 'dependency must be gone');
});

await test('uninstall removes the bundle entry too', () => {
  const pkg = {
    dependencies: { '@truenix/agent-browser': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@truenix/agent-browser'] } },
  };
  removeFromPackageJson(pkg);
  assert(!pkg.dsh.profile.bundles.includes('@truenix/agent-browser'), 'bundle entry must be gone');
  assert(pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'), 'other bundles must survive');
});

console.log('\ntool catalogue (offline)');

// MCP shipped nine tools and the DSH plugin six, so browser_html,
// browser_accessibility_tree and browser_pdf did not exist for DSH users.
await test('every harness sees the same tools', () => {
  assert(TOOLS.length === 9, `expected 9 tools, got ${TOOLS.length}`);
  for (const tool of TOOLS) {
    assert(typeof tool.run === 'function', `${tool.name} needs an in-process runner`);
    assert(typeof tool.cli === 'function', `${tool.name} needs a CLI form`);
    assert(tool.inputSchema && tool.inputSchema.type === 'object', `${tool.name} needs a schema`);
  }
});

await test('the catalogue renders for MCP, OpenAI and Anthropic', () => {
  assert(toolCatalogue('mcp')[0].inputSchema, 'mcp shape uses inputSchema');
  const openai = toolCatalogue('openai')[0];
  assert(openai.type === 'function' && openai.function.parameters, 'openai shape wraps in function');
  assert(toolCatalogue('anthropic')[0].input_schema, 'anthropic shape uses input_schema');
  for (const format of ['mcp', 'openai', 'anthropic']) {
    assert(toolCatalogue(format).length === TOOLS.length, `${format} must expose every tool`);
  }
});

// The DSH plugin shells out, so a URL or JS expression must never reach sh raw.
await test('CLI arguments survive shell quoting', () => {
  assert(quote("a'b") === "'a'\\''b'", `bad escape: ${quote("a'b")}`);
  const evaluate = findTool('browser_evaluate');
  const argv = evaluate.cli({ url: 'https://x.test', expression: "document.title+'!'" });
  assert(argv[0] === 'eval' && argv[2] === "document.title+'!'", 'expression must pass through intact');
  assert(evaluate.inputSchema.properties.world.enum.join(',') === 'isolated,main',
    'the tool schema must expose the two evaluation worlds');
  const main = evaluate.cli({ url: 'https://x.test', expression: 'window.app', world: 'main' });
  assert(main.includes('--world') && main.includes('main'), 'the CLI form must preserve an explicit main world');
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

await test('evaluation and extraction avoid main-world hooks unless explicitly opted in', async () => {
  await withBrowser({}, async (session) => {
    const copy = 'visible page content '.repeat(20);
    const html = '<main><h1>Trusted heading</h1><p>' + copy + '</p></main><script>'
      + 'window.__agentBrowserHookHits=0;'
      + 'const originalQuery=Document.prototype.querySelector;'
      + 'Document.prototype.querySelector=function(...args){window.__agentBrowserHookHits+=1;'
      + 'return Reflect.apply(originalQuery,this,args)};'
      + '</script>';
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const heading = await session.evaluate("document.querySelector('h1').innerText");
    assert(heading === 'Trusted heading', 'isolated evaluation must still share the page DOM');
    const markdown = await session.markdown();
    assert(markdown.includes('Trusted heading'), 'Markdown extraction must still work in the isolated world');

    const evaluate = findTool('browser_evaluate');
    const viaTool = await evaluate.run(session, { expression: "document.querySelector('h1').innerText" });
    assert(viaTool === 'Trusted heading', 'browser_evaluate must work in its default isolated world');
    const untouched = await session.evaluate('window.__agentBrowserHookHits', { world: 'main' });
    assert(untouched === 0, `isolated reads touched the page hook ${untouched} times`);

    const main = await evaluate.run(session, {
      expression: "document.querySelector('h1').innerText",
      world: 'main',
    });
    assert(main === 'Trusted heading', 'explicit main-world tool evaluation must return its value');
    const triggered = await session.evaluate('window.__agentBrowserHookHits', { world: 'main' });
    assert(triggered === 1, `explicit main-world evaluation should trigger the hook once, got ${triggered}`);
  });
});

await test('CLI eval defaults to isolated and can explicitly enter the main world', async () => {
  const url = `data:text/html,${encodeURIComponent('<script>window.__pageDefined=41</script>')}`;
  const isolated = await run(process.execPath, [CLI, 'eval', url, 'typeof window.__pageDefined']);
  assert(isolated.code === 0 && isolated.stdout.trim() === 'undefined',
    `default CLI eval should be isolated, got: ${isolated.stdout.trim()} ${isolated.stderr.trim()}`);
  const main = await run(process.execPath,
    [CLI, 'eval', url, '--world', 'main', 'window.__pageDefined+1']);
  assert(main.code === 0 && main.stdout.trim() === '42',
    `--world main should see page globals, got: ${main.stdout.trim()} ${main.stderr.trim()}`);
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

// Table cells were rendered with innerText, which dropped every link, code span
// and emphasis inside them. On a table-based layout that is the whole page.
// The help used to recommend textContent.trim(). trim() only strips the ends,
// so GitHub's markup came back as "openai /\n\n      codex" and the agent that
// copied the example paid a full retry round trip to discover it. Documentation
// that is wrong costs more than documentation that is missing.
await test('the documented eval recipe survives source whitespace', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate("data:text/html,<article><h2><a href='/o/r'>owner\n\n      repo</a></h2></article>");
    const viaTextContent = await session.evaluate("document.querySelector('article h2 a').textContent.trim()");
    const viaInnerText = await session.evaluate("document.querySelector('article h2 a').innerText.trim()");
    assert(/\s{2,}|\n/.test(viaTextContent), 'fixture must reproduce the interior-whitespace trap');
    assert(!/\s{2,}|\n/.test(viaInnerText), `innerText should be clean, got ${JSON.stringify(viaInnerText)}`);
  });
});

await test('the CLI help recommends the recipe that works', () => {
  const usage = readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  const example = usage.slice(usage.indexOf('agent-browser eval https://github.com/trending'));
  const line = example.slice(0, example.indexOf('\n\n'));
  assert(line.includes('innerText'), 'the worked example must use innerText');
  assert(!line.includes('textContent'), 'and must not recommend textContent, which keeps source whitespace');
});

await test('table cells keep their inline markup', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('data:text/html,<table><tr><th>API</th><th>Doc</th></tr>'
      + '<tr><td><code>fetch()</code></td><td><a href="https://mdn.test/f">MDN</a></td></tr></table>');
    const md = await session.markdown({ main: false });
    assert(md.includes('`fetch()`'), `code span lost in a cell: ${md}`);
    assert(md.includes('[MDN](https://mdn.test/f)'), `link lost in a cell: ${md}`);
  });
});

await test('Markdown omits hidden and inert prompt injection while preserving display contents', async () => {
  await withBrowser({}, async (session) => {
    const html = '<style>.gone{display:none}.unseen{visibility:hidden}.transparent{opacity:0}</style>'
      + '<main><h1>Trusted <span class=transparent>DO_NOT_FOLLOW_HEADING</span> heading</h1>'
      + '<p>Visible answer</p>'
      + '<div style="display:contents">Visible contents text <span>and child</span></div>'
      + '<p hidden>DO_NOT_FOLLOW_HIDDEN</p>'
      + '<p class=gone>DO_NOT_FOLLOW_DISPLAY</p>'
      + '<p class=unseen>DO_NOT_FOLLOW_VISIBILITY</p>'
      + '<p class=transparent>DO_NOT_FOLLOW_OPACITY</p>'
      + '<section inert><p>DO_NOT_FOLLOW_INERT</p></section>'
      + '<p aria-hidden=TrUe>DO_NOT_FOLLOW_ARIA_CASE</p>'
      + '<a href=/safe>Safe link<span inert>DO_NOT_FOLLOW_LINK</span></a>'
      + '<pre>safe code<span hidden>DO_NOT_FOLLOW_CODE</span></pre>'
      + '<ol><li class=gone>DO_NOT_FOLLOW_LIST</li><li>Visible list item</li></ol>'
      + '<table><tr><th>Safe</th><th class=gone>DO_NOT_FOLLOW_TABLE_HEAD</th></tr>'
      + '<tr><td>visible cell</td><td class=transparent>DO_NOT_FOLLOW_TABLE_CELL</td></tr></table>'
      + '</main>';
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);

    const native = await session.markdown({ main: false });
    assert(native.includes('Visible answer') && native.includes('Visible contents text and child')
      && native.includes('Safe link') && native.includes('safe code')
      && native.includes('1. Visible list item'),
      `visible content was lost: ${native}`);
    assert(!native.includes('DO_NOT_FOLLOW'), `hidden prompt injection leaked through: ${native}`);

  });
});

await test('visibility-hidden text stays hidden while a visible descendant survives', async () => {
  await withBrowser({}, async (session) => {
    const html = '<div style="visibility:hidden">DO_NOT_SHOW_PARENT '
      + '<span>DO_NOT_SHOW_INHERITED</span>'
      + '<span style="visibility:visible">Visible override</span></div>';
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const md = await session.markdown({ main: false });
    assert(md.includes('Visible override'), `visibility override was lost: ${md}`);
    assert(!md.includes('DO_NOT_SHOW'), `hidden ancestor text leaked: ${md}`);
  });
});

await test('a closed details exposes only its summary', async () => {
  await withBrowser({}, async (session) => {
    const html = '<details>DO_NOT_SHOW_DIRECT<summary>Visible summary</summary>'
      + '<p>DO_NOT_SHOW_CLOSED_BODY</p></details>'
      + '<details open><summary>Open summary</summary><p>Visible open body</p></details>';
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const md = await session.markdown({ main: false });
    assert(md.includes('Visible summary') && md.includes('Visible open body'),
      `rendered disclosure text was lost: ${md}`);
    assert(!md.includes('DO_NOT_SHOW'), `closed disclosure text leaked: ${md}`);
  });
});

await test('main-root selection counts only content that extraction can render', async () => {
  await withBrowser({}, async (session) => {
    const hidden = 'DO_NOT_SELECT_HIDDEN_MAIN '.repeat(30);
    const visible = 'visible article content '.repeat(20);
    const html = '<main><p>Short teaser</p><div style="opacity:0">' + hidden + '</div></main>'
      + '<article><h1>Chosen article</h1><p>' + visible + '</p></article>';
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const md = await session.markdown();
    assert(md.includes('Chosen article') && md.includes('visible article content'),
      `hidden long main displaced the visible article: ${md}`);
    assert(!md.includes('DO_NOT_SELECT'), `hidden root-selection text leaked: ${md}`);

    const secondMain = 'second main visible content '.repeat(20);
    const twoMains = '<main><div style="opacity:0">' + hidden + '</div></main>'
      + '<main><h1>Chosen second main</h1><p>' + secondMain + '</p></main>'
      + '<p>OUTSIDE_ROOT_SENTINEL</p>';
    await session.navigate(`data:text/html,${encodeURIComponent(twoMains)}`);
    const selected = await session.markdown();
    assert(selected.includes('Chosen second main') && !selected.includes('OUTSIDE_ROOT_SENTINEL'),
      `the first hidden main blocked a later visible main: ${selected}`);
  });
});

await test('hidden table cells retain their column placeholders', async () => {
  await withBrowser({}, async (session) => {
    const html = '<table><tr><th>A</th><th style="display:none">DO_NOT_SHOW</th><th>C</th></tr>'
      + '<tr><td>1</td><td hidden>DO_NOT_SHOW</td><td>3</td></tr></table>';
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const md = await session.markdown({ main: false });
    assert(md.includes('| A |  | C |'), `hidden header shifted the last column: ${md}`);
    assert(md.includes('| 1 |  | 3 |'), `hidden data cell shifted the last column: ${md}`);
    assert(!md.includes('DO_NOT_SHOW'), `hidden table-cell text leaked: ${md}`);
  });
});

await test('button text survives only when it carries data', async () => {
  await withBrowser({}, async (session) => {
    const html = '<main><h1>Profile</h1>'
      + '<button title="13,111,999"><p><span>13.1M</span></p><p>Followers</p></button>'
      + '<button>69 Following</button>'
      + '<button>DO_NOT_SHOW_CHROME</button>'
      + '<button hidden>DO_NOT_SHOW 42</button>'
      + '<button>Like</button>'
      + '<button aria-label="Reply"><svg></svg><span>206</span></button>'
      + '<button aria-label="Like" title="Like">2.15k</button>'
      + '<table><tr><th>Repo</th><th>Stars</th></tr><tr><td>x</td><td><button>1.2k stars</button></td></tr></table>'
      + '</main>';
    await session.navigate(`data:text/html,${encodeURIComponent(html)}`);
    const md = await session.markdown({ main: false });
    assert(md.includes('13.1M Followers') && md.includes('69 Following'), `counter buttons were dropped: ${md}`);
    assert(md.includes('Reply 206') && md.includes('Like 2.15k') && !md.includes('13,111,999 13.1M'),
      `an icon counter lost its label or a numeric title was prepended: ${md}`);
    assert(md.includes('| x | 1.2k stars |'), `counter button in a table cell was dropped: ${md}`);
    assert(!md.includes('DO_NOT_SHOW'), `chrome or hidden button text leaked: ${md}`);
  });
});

await test('a throttled or unrendered page comes back with a warning', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url === '/api') { res.writeHead(429); res.end('slow down'); return; }
    if (req.url === '/shell') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<div id=app>Loading…</div><script>setTimeout(()=>{app.textContent="late content"},3000)</script>');
      return;
    }
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<main><p>${'ordinary loaded page '.repeat(20)}</p></main>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main><p>No posts</p></main><script>fetch("/api").then(()=>{},()=>{})</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await withBrowser({}, async (session) => {
      const throttled = await session.navigate(`${base}/`, { waitUntil: 'idle' });
      await session.markdown();
      assert(session.warnings().some((w) => /rate-limited 1 .*HTTP 429/.test(w)),
        `no rate-limit warning: ${JSON.stringify(session.warnings())}`);
      assert(Array.isArray(throttled.warnings), 'navigate() must return a warnings array');

      const shell = await session.navigate(`${base}/shell`);
      assert(shell.warnings.some((w) => /waitUntil "idle"/.test(w)), `no loading-shell hint: ${JSON.stringify(shell.warnings)}`);

      const plain = await session.navigate(`${base}/plain`);
      assert(plain.warnings.length === 0 && session.warnings().length === 0,
        `a clean page carried stale warnings: ${JSON.stringify(session.warnings())}`);
    });
  } finally {
    server.close();
  }
});

await test('deep extraction computes visibility once per element', async () => {
  await withBrowser({}, async (session) => {
    const depth = 400;
    await session.navigate('data:text/html,<body></body>');
    await session.evaluate(`(()=>{
      document.body.replaceChildren();
      let parent=document.body;
      for(let i=0;i<${depth};i+=1){const child=document.createElement('div');parent.appendChild(child);parent=child;}
      parent.textContent='DEPTH END';
      const nativeStyle=globalThis.getComputedStyle.bind(globalThis);
      let calls=0;
      globalThis.getComputedStyle=(...args)=>{calls+=1;return nativeStyle(...args);};
      Object.defineProperty(Element.prototype,'checkVisibility',{value:undefined,configurable:true});
      globalThis.__agentBrowserStyleCalls=()=>calls;
      return true;
    })()`);
    const started = Date.now();
    const md = await session.markdown({ main: false });
    const elapsed = Date.now() - started;
    const calls = await session.evaluate('globalThis.__agentBrowserStyleCalls()');
    assert(md.includes('DEPTH END'), 'deep content must survive the iterative walk');
    assert(calls <= depth + 10, `expected O(N) style reads, got ${calls} for depth ${depth}`);
    assert(elapsed < 2000, `deep extraction timing sanity check took ${elapsed}ms`);
  });
});

await test('a layout table is not forced into pipe syntax', async () => {
  await withBrowser({}, async (session) => {
    // A table wrapping another table is page furniture, not data.
    await session.navigate('data:text/html,<table><tr><td><table><tr><td>'
      + '<h1>Real heading</h1><p>Real paragraph</p></td></tr></table></td></tr></table>');
    const md = await session.markdown({ main: false });
    assert(md.includes('# Real heading'), `heading should survive: ${md}`);
    assert(!md.includes('|'), `layout table should not render as a pipe table: ${md}`);
  });
});

await test('a truncated table says so', async () => {
  await withBrowser({}, async (session) => {
    const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>row${i}</td></tr>`).join('');
    await session.navigate(`data:text/html,<table><tr><th>H</th></tr>${rows}</table>`);
    const md = await session.markdown({ main: false, maxRows: 5 });
    assert(/table truncated: 4 of 12 rows shown/.test(md), `expected a truncation notice: ${md}`);
    const full = await session.markdown({ main: false, maxRows: 0 });
    assert(full.includes('row11') && !/truncated/.test(full), 'maxRows 0 means no cap and no notice');
  });
});

await test('link styles trade URLs for tokens', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://en.wikipedia.org/wiki/WebAssembly');
    const inline = await session.markdown({ links: 'inline' });
    const relative = await session.markdown({ links: 'relative' });
    const text = await session.markdown({ links: 'text' });
    assert(/\]\(https:\/\//.test(inline), 'inline keeps absolute URLs');
    assert(/\]\(\/wiki\//.test(relative), 'relative drops the origin');
    assert(!/\]\(/.test(text), 'text drops URLs entirely');
    assert(text.length < inline.length * 0.75, `text mode should be far smaller: ${text.length} vs ${inline.length}`);
    assert(relative.length < inline.length, 'relative should be smaller than inline');
  });
});

// navigate() used to poll readyState every 200ms and then sleep a flat 250ms.
// The fixed settle was a guess: it cost every page a quarter second AND still
// missed content that renders after load. Events are faster; 'idle' is correct.
await test('waitUntil idle catches content that arrives after load', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url === '/data') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ body: 'LATE CONTENT' }));
      }, 350);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<main><h1>Shell</h1><div id=app></div></main><script>'
      + 'addEventListener("load",()=>{fetch("/data").then(r=>r.json())'
      + '.then(d=>{document.getElementById("app").innerHTML="<p>"+d.body+"</p>";});});</script>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await withBrowser({}, async (session) => {
      await session.navigate(url, { waitUntil: 'load' });
      assert(!(await session.markdown()).includes('LATE CONTENT'), 'load fires before the fetch resolves');
      await session.navigate(url, { waitUntil: 'idle' });
      assert((await session.markdown()).includes('LATE CONTENT'), 'idle must wait for the real signal');
    });
  } finally { server.close(); }
});

await test('the default wait is event-driven, not a fixed delay', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');            // warm the cache
    const started = Date.now();
    const state = await session.navigate('https://example.com');
    const elapsed = Date.now() - started;
    assert(state.readyState === 'complete', 'must still report a loaded page');
    // The old path could not beat its own 250ms settle, whatever the page cost.
    assert(elapsed < 200, `expected an event wait, took ${elapsed}ms`);
  });
});

await test('waitUntil rejects a mode it does not have', async () => {
  await withBrowser({}, async (session) => {
    let threw = false;
    try { await session.navigate('https://example.com', { waitUntil: 'whenever' }); }
    catch { threw = true; }
    assert(threw, 'an unknown milestone must fail loudly, not wait forever');
  });
});

await test('extracts links and an accessibility tree', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    const links = await session.links();
    assert(links.links.length > 0 && links.links[0].href.startsWith('http'), 'expected an absolute link');
    assert(links.total === links.links.length && links.truncated === false, 'nothing to truncate here');
    const tree = await session.accessibilityTree();
    assert(tree.nodes.some((n) => n.role === 'heading'), 'expected a heading node');
    assert(tree.truncated === false, 'example.com fits well under the cap');
  });
});

// The full tree is ~8000 nodes / 500 kB on a real article — enough to swallow an
// agent's whole context in one call. The cap must hold AND be visible.
await test('a bounded accessibility tree reports what it clipped', async () => {
  await withBrowser({}, async (session) => {
    await session.navigate('https://en.wikipedia.org/wiki/WebAssembly');
    const tree = await session.accessibilityTree({ limit: 25 });
    assert(tree.nodes.length === 25, `expected 25 nodes, got ${tree.nodes.length}`);
    assert(tree.total > 25, 'a real article has far more nodes than the cap');
    assert(tree.truncated === true, 'truncation must be stated, never silent');

    const capped = await session.links({ limit: 10 });
    assert(capped.links.length === 10 && capped.total > 10 && capped.truncated === true,
      'links() must report its cap too');
  });
});

// Chrome's floor is ~420 MB across ~18 processes, so the cost that matters is
// how many browsers are alive at once, not how big one is. The pool keeps one.
await test('the pool reuses one browser across calls', async () => {
  const { withPooledSession, poolStatus, shutdownPool } = await import('../src/pool.mjs');
  try {
    await withPooledSession({}, (s) => s.navigate('https://example.com'));
    const first = poolStatus().pid;
    assert(first !== null, 'a browser should be up after the first call');
    await withPooledSession({}, (s) => s.navigate('https://example.com'));
    assert(poolStatus().pid === first, 'the second call must reuse the same browser');
    assert(poolStatus().active === 0, 'no session should be left checked out');
  } finally { await shutdownPool(); }
});

await test('pooled contexts still do not share storage', async () => {
  const { withPooledSession, shutdownPool } = await import('../src/pool.mjs');
  try {
    await withPooledSession({}, async (s) => {
      await s.navigate('https://example.com');
      await s.evaluate("localStorage.setItem('pool-probe','leaked')");
    });
    const seen = await withPooledSession({}, async (s) => {
      await s.navigate('https://example.com');
      return s.evaluate("localStorage.getItem('pool-probe')");
    });
    assert(seen === null, `sharing a browser must not share storage, got ${seen}`);
  } finally { await shutdownPool(); }
});

await test('shutdownPool closes the shared browser', async () => {
  const { withPooledSession, poolStatus, shutdownPool } = await import('../src/pool.mjs');
  await withPooledSession({}, (s) => s.navigate('https://example.com'));
  const pid = poolStatus().pid;
  await shutdownPool();
  assert(poolStatus().up === false, 'pool must report itself down');
  await new Promise((r) => setTimeout(r, 800));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert(!alive, 'the browser process should be gone');
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

await test('WebGL always reports a renderer, hardware or software', async () => {
  // The assertion is that WebGL EXISTS and names a renderer. Whether it is
  // hardware depends on the machine (CI runners and containers have no usable
  // GPU), and a software renderer is a correct outcome there — what must never
  // happen is getContext('webgl') returning null.
  await withBrowser({}, async (session) => {
    await session.navigate('https://example.com');
    const r = await session.evaluate(
      '(()=>{const c=document.createElement("canvas").getContext("webgl");'
      + 'if(!c) return null;'
      + 'const d=c.getExtension("WEBGL_debug_renderer_info");'
      + 'return d?c.getParameter(d.UNMASKED_RENDERER_WEBGL):"(no debug info)"})()',
    );
    assert(r !== null, 'WebGL context must never be null — check that --disable-gpu is not being passed');
    assert(typeof r === 'string' && r.length > 0, `expected a renderer string, got ${r}`);
    const kind = /SwiftShader|Google/i.test(r) ? 'software' : 'hardware';
    console.log(`       renderer: ${kind} — ${String(r).slice(0, 62)}`);
    if (hasGpu() && kind === 'software') console.log('       (GPU nodes present but unusable; software fallback is correct)');
  });
});

// ---------------------------------------------------------------- cli + mcp

console.log('\nshared-browser daemon');

// Every CLI call is its own process, so without a daemon ten concurrent calls
// mean ten cold Chrome launches. These assert the guarantees that make sharing
// one safe: exactly one daemon, real isolation, and nothing left running.
await test('daemon serves one browser to many clients, then stops', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'ab-daemon-')), 'd.sock');
  const env = { ...process.env, AGENT_BROWSER_DAEMON_SOCKET: socket, AGENT_BROWSER_DAEMON_IDLE_MS: '60000' };
  const daemon = spawn(process.execPath, [CLI, 'daemon'], { env, stdio: 'ignore', detached: false });
  try {
    const { acquire, daemonStatus, stopDaemon } = await import(`../src/daemon.mjs?d=${socket}`);
    process.env.AGENT_BROWSER_DAEMON_SOCKET = socket;

    // The daemon binds its socket BEFORE launching Chrome, so it answers
    // `status` while still starting — with endpoint null and starting true.
    // Wait for the browser, not merely for something to answer the socket.
    let up = null;
    for (let i = 0; i < 80 && !up?.endpoint; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      up = await daemonStatus().catch(() => null);
    }
    assert(up?.endpoint, `daemon should come up and report an endpoint, last status: ${JSON.stringify(up)}`);
    assert(up.starting === false, 'and should no longer report itself as starting');

    // Two clients must be handed the SAME browser.
    const a = await acquire({ autostart: false });
    const b = await acquire({ autostart: false });
    assert(a.endpoint === b.endpoint, 'both clients must share one browser');
    const busy = await daemonStatus();
    assert(busy.clients === 2, `expected 2 clients, got ${busy.clients}`);
    a.release(); b.release();

    // Releasing is observable, which is what makes the idle timer trustworthy.
    let idle = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      idle = await daemonStatus();
      if (idle && idle.clients === 0) break;
    }
    assert(idle.clients === 0, `clients should drop back to 0, got ${idle.clients}`);

    assert(await stopDaemon(), 'stop should be acknowledged');
    await new Promise((r) => setTimeout(r, 800));
    assert(await daemonStatus() === null, 'daemon should be gone after stop');
  } finally {
    delete process.env.AGENT_BROWSER_DAEMON_SOCKET;
    try { daemon.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(dirname(socket), { recursive: true, force: true });
  }
});

// --width/--headful/--gpu are fixed when the browser launches, so a shared
// browser cannot honour them. Handing back a 1920x1080 page to someone who
// asked for 800x600 would be exactly the quiet wrongness this project avoids.
await test('an explicit launch flag beats the daemon rather than being ignored', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'ab-daemon-')), 'd.sock');
  const env = { ...process.env, AGENT_BROWSER_DAEMON_SOCKET: socket, AGENT_BROWSER_DAEMON_IDLE_MS: '20000' };
  try {
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath,
        [CLI, 'eval', 'https://example.com', "window.outerWidth+'x'+window.outerHeight",
          '--daemon', '--width', '800', '--height', '600'],
        { env });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', () => resolve({ stdout, stderr }));
    });
    assert(out.stdout.includes('800x600'), `the explicit size must win, got: ${out.stdout.trim()}`);
    assert(/cannot apply to the shared browser/.test(out.stderr), 'and it must say why it skipped the daemon');
  } finally { rmSync(dirname(socket), { recursive: true, force: true }); }
});

await test('daemon sessions do not share storage', async () => {
  const socket = join(mkdtempSync(join(tmpdir(), 'ab-daemon-')), 'd.sock');
  process.env.AGENT_BROWSER_DAEMON_SOCKET = socket;
  const { withDaemonSession, stopDaemon } = await import(`../src/daemon.mjs?iso=${socket}`);
  try {
    await withDaemonSession({}, async (session) => {
      await session.navigate('https://example.com');
      await session.evaluate("localStorage.setItem('daemon-probe','leaked')");
    });
    const seen = await withDaemonSession({}, async (session) => {
      await session.navigate('https://example.com');
      return session.evaluate("localStorage.getItem('daemon-probe')");
    });
    assert(seen === null, `sharing a browser must not share storage, got ${seen}`);
  } finally {
    await stopDaemon().catch(() => {});
    delete process.env.AGENT_BROWSER_DAEMON_SOCKET;
    rmSync(dirname(socket), { recursive: true, force: true });
  }
});

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
