/**
 * Local hardened browser launcher.
 *
 * Goal: give an agent a LOCAL browser that is memory-conscious and does not
 * announce itself as automation, using the real Chrome network stack (which is
 * the part anti-bot actually checks first, and the part no custom engine can
 * fake).
 *
 * Design rules learned from measuring, not from folklore:
 *
 *  1. CONSISTENCY BEATS COVERAGE. A spoof that contradicts another value is
 *     worse than no spoof. Setting --window-size without
 *     --ozone-override-screen-size produces outerWidth > screen.width, which is
 *     physically impossible and a stronger signal than plain headless.
 *
 *  2. navigator.webdriver comes from --enable-automation, NOT from CDP. We never
 *     pass it, so webdriver is already false without patching anything.
 *
 *  3. Use the REAL GPU when one exists. A genuine ANGLE/NVIDIA renderer string
 *     beats any JS getParameter hook, which is itself detectable through
 *     Function.prototype.toString.
 *
 *  4. Derive the User-Agent from the browser's own version and strip "Headless",
 *     rather than hardcoding a version that will drift out of sync with the
 *     binary and become its own tell.
 *
 *  5. Client Hints must match. --user-agent does NOT update Sec-CH-UA, so a
 *     stale/headless brand list leaks in request headers even when
 *     navigator.userAgent looks clean. We override both together.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

const CANDIDATES = [
  process.env.AGENT_BROWSER_BIN,
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  join(process.env.HOME || '', '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** Locate a usable Chrome/Chromium binary. */
export function findBrowser() {
  for (const candidate of CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    // Bare command: resolve through PATH without spawning a shell.
    for (const dir of (process.env.PATH || '').split(':')) {
      if (dir && existsSync(join(dir, candidate))) return join(dir, candidate);
    }
  }
  return null;
}

/** True when a real GPU render node exists, so we can avoid SwiftShader. */
export function hasGpu() {
  try { return existsSync('/dev/dri/renderD128') || existsSync('/dev/dri/card0') || existsSync('/dev/dri/card1'); }
  catch { return false; }
}

function baseFlags({ width, height, lang, gpu, headless, profileDir, blockImages, userAgent }) {
  const flags = [
    `--user-data-dir=${profileDir}`,
    // The UA MUST be set at launch, not only through
    // Emulation.setUserAgentOverride. The CDP override applies to the page but
    // NOT to Web Workers, so a worker keeps reporting the headless UA while the
    // main thread reports the clean one. Detectors compare the two and flag the
    // mismatch (deviceandbrowserinfo's `hasInconsistentWorkerValues`), which is
    // worse than never spoofing at all.
    `--user-agent=${userAgent}`,
    '--remote-debugging-port=0', // let the OS choose; avoids port collisions
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--lang=${lang}`,
    `--window-size=${width},${height}`,
    // Screen must move WITH the window or the pair becomes impossible.
    `--ozone-override-screen-size=${width},${height}`,
    // Memory / noise reduction. None of these are automation tells.
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-breakpad',
    '--metrics-recording-only',
    '--mute-audio',
    // NOTE: deliberately NOT passing --enable-automation, which is what sets
    // navigator.webdriver = true.
  ];

  if (headless) flags.push('--headless=new');
  if (blockImages) flags.push('--blink-settings=imagesEnabled=false');

  if (gpu) {
    flags.push('--use-gl=angle', '--use-angle=gl-egl', '--enable-gpu', '--ignore-gpu-blocklist');
  } else {
    flags.push('--disable-gpu');
  }

  if (process.getuid && process.getuid() === 0) flags.push('--no-sandbox');
  return flags;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the DevTools endpoint Chrome writes into its profile.
 * More reliable than guessing a port, and it is how we avoid the collision that
 * silently pushes a second instance onto a different interface.
 */
function readEndpoint(profileDir) {
  const file = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8').split('\n');
  if (raw.length < 2) return null;
  const port = raw[0].trim();
  const path = raw[1].trim();
  if (!port || !path) return null;
  return { port: Number(port), endpoint: `ws://127.0.0.1:${port}${path}` };
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, timeout: 10000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Read the binary's version WITHOUT launching a browser ("Google Chrome 151.0.x").
 * Needed because the User-Agent must be passed as a launch flag, which happens
 * before any DevTools endpoint exists to ask.
 */
export function browserVersion(binary) {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  } catch { return ''; }
}

/**
 * Build a clean User-Agent plus matching Client Hints metadata from the
 * browser's OWN reported version, so the two can never disagree.
 *
 * Accepts either a full UA string or a `--version` line.
 * @param {string} raw
 */
export function deriveIdentity(raw) {
  const version = (raw.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/) || [])[0];
  const isUa = /Mozilla\//.test(raw);
  const major = version ? version.split('.')[0] : '131';
  const full = version || `${major}.0.0.0`;
  // Chrome's reduced UA pins the last three components to 0.
  const userAgent = isUa
    ? raw.replace(/Headless/g, '')
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const platform = /Windows/.test(userAgent) ? 'Windows'
    : /Macintosh|Mac OS/.test(userAgent) ? 'macOS'
    : 'Linux';
  // Chrome's real brand list includes a deliberately varied "not a brand"
  // entry; omitting it is itself a mismatch against Sec-CH-UA.
  const brands = [
    { brand: 'Not_A Brand', version: '8' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
  return {
    userAgent,
    metadata: {
      brands,
      fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === 'Not_A Brand' ? '8.0.0.0' : full })),
      fullVersion: full,
      platform,
      platformVersion: platform === 'Linux' ? '6.1.0' : '15.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    },
  };
}

