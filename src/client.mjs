/**
 * Chrome DevTools Protocol client — zero dependencies.
 *
 * Wraps CDP with the handful of operations an agent actually wants (render,
 * extract, screenshot, evaluate, accessibility tree) against a local browser.
 *
 * Two entry points:
 *   withBrowser(...)  launch a hardened browser, use it, tear it down
 *   withSession(...)  attach to a browser that is already running
 */
import { MiniWebSocket } from './ws.mjs';
import { rootPicker, htmlToMarkdown } from './extract.mjs';

const DEFAULT_TIMEOUT_MS = 45000;

/** navigate()'s waitUntil vocabulary, mapped to CDP lifecycle event names. */
const LIFECYCLE = {
  domcontentloaded: 'DOMContentLoaded',
  load: 'load',
  // networkAlmostIdle (<=2 connections for 500ms) rather than networkIdle:
  // a page holding one analytics beacon or a long-poll open never reaches
  // full idle, and waiting for it turns into the timeout.
  idle: 'networkAlmostIdle',
};

export class BrowserError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'BrowserError';
    if (details) this.details = details;
  }
}

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.targetId = null;
    this.closedReason = null;
    this.events = new Map();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
      if (msg.id === undefined) {
        const listeners = this.events.get(msg.method);
        if (listeners) {
          for (const fn of listeners) {
            try { fn(msg.params ?? {}); } catch { /* a listener fault must not kill the connection */ }
          }
        }
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new BrowserError(`CDP ${entry.method} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`, msg.error));
      else entry.resolve(msg.result ?? {});
    });

    ws.on('close', () => {
      const reason = this.closedReason ?? new BrowserError('connection closed before the command completed');
      for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(reason); }
      this.pending.clear();
    });

    ws.on('error', (err) => {
      this.closedReason = err instanceof Error ? err : new BrowserError(String(err));
    });
  }

  /** Subscribe to a CDP event; returns an unsubscribe function. */
  on(method, handler) {
    const listeners = this.events.get(method) ?? new Set();
    listeners.add(handler);
    this.events.set(method, listeners);
    return () => listeners.delete(handler);
  }

  send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, sessionId, browserLevel = false } = {}) {
    const id = (this.nextId += 1);
    const payload = { id, method, params };
    // Browser-level commands (Target.*, Browser.*) must NOT carry an attached
    // page's sessionId, or the browser rejects them.
    const useSession = browserLevel ? undefined : (sessionId ?? this.sessionId);
    if (useSession) payload.sessionId = useSession;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.ws.send(JSON.stringify(payload)); } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }
}

export class BrowserSession {
  constructor(connection, ws) {
    this.connection = connection;
    this.ws = ws;
  }

