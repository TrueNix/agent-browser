/**
 * A resident browser, shared by every CLI invocation.
 *
 * WHY
 * ---
 * Each CLI call is its own process, so it cannot reuse anything: it pays a cold
 * Chrome launch every time, and ten concurrent calls mean ten browsers. Measured:
 *
 *   3 lookups, cold invocations       5889 ms
 *   3 lookups, one warm browser       3166 ms      (~908 ms/call)
 *   10 concurrent calls, no daemon    ~138 Chrome processes at peak
 *
 * The daemon holds one browser and hands out its CDP endpoint. Clients still
 * open their own isolated context, so isolation is exactly what it was.
 *
 * DESIGN NOTES, each one a failure mode this had to survive
 * ---------------------------------------------------------
 *  1. SINGLE INSTANCE without a lockfile. Ten first-callers will all fail to
 *     connect and all spawn a daemon; nine of those lose the race to bind the
 *     socket, see EADDRINUSE and exit quietly, and their clients retry the
 *     connect. Binding the socket IS the lock, so there is no lockfile to go
 *     stale.
 *  2. THE OPEN SOCKET IS THE REFCOUNT. A client holds its connection for the
 *     duration of its work. That means a client killed with SIGKILL still
 *     decrements — the kernel closes the socket — where a "please release"
 *     message would have leaked a reference forever.
 *  3. IDLE EXIT. No clients for the idle window and the daemon shuts the browser
 *     down and exits, so it does not sit on ~420 MB between conversations.
 *  4. A SIGKILLED DAEMON still cannot strand a browser: the profile's owner
 *     marker names the daemon's pid, so reapAbandoned() collects it on the next
 *     launch, same as any other hard kill.
 */
import { createServer, connect } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const IDLE_MS = Number(process.env.AGENT_BROWSER_DAEMON_IDLE_MS ?? 300000);
const START_TIMEOUT_MS = 20000;

/**
 * Per-user socket, so two accounts on one host never collide.
 * AGENT_BROWSER_DAEMON_SOCKET overrides it — the tests use that so they can
 * exercise the daemon without stopping one the developer is actually using.
 */
export function socketPath() {
  if (process.env.AGENT_BROWSER_DAEMON_SOCKET) return process.env.AGENT_BROWSER_DAEMON_SOCKET;
  if (process.platform === 'win32') return '\\\\.\\pipe\\agent-browser-daemon';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  return join(tmpdir(), `agent-browser-daemon-${uid}.sock`);
}

function request(op, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath());
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('daemon did not answer')); }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ op })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      let message;
      try { message = JSON.parse(buffer.slice(0, nl)); }
      catch (err) { socket.destroy(); reject(err); return; }
      resolve({ message, socket });
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const notRunning = (err) => ['ENOENT', 'ECONNREFUSED'].includes(err?.code);

/** Ask a running daemon for its status. Returns null when none is listening. */
export async function daemonStatus() {
  try {
    const { message, socket } = await request('status');
    socket.end();
    return message;
  } catch (err) {
    if (notRunning(err)) return null;
    throw err;
  }
}

/** Ask a running daemon to shut down. Returns false when none is listening. */
export async function stopDaemon() {
  try {
    const { socket } = await request('stop');
    socket.end();
    return true;
  } catch (err) {
    if (notRunning(err)) return false;
    throw err;
  }
}

function spawnDetached() {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'daemon'], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Get the shared browser's endpoint, starting the daemon if it is not up.
 * Hold the returned socket open for as long as you are using the endpoint.
 */