/**
 * Launch a hardened local browser.
 * @returns {Promise<{endpoint:string, port:number, identity:object, close:()=>void, pid:number}>}
 */
export async function launchBrowser(options = {}) {
  const {
    headless = true,
    width = 1920,
    height = 1080,
    lang = 'en-US',
    gpu = 'auto',
    blockImages = false,
    binary = findBrowser(),
    timeoutMs = 30000,
    keepProfile = false,
  } = options;

  if (!binary) {
    throw new Error(
      'no Chrome/Chromium binary found. Install one, or set AGENT_BROWSER_BIN to its path.',
    );
  }

  const useGpu = gpu === 'auto' ? hasGpu() : Boolean(gpu);
  const profileDir = mkdtempSync(join(tmpdir(), 'agentbrowser-'));
  // Derive the identity from the binary's own version BEFORE launching, so the
  // same clean UA reaches the command line (covering workers) and the CDP
  // override (covering Client Hints). One string, no way for them to disagree.
  const identity = options.identity ?? deriveIdentity(browserVersion(binary));
  const flags = baseFlags({
    width, height, lang, gpu: useGpu, headless, profileDir, blockImages,
    userAgent: identity.userAgent,
  });

  const child = spawn(binary, [...flags, 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  });

  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString(); });

  let exited = false;
  child.on('exit', () => { exited = true; });

  const deadline = Date.now() + timeoutMs;
  let info = null;
  while (Date.now() < deadline) {
    if (exited) {
      cleanup();
      throw new Error(`browser exited during startup: ${stderr.slice(-500) || 'no stderr'}`);
    }
    info = readEndpoint(profileDir);
    if (info) break;
    await sleep(150);
  }
  if (!info) {
    cleanup();
    throw new Error(`browser did not expose a DevTools endpoint within ${timeoutMs}ms: ${stderr.slice(-400)}`);
  }

  // Sanity-check that the launch flag actually took, so a silently ignored
  // --user-agent surfaces here rather than as a detection failure later.
  let reportedUserAgent = '';
  try {
    const version = await getJson(info.port, '/json/version');
    reportedUserAgent = version['User-Agent'] || '';
  } catch { /* non-fatal */ }

  function cleanup() {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    if (!keepProfile) {
      // Give Chrome a moment to release the profile before removing it.
      setTimeout(() => { try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ } }, 500);
    }
  }

  return {
    endpoint: info.endpoint,
    port: info.port,
    identity,
    reportedUserAgent,
    headlessLeak: /Headless/i.test(reportedUserAgent),
    profileDir,
    pid: child.pid,
    gpu: useGpu,
    binary,
    close: cleanup,
  };
}