  /**
   * Attach to a browser-level CDP endpoint, create an isolated context and a
   * page inside it, then enable the domains we rely on.
   *
   * @param {{endpoint: string, stealth?: boolean, identity?: object,
   *          isolated?: boolean, timeoutMs?: number, acceptLanguage?: string}} options
   */
  static async open(options = {}) {
    if (!options.endpoint) throw new BrowserError('open() requires an endpoint; use withBrowser() to launch one');
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const stealth = options.stealth !== false;

    const ws = new MiniWebSocket(options.endpoint, { handshakeTimeoutMs: timeoutMs });

    await new Promise((resolve, reject) => {
      let settled = false;
      ws.on('open', () => { if (!settled) { settled = true; resolve(); } });
      ws.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
      ws.on('close', () => {
        if (!settled) { settled = true; reject(new BrowserError('connection closed during handshake')); }
      });
    });

    const connection = new Connection(ws);
    let browserContextId;

    // An isolated context gives clean-state-per-task (no shared cookies,
    // storage or cache) without paying for a second browser process.
    if (options.isolated !== false) {
      try {
        const created = await connection.send('Target.createBrowserContext', {}, { timeoutMs, browserLevel: true });
        browserContextId = created.browserContextId;
      } catch { /* endpoint may not support contexts; fall back to the default */ }
    }

    const createParams = { url: 'about:blank' };
    if (browserContextId) createParams.browserContextId = browserContextId;
    const { targetId } = await connection.send('Target.createTarget', createParams, { timeoutMs, browserLevel: true });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs, browserLevel: true });
    connection.sessionId = sessionId;
    connection.targetId = targetId;

    const session = new BrowserSession(connection, ws);
    session.browserContextId = browserContextId;
    session.stealth = stealth;
    session.watchLifecycle();

    await connection.send('Page.enable', {}, { timeoutMs });

    // Lifecycle events turn navigation from a polling loop into an event wait.
    // They are pure CDP observation with no page-visible effect, so unlike
    // Runtime.enable they cost nothing in detectability.
    await connection.send('Page.setLifecycleEventsEnabled', { enabled: true }, { timeoutMs }).catch(() => {});

    // Runtime.enable is the loudest CDP tell — it powers the classic
    // console/Error.stack detector. Runtime.evaluate does NOT require it
    // (enable only switches on events we never consume), so stealth skips it
    // and loses nothing.
    if (!stealth) await connection.send('Runtime.enable', {}, { timeoutMs });

    // Network carries the trustworthy success/failure signal for a navigation.
    await connection.send('Network.enable', {}, { timeoutMs }).catch(() => {});
    session.#watchNetwork();

    // Optional WebGL renderer spoof. OFF by default, deliberately — see the
    // warning on buildWebglPatch(). Prefer giving the browser a real GPU.
    if (options.spoofWebgl) {
      const { vendor, renderer } = options.spoofWebgl;
      await connection.send('Page.addScriptToEvaluateOnNewDocument', {
        source: buildWebglPatch(vendor, renderer),
      }, { timeoutMs }).catch(() => {});
    }

    if (options.identity) {
      const { userAgent, metadata } = options.identity;
      // NOTE: acceptLanguage is deliberately NOT defaulted. CDP derives
      // navigator.languages by splitting that header, so a real value like
      // "en-US,en;q=0.9" yields ["en-US","en;q=0.9"] — a q-value where none can
      // legally appear, and it disagrees with what Web Workers report.
      // Detectors compare page vs worker and flag the mismatch. The --lang
      // launch flag already sets both surfaces correctly.
      await connection.send('Emulation.setUserAgentOverride', {
        userAgent,
        ...(metadata ? { userAgentMetadata: metadata } : {}),
        ...(options.acceptLanguage ? { acceptLanguage: options.acceptLanguage } : {}),
      }, { timeoutMs }).catch(() => {});
    }

    return session;
  }

  /**
   * Track page lifecycle milestones so navigate() can wait on an event instead
   * of polling document.readyState. Public only because open() calls it.
   */
  watchLifecycle() {
    this.connection.on('Page.lifecycleEvent', (params) => {
      for (const waiter of [...this.#lifecycleWaiters]) {
        // loaderId pins the wait to THIS navigation; without it a late event
        // from the previous page would satisfy the new one.
        if (waiter.loaderId && params.loaderId !== waiter.loaderId) continue;
        if (params.name !== waiter.name) continue;
        this.#lifecycleWaiters.delete(waiter);
        waiter.resolve();
      }
    });
  }

  #lifecycleWaiters = new Set();

  /**
   * Resolve when the page reaches `name` for this navigation.
   *
   * The event is the fast path. A coarse readyState poll runs alongside it as a
   * safety net for the cases that produce no lifecycle event at all — a
   * same-document (anchor) navigation, or an endpoint that ignored
   * setLifecycleEventsEnabled — so a missed event costs latency, never a hang.
   * The poll only short-circuits for 'load', which readyState can actually
   * observe; the idle milestones have no equivalent and wait for the event.
   */
  async #awaitLifecycle(name, loaderId, timeoutMs) {
    const waiter = { name, loaderId };
    const event = new Promise((resolve) => { waiter.resolve = resolve; });
    this.#lifecycleWaiters.add(waiter);
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        const reached = await Promise.race([event.then(() => true), sleep(500).then(() => false)]);
        if (reached) return true;
        if (this.lastFailure) return false;
        if (name === 'load') {
          const state = await this.readState();
          if (state.readyState === 'complete') return true;
        }
        if (Date.now() >= deadline) return false;
      }
    } finally {
      this.#lifecycleWaiters.delete(waiter);
    }
  }

  #watchNetwork() {
    this.connection.on('Network.responseReceived', (params) => {
      if (params.type === 'Document') {
        this.lastDocument = {
          status: params.response?.status,
          statusText: params.response?.statusText,
          url: params.response?.url,
        };
      }
    });
    this.connection.on('Network.loadingFailed', (params) => {
      // Only main-document failures mean the page is unreachable; a blocked
      // tracker or a failed image is not a navigation failure.
      if (params.type === 'Document') {
        this.lastFailure = { errorText: params.errorText, canceled: params.canceled === true };
      }
    });
  }

  send(method, params, options) { return this.connection.send(method, params, options); }

  async setViewport({ width = 1920, height = 1080, deviceScaleFactor = 1, mobile = false } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  }

  /**
   * Navigate and wait for the page to reach a chosen milestone.
   *
   * Outcomes are classified from the Network domain rather than from
   * Page.navigate's result, which can return a normal frameId even when
   * nothing loaded. An HTTP status is returned rather than thrown, because a
   * 404 or 500 body is still a real page an agent may want to read; a hard
   * transport failure throws.
   *
   * `waitUntil` picks the milestone:
   *   'domcontentloaded'  the DOM is parsed; subresources may still be coming
   *   'load'              the load event fired (default)
   *   'idle'              plus the network has gone quiet — for a client-rendered
   *                       app whose content arrives after load
   *
   * `settleMs` is an extra fixed pause afterwards. It defaults to 0 because it
   * is a guess by construction; when a page genuinely renders late, 'idle'
   * waits for the real signal instead of a number someone picked.
   *
   * @param {{timeoutMs?: number, waitUntil?: 'domcontentloaded'|'load'|'idle',
   *          settleMs?: number, throwOnHttpError?: boolean}} [options]
   */
  async navigate(url, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitUntil = 'load',
    settleMs = 0,
    throwOnHttpError = false,
  } = {}) {
    this.lastDocument = null;
    this.lastFailure = null;

    const milestone = LIFECYCLE[waitUntil];
    if (!milestone) {
      throw new BrowserError(`unknown waitUntil: ${waitUntil} (expected ${Object.keys(LIFECYCLE).join(', ')})`);
    }

    const result = await this.send('Page.navigate', { url }, { timeoutMs });
    if (result.errorText) throw new BrowserError(`navigation to ${url} failed: ${result.errorText}`, result);

    await this.#awaitLifecycle(milestone, result.loaderId, timeoutMs);
    if (settleMs > 0) await sleep(settleMs);
    const state = await this.readState();

    if (this.lastFailure && !this.lastFailure.canceled) {
      throw new BrowserError(
        `navigation to ${url} failed: ${this.lastFailure.errorText || 'the document could not be loaded'}`,
        this.lastFailure,
      );
    }
    if (!this.lastDocument) {
      throw new BrowserError(`navigation to ${url} produced no document response — the host is unreachable or the request was blocked`);
    }

    const status = this.lastDocument.status;
    if (throwOnHttpError && typeof status === 'number' && status >= 400) {
      throw new BrowserError(`navigation to ${url} returned HTTP ${status} ${this.lastDocument.statusText ?? ''}`.trim());
    }
    return { ...state, status, statusText: this.lastDocument.statusText };
  }

  async readState() {
    const value = await this.evaluate(
      'JSON.stringify({title:document.title,url:location.href,readyState:document.readyState,'
      + 'bodyLength:document.body?(document.body.innerText||"").trim().length:0})',
    );
    try { return JSON.parse(value); } catch { return { title: '', url: '', readyState: 'unknown', bodyLength: 0 }; }
  }

  async evaluate(expression, { timeoutMs = DEFAULT_TIMEOUT_MS, awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { timeoutMs });
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'evaluation threw';
      throw new BrowserError(`page evaluation failed: ${text}`, res.exceptionDetails);
    }
    return res.result?.value;
  }

  async html() { return this.evaluate('document.documentElement.outerHTML'); }

  async text({ main = false } = {}) {
    return this.evaluate(`(${rootPicker})(${JSON.stringify(main)}).innerText`);
  }

  /**
   * @param {{main?: boolean, links?: 'inline'|'relative'|'text', maxRows?: number}} [options]
   *
   * `links` is the single biggest lever on output size: URLs are 36% of the
   * characters on a Wikipedia article and 81% on github.com/trending, so
   * 'text' roughly halves a link-dense page for any task that only reads.
   * It stays 'inline' by default, because an agent that has to navigate next
   * needs somewhere to go.
   */
  async markdown({ main = true, links = 'inline', maxRows = 60 } = {}) {
    const options = JSON.stringify({ links, maxRows });
    return this.evaluate(`(${htmlToMarkdown})((${rootPicker})(${JSON.stringify(main)}),${options})`);
  }

  /**
   * Every anchor on the page.
   * Returns {links, total, truncated} rather than a bare array so a clipped
   * result can never be mistaken for a complete one.
   */
  async links({ limit = 500 } = {}) {
    const raw = await this.evaluate(
      `(()=>{const a=Array.from(document.querySelectorAll('a[href]'));`
      + `return JSON.stringify({total:a.length,links:a.slice(0,${Number(limit)})`
      + `.map(x=>({text:(x.innerText||'').trim().slice(0,200),href:x.href}))})})()`,
    );
    try {
      const parsed = JSON.parse(raw);
      return { ...parsed, truncated: parsed.total > parsed.links.length };
    } catch { return { links: [], total: 0, truncated: false }; }
  }

  async screenshot({ format = 'png', fullPage = false, quality } = {}) {
    const params = { format };
    if (format === 'jpeg' && quality !== undefined) params.quality = quality;
    if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      }
    }
    const res = await this.send('Page.captureScreenshot', params, { timeoutMs: 60000 });
    return Buffer.from(res.data, 'base64');
  }

  async pdf(options = {}) {
    const res = await this.send('Page.printToPDF', { printBackground: true, ...options }, { timeoutMs: 60000 });
    return Buffer.from(res.data, 'base64');
  }

  /**
   * Filtered accessibility tree.
   *
   * Bounded, because the full tree is enormous: one Wikipedia article yields
   * 8137 nodes / 508 kB, roughly 127k tokens, which would swallow an agent's
   * whole context in a single call. Returns {nodes, total, truncated} so the
   * cap is visible rather than silent.
   */
  async accessibilityTree({ limit = 1500 } = {}) {
    await this.send('Accessibility.enable').catch(() => {});
    const res = await this.send('Accessibility.getFullAXTree');
    const useful = (res.nodes ?? []).map((node) => ({
      role: node.role?.value,
      name: node.name?.value,
      value: node.value?.value,
      ignored: node.ignored === true,
    })).filter((n) => !n.ignored && (n.name || n.value) && n.role !== 'none');
    const nodes = limit > 0 ? useful.slice(0, limit) : useful;
    return { nodes, total: useful.length, truncated: nodes.length < useful.length };
  }

  /**
   * Close the session. Async because the isolated context must be disposed
   * BEFORE the socket goes away, or its storage leaks into a long-lived browser.
   */
  async close() {
    const contextId = this.browserContextId;
    this.browserContextId = undefined;
    if (contextId) {
      try {
        await this.connection.send('Target.disposeBrowserContext', { browserContextId: contextId }, { timeoutMs: 5000, browserLevel: true });
      } catch { /* best effort: the browser may already be going away */ }
    }
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build an in-page patch that reports a different WebGL vendor/renderer.
 *
 * ⚠️ OFF BY DEFAULT, AND USUALLY THE WRONG TOOL. Read before enabling.
 *
 * The override itself is written carefully: a Proxy around the native
 * `getParameter` keeps `Function.prototype.toString` returning
 * "function getParameter() { [native code] }", so the shim is not visible the
 * naive way. That is not the problem.
 *
 * The problem is CONSISTENCY. Claiming a hardware GPU while the process is
 * actually rasterising through SwiftShader leaves everything else disagreeing:
 * supported extension lists, MAX_TEXTURE_SIZE and friends, shader precision
 * formats, and the pixel output of a canvas hash. Detectors cross-check exactly
 * that — `deviceandbrowserinfo` ships `isWebGLInconsistent` and
 * `hasInconsistentWebGLShaderLang` — so a lie here can convert a clean
 * `isBot: false` into a positive. This project has already been bitten three
 * times by partial spoofs that made detection EASIER, not harder.
 *
 * The right fix is to let the browser reach a real GPU (`/dev/dri`), which is
 * free and needs no lying. Use this only when that is impossible, and re-run
 * `npm run test:bot` afterwards to confirm you have not made things worse.
 */
export function buildWebglPatch(vendor, renderer) {
  const v = JSON.stringify(vendor ?? 'Google Inc. (NVIDIA Corporation)');
  const r = JSON.stringify(renderer ?? 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070 Ti/PCIe/SSE2, OpenGL 4.5)');
  return `(() => {
  const VENDOR = ${v};
  const RENDERER = ${r};
  // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
  const patch = (proto) => {
    if (!proto || !proto.getParameter) return;
    const original = proto.getParameter;
    // A Proxy forwards toString to the native target, so the shim does not
    // announce itself through Function.prototype.toString.
    proto.getParameter = new Proxy(original, {
      apply(target, thisArg, args) {
        if (args[0] === 37445) return VENDOR;
        if (args[0] === 37446) return RENDERER;
        return Reflect.apply(target, thisArg, args);
      },
    });
  };
  try { patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch (_) {}
  try { patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch (_) {}
})();`;
}

/**
 * Attach to a browser that is ALREADY running, run one body, then detach.
 * The browser keeps running; only this session's isolated context is disposed.
 *
 * @template T
 * @param {object} options must include `endpoint`
 * @param {(session: BrowserSession) => Promise<T>} body
 */
export async function withSession(options, body) {
  const session = await BrowserSession.open(options);
  try { return await body(session); } finally { await session.close(); }
}

/**
 * Launch a hardened browser, run one body, then tear the whole browser down.
 *
 * @template T
 * @param {object} options forwarded to launchBrowser plus session options
 * @param {(session: BrowserSession, browser: object) => Promise<T>} body
 */
export async function withBrowser(options = {}, body) {
  const { launchBrowser } = await import('./browser.mjs');
  const browser = await launchBrowser(options);
  try {
    const session = await BrowserSession.open({
      endpoint: browser.endpoint,
      stealth: options.stealth !== false,
      identity: options.identity ?? browser.identity,
      isolated: options.isolated,
      timeoutMs: options.timeoutMs,
      acceptLanguage: options.acceptLanguage,
      spoofWebgl: options.spoofWebgl,
    });
    try { return await body(session, browser); } finally { await session.close(); }
  } finally {
    browser.close();
  }
}