export async function acquire({ autostart = true, timeoutMs = START_TIMEOUT_MS } = {}) {
  try {
    const { message, socket } = await request('acquire');
    if (message.error) { socket.end(); throw new Error(message.error); }
    return { endpoint: message.endpoint, release: () => socket.end() };
  } catch (err) {
    if (!notRunning(err) || !autostart) throw err;
  }

  spawnDetached();
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    try {
      const { message, socket } = await request('acquire');
      if (message.error) { socket.end(); throw new Error(message.error); }
      return { endpoint: message.endpoint, release: () => socket.end() };
    } catch (err) { lastError = err; if (!notRunning(err)) throw err; }
  }
  throw new Error(`daemon did not come up within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

/**
 * Run `body` against a session on the daemon's browser, in its own isolated
 * context. Drop-in for withBrowser/withSession.
 */
export async function withDaemonSession(options = {}, body) {
  const { BrowserSession } = await import('./client.mjs');
  const { endpoint, release } = await acquire(options);
  let session;
  try {
    session = await BrowserSession.open({
      endpoint,
      stealth: options.stealth !== false,
      isolated: options.isolated,
      timeoutMs: options.timeoutMs,
      acceptLanguage: options.acceptLanguage,
    });
    return await body(session);
  } finally {
    if (session) { try { await session.close(); } catch { /* best effort */ } }
    release();
  }
}

/** Remove a socket file left behind by a daemon that died without cleaning up. */
async function clearStaleSocket() {
  const path = socketPath();
  if (process.platform === 'win32' || !existsSync(path)) return;
  try {
    const { socket } = await request('status', 1500);
    socket.end();
    // Something answered — a live daemon owns this socket.
  } catch (err) {
    if (notRunning(err)) { try { unlinkSync(path); } catch { /* raced */ } }
  }
}

/**
 * Run the daemon in the foreground. Resolves when it shuts down.
 * Exits quietly if another daemon already holds the socket.
 */
export async function runDaemon({ idleMs = IDLE_MS, launch = {} } = {}) {
  await clearStaleSocket();

  // BIND BEFORE LAUNCHING. Ten first-callers spawn ten daemons; nine lose this
  // race. If the browser were launched first they would each pay a full Chrome
  // launch before finding out — measured as a peak of 80 processes for what
  // should be one browser. Losing the bind now costs nothing.
  const server = createServer();
  const listening = await new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') process.stderr.write(`agent-browser daemon: ${err.message}\n`);
      resolve(false);
    });
    server.listen(socketPath(), () => resolve(true));
  });
  if (!listening) return;   // another daemon owns the socket; nothing to clean up

  let browser = null;
  const browserReady = launchBrowser({ headless: true, gpu: 'auto', ...launch })
    .then((b) => { browser = b; return b; });
  let clients = 0;
  let idleTimer = null;
  let stopping = false;

  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    if (idleTimer) clearTimeout(idleTimer);
    try { server.close(); } catch { /* already closing */ }
    try { browser?.close(); } catch { /* already gone */ }
    if (process.platform !== 'win32') { try { unlinkSync(socketPath()); } catch { /* already gone */ } }
    process.stderr.write(`agent-browser daemon: ${reason}\n`);
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (clients > 0 || idleMs <= 0) return;
    idleTimer = setTimeout(() => { if (clients === 0) shutdown('idle, shutting down'); }, idleMs);
  };

  server.on('connection', (socket) => {
    let counted = false;
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let op;
        try { op = JSON.parse(line).op; } catch { continue; }

        if (op === 'acquire') {
          if (!counted) { counted = true; clients += 1; if (idleTimer) clearTimeout(idleTimer); }
          // Clients arriving during startup wait for the browser rather than
          // being turned away to start one of their own.
          try {
            const ready = await browserReady;
            socket.write(`${JSON.stringify({ endpoint: ready.endpoint, pid: process.pid })}\n`);
          } catch (err) {
            socket.write(`${JSON.stringify({ error: `browser failed to start: ${err.message}` })}\n`);
            shutdown('browser failed to start');
          }
        } else if (op === 'status') {
          socket.write(`${JSON.stringify({ pid: process.pid, clients, endpoint: browser?.endpoint ?? null, idleMs, browserPid: browser?.pid ?? null, starting: browser === null })}\n`);
        } else if (op === 'stop') {
          socket.write(`${JSON.stringify({ stopping: true })}\n`);
          setTimeout(() => shutdown('stopped on request'), 50);
        }
      }
    });
    // The socket closing IS the release, so a client killed with SIGKILL still
    // decrements. Nothing depends on a well-behaved goodbye.
    const done = () => { if (counted) { counted = false; clients -= 1; armIdle(); } };
    socket.on('close', done);
    socket.on('error', done);
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { shutdown(`received ${signal}`); process.exit(0); });
  }
  await browserReady.catch(() => {});
  process.stderr.write(`agent-browser daemon: ready on ${socketPath()} (browser pid ${browser?.pid}, idle ${idleMs}ms)\n`);
  armIdle();

  await new Promise((resolve) => server.on('close', resolve));
}
