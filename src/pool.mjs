/**
 * One shared browser, one isolated context per task.
 *
 * WHY THIS EXISTS
 * ---------------
 * A Chrome instance costs ~420 MB PSS across ~18 processes before it has loaded
 * anything. That floor is Chrome's, not ours — flag tuning moves it by about 5%,
 * and the flags that move it further (`--enable-low-end-device-mode`) lie about
 * navigator.deviceMemory, which is exactly the fingerprint inconsistency this
 * project refuses to ship.
 *
 * So the win is not a smaller browser, it is FEWER browsers. Launching one per
 * task multiplies that floor by the number of tasks in flight. Measured, three
 * heavy pages fetched concurrently:
 *
 *   a browser per task          1289 MB peak, 44 processes
 *   one browser, 3 contexts      736 MB peak, 20 processes    (-43%, same wall clock)
 *
 * The isolation guarantee is unchanged. Each task still gets its own
 * Target.createBrowserContext — separate cookies, storage and cache — which is
 * what `withBrowser` was already using inside its private browser anyway.
 *
 * THE TRADE
 * ---------
 * Tasks now share a process tree, so a browser-level crash takes out every task
 * in flight instead of one. That is mitigated, not eliminated: a dead browser is
 * detected and relaunched on the next acquire. Callers that genuinely need
 * blast-radius isolation should keep using `withBrowser`, which is unchanged.
 *
 * The browser is launched on first use and closed again once it has been idle,
 * so a long-lived MCP server does not sit on 420 MB between conversations.
 */
import { launchBrowser } from './browser.mjs';
import { BrowserSession } from './client.mjs';

/** How long an unused browser lingers before it is shut down. */
const IDLE_MS = Number(process.env.AGENT_BROWSER_IDLE_MS ?? 30000);

let browser = null;
let launchInFlight = null;
let active = 0;
let idleTimer = null;
let exitHooked = false;

function cancelIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/** Tear the shared browser down now. Safe to call when there is none. */
export async function shutdownPool() {
  cancelIdleTimer();
  const dying = browser;
  browser = null;
  launchInFlight = null;
  if (dying) { try { dying.close(); } catch { /* already gone */ } }
}

function scheduleIdleShutdown() {
  cancelIdleTimer();
  if (active > 0 || !browser) return;
  if (IDLE_MS <= 0) { shutdownPool(); return; }
  idleTimer = setTimeout(() => { if (active === 0) shutdownPool(); }, IDLE_MS);
  // Never hold the event loop open just to wait out an idle timer.
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

/** True when the launched process is gone, so the endpoint is dead. */
function isDead(candidate) {
  if (!candidate?.pid) return true;
  try { process.kill(candidate.pid, 0); return false; } catch { return true; }
}

async function acquireBrowser(options) {
  cancelIdleTimer();
  if (browser && isDead(browser)) browser = null;
  if (browser) return browser;
  // Collapse concurrent first-calls onto a single launch.
  if (!launchInFlight) {
    launchInFlight = launchBrowser(options)
      .then((launched) => { browser = launched; launchInFlight = null; return launched; })
      .catch((err) => { launchInFlight = null; throw err; });
  }
  const launched = await launchInFlight;

  if (!exitHooked) {
    exitHooked = true;
    // Best effort: do not leave an orphaned Chrome behind if the host exits.
    for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
      process.once(signal, () => { try { if (browser) browser.close(); } catch { /* going away */ } });
    }
  }
  return launched;
}

/**
 * Run `body` against a session on the shared browser, in its own isolated
 * context. Mirrors `withSession`/`withBrowser`, so a caller can swap between
 * them without changing the body.
 *
 * @template T
 * @param {object} options launch options (used only if the browser is not up yet)
 *   plus session options (`stealth`, `isolated`, `timeoutMs`, `acceptLanguage`)
 * @param {(session: BrowserSession) => Promise<T>} body
 */
export async function withPooledSession(options = {}, body) {
  let launched = await acquireBrowser(options);
  active += 1;
  let session;
  try {
    const open = () => BrowserSession.open({
      endpoint: launched.endpoint,
      identity: options.identity ?? launched.identity,
      stealth: options.stealth !== false,
      isolated: options.isolated,
      timeoutMs: options.timeoutMs,
      acceptLanguage: options.acceptLanguage,
      spoofWebgl: options.spoofWebgl,
    });
    try {
      session = await open();
    } catch (err) {
      // The shared browser died between acquire and attach — a crash, or an
      // idle shutdown that raced us. Relaunch once rather than failing a task
      // for a lifecycle problem it did not cause.
      if (browser === launched) browser = null;
      try { launched.close(); } catch { /* already gone */ }
      launched = await acquireBrowser(options);
      session = await open();
    }
    return await body(session);
  } finally {
    if (session) { try { await session.close(); } catch { /* best effort */ } }
    active -= 1;
    scheduleIdleShutdown();
  }
}

/** Introspection for tests and diagnostics. */
export function poolStatus() {
  return { up: Boolean(browser), pid: browser?.pid ?? null, active, idleMs: IDLE_MS };
}
