#!/usr/bin/env node
/**
 * agent-browser CLI.
 *
 * Drives a local Chrome/Chromium over the DevTools Protocol with zero
 * dependencies, hardened so it is not trivially flagged as automation.
 */
import { writeFileSync } from 'node:fs';
import { withBrowser, withSession } from './client.mjs';
import { findBrowser, hasGpu, browserVersion } from './browser.mjs';
import { startMcpServer } from './mcp.mjs';
import { install as installDsh, uninstall as uninstallDsh } from './install.mjs';

const USAGE = `agent-browser — a hardened local browser for AI agents

Usage:
  agent-browser <command> [options]

Commands:
  markdown <url>          Extract the page as Markdown (main content by default)
  text <url>              Visible text only
  html <url>              Full serialized DOM after JavaScript runs
  links <url>             Every anchor as JSON
  screenshot <url>        PNG/JPEG screenshot (-o file, default screenshot.png)
  pdf <url>               Render to PDF (-o file, default page.pdf)
  a11y <url>              Accessibility tree (filtered, agent-friendly)
  eval <url> <expr>       Evaluate a JS expression in the page
  probe                   Report browser, GPU and capability flags
  mcp                     Run as an MCP server over stdio
  install [--profile web] Auto-wire into a DSH profile (edits cordis.patch.yml + package.json)
  uninstall [--profile web] Remove from a DSH profile

Options:
      --headful           Show the browser window (default: headless)
      --no-stealth        Skip the anti-detection hardening
      --block-images      Do not load images (faster, lighter)
      --gpu / --no-gpu    Force GPU on/off (default: auto-detect)
      --width <px>        Window width (default 1920)
      --height <px>       Window height (default 1080)
      --viewport <w>x<h>  Force a device-metrics override (see note below)
      --main              Restrict extraction to the main/article element
      --raw               Do not restrict to main (markdown defaults to main)
      --full              Full-page screenshot
      --endpoint <ws>     Attach to an ALREADY RUNNING browser instead of launching
      --timeout <ms>      Per-command timeout (default 45000)
      --json              Machine-readable output
  -o, --out <file>        Output file for screenshot/pdf
  -h, --help              Show this help

Note on --viewport: a device-metrics override is NOT applied by default,
because the launch geometry is already internally consistent and the common
1280x720 default is a known automation fingerprint. Set it only if you need it.

Environment:
  AGENT_BROWSER_BIN       Path to a Chrome/Chromium binary
  AGENT_BROWSER_ENDPOINT  Attach to this CDP endpoint instead of launching
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[(i += 1)];
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '-o': case '--out': opts.out = take(); break;
      case '--full': opts.full = true; break;
      case '--main': opts.main = true; break;
      case '--raw': opts.raw = true; break;
      case '--json': opts.json = true; break;
      case '--headful': opts.headful = true; break;
      case '--no-stealth': opts.noStealth = true; break;
      case '--block-images': opts.blockImages = true; break;
      case '--gpu': opts.gpu = true; break;
      case '--no-gpu': opts.gpu = false; break;
      case '--width': opts.width = Number(take()); break;
      case '--height': opts.height = Number(take()); break;
      case '--viewport': {
        const [w, h] = String(take()).split('x').map(Number);
        opts.viewport = { width: w, height: h };
        break;
      }
      case '--endpoint': opts.endpoint = take(); break;
      case '--timeout': opts.timeoutMs = Number(take()); break;
      case '--profile': opts.profile = take(); break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        opts._.push(arg);
    }
  }
  return opts;
}

/** Attach to an existing browser when asked, otherwise launch a hardened one. */
function run(opts, body) {
  const endpoint = opts.endpoint ?? process.env.AGENT_BROWSER_ENDPOINT;
  if (endpoint) {
    return withSession({ endpoint, stealth: opts.noStealth !== true, timeoutMs: opts.timeoutMs }, body);
  }
  return withBrowser({
    headless: !opts.headful,
    gpu: opts.gpu ?? 'auto',
    blockImages: Boolean(opts.blockImages),
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    stealth: opts.noStealth !== true,
    timeoutMs: opts.timeoutMs,
  }, body);
}

const CAPABILITY_PROBE = `JSON.stringify({
  webgl: !!document.createElement('canvas').getContext('webgl'),
  webglRenderer: (() => { try {
    const c = document.createElement('canvas').getContext('webgl');
    const d = c.getExtension('WEBGL_debug_renderer_info');
    return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null;
  } catch (_) { return null; } })(),
  canvas2d: !!document.createElement('canvas').getContext('2d'),
  webassembly: typeof WebAssembly,
  serviceWorker: 'serviceWorker' in navigator,
  video: typeof document.createElement('video').canPlayType,
  shadowDom: !!document.createElement('div').attachShadow,
  webdriver: navigator.webdriver,
  headlessInUA: /Headless/i.test(navigator.userAgent)
})`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [command, ...rest] = opts._;

  if (opts.help || !command) { process.stdout.write(USAGE); return 0; }
  if (command === 'mcp') { await startMcpServer(); return 0; }
  if (command === 'install') {
    const profile = opts.profile || rest[0] || 'web';
    const dryRun = Boolean(opts.dryRun);
    const r = installDsh({ profile, dryRun });
    if (dryRun) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    else process.stdout.write(`[agent-browser] installed to DSH profile "${profile}" — restart dsh to load browser_* tools\n`);
    return 0;
  }
  if (command === 'uninstall') {
    const profile = opts.profile || rest[0] || 'web';
    uninstallDsh({ profile });
    process.stdout.write(`[agent-browser] uninstalled from DSH profile "${profile}"\n`);
    return 0;
  }

  if (command === 'probe') {
    const binary = findBrowser();
    const out = {
      binary,
      version: binary ? browserVersion(binary) : null,
      gpuAvailable: hasGpu(),
      endpoint: opts.endpoint ?? process.env.AGENT_BROWSER_ENDPOINT ?? '(launches its own)',
    };
    out.capabilities = await run(opts, async (session) => {
      await session.navigate('https://example.com', { timeoutMs: opts.timeoutMs ?? 45000 });
      return JSON.parse(await session.evaluate(CAPABILITY_PROBE));
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  const url = rest[0];
  if (!url) throw new Error(`command "${command}" requires a url`);

  return run(opts, async (session) => {
    // Only override device metrics when explicitly asked. The launch geometry
    // is already consistent, and the usual 1280x720 default is a known
    // automation fingerprint that detectors flag by name.
    if (opts.viewport) await session.setViewport(opts.viewport);
    const state = await session.navigate(url, { timeoutMs: opts.timeoutMs ?? 45000 });

    const emit = (value) => {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ url: state.url, title: state.title, status: state.status, result: value }, null, 2)}\n`);
      } else {
        process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
      }
    };

    switch (command) {
      case 'markdown': emit(await session.markdown({ main: !opts.raw })); break;
      case 'text': emit(await session.text({ main: Boolean(opts.main) })); break;
      case 'html': emit(await session.html()); break;
      case 'links': emit(await session.links()); break;
      case 'a11y': emit(await session.accessibilityTree()); break;
      case 'eval': {
        const expression = rest.slice(1).join(' ');
        if (!expression) throw new Error('eval requires an expression');
        emit(await session.evaluate(expression));
        break;
      }
      case 'screenshot': {
        const bytes = await session.screenshot({ fullPage: Boolean(opts.full) });
        const file = opts.out ?? 'screenshot.png';
        writeFileSync(file, bytes);
        emit(`wrote ${file} (${bytes.length} bytes) — ${state.title}`);
        break;
      }
      case 'pdf': {
        const bytes = await session.pdf();
        const file = opts.out ?? 'page.pdf';
        writeFileSync(file, bytes);
        emit(`wrote ${file} (${bytes.length} bytes) — ${state.title}`);
        break;
      }
      default: throw new Error(`unknown command: ${command}`);
    }
    return 0;
  });
}

// NEVER call process.exit() here. stdout writes to a pipe are asynchronous, so
// exiting immediately discards anything still buffered — output larger than the
// 64KiB pipe buffer gets silently truncated (`... markdown url > page.md` loses
// the tail). Setting exitCode lets Node flush and exit on its own.
main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    process.stderr.write(`agent-browser: ${err.message}\n`);
    process.exitCode = 1;
  });
