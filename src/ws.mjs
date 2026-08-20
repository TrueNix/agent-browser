/**
 * Minimal RFC 6455 WebSocket client — zero dependencies.
 *
 * Why this exists instead of Node's global `WebSocket`:
 * the WHATWG constructor has no way to send request headers, which any
 * authenticated or proxied CDP endpoint needs, and Node does not expose
 * `undici` as an importable module. So we do the Upgrade handshake ourselves
 * over node:http(s) and frame/unframe on the raw socket. The upside is a
 * transport with zero dependencies and full control over the request.
 *
 * Scope: text frames, continuation fragments, ping/pong, close, 64-bit lengths.
 * That is everything the Chrome DevTools Protocol needs.
 */
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export class MiniWebSocket {
  /**
   * @param {string} url ws:// or wss:// endpoint
   * @param {{headers?: Record<string,string>, handshakeTimeoutMs?: number}} [options]
   */
  constructor(url, options = {}) {
    this.url = url;
    this.socket = null;
    this.closed = false;
    this.#listeners = { open: [], message: [], close: [], error: [] };

    const parsed = new URL(url);
    const secure = parsed.protocol === 'wss:';
    if (!secure && parsed.protocol !== 'ws:') {
      throw new Error(`unsupported protocol: ${parsed.protocol} (expected ws: or wss:)`);
    }

    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + GUID).digest('base64');

    // WHATWG URL keeps the brackets on an IPv6 hostname ("[::1]"), but
    // http.request needs the bare address or it fails with ENOTFOUND. The Host
    // header must keep them, so only the socket target is unwrapped. Local CDP
    // endpoints routinely bind ::1, so this path matters for local browsers.
    const socketHost = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;

    const request = (secure ? https : http).request({
      hostname: socketHost,
      port: parsed.port || (secure ? 443 : 80),
      // URL drops nothing here: CDP endpoints carry meaningful query strings
      // meaningful query strings, so path must include search.
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Host: parsed.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(options.headers || {}),
      },
    });

    const handshakeTimer = setTimeout(() => {
      request.destroy(new Error(`websocket handshake timed out after ${options.handshakeTimeoutMs ?? 30000}ms`));
    }, options.handshakeTimeoutMs ?? 30000);

    request.on('upgrade', (res, socket, head) => {
      clearTimeout(handshakeTimer);
      if (res.headers['sec-websocket-accept'] !== expectedAccept) {
        socket.destroy();
        this.#emit('error', new Error('websocket handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      if (head && head.length > 0) this.#feed(head);
      socket.on('data', (chunk) => this.#feed(chunk));
      socket.on('close', () => this.#finish());
      socket.on('error', (err) => this.#emit('error', err));
      this.#emit('open');
    });

    // A non-101 response means the endpoint rejected us (401/403/404 are the
    // interesting cases for token problems). Surface status + body, not a
    // generic socket error, so callers can tell auth failure from a network fault.
    request.on('response', (res) => {
      clearTimeout(handshakeTimer);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 2048) body += d; });
      res.on('end', () => {
        this.#emit('error', Object.assign(
          new Error(`websocket upgrade rejected: HTTP ${res.statusCode}${body ? ` — ${body.trim().slice(0, 400)}` : ''}`),
          { statusCode: res.statusCode },
        ));
        this.#finish();
      });
    });

    request.on('error', (err) => {
      clearTimeout(handshakeTimer);
      this.#emit('error', err);
      this.#finish();
    });

    request.end();
  }

  #listeners;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = null;
  #finished = false;

  on(event, handler) {
    if (!this.#listeners[event]) throw new Error(`unknown event: ${event}`);
    this.#listeners[event].push(handler);
    return this;
  }

  #emit(event, ...args) {
    for (const handler of this.#listeners[event]) {
      try { handler(...args); } catch (err) {
        if (event !== 'error') this.#emit('error', err);
      }
    }
  }

  #finish() {
    if (this.#finished) return;
    this.#finished = true;
    this.closed = true;
    this.#emit('close');
  }

  #feed(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    // Parse as many complete frames as the buffer currently holds.
    for (;;) {
      const frame = this.#readFrame();
      if (frame === null) return;
      this.#handleFrame(frame);
    }
  }

  /** @returns {{fin:boolean, opcode:number, payload:Buffer}|null} null when incomplete */
  #readFrame() {
    const buf = this.#buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame too large');
      length = Number(big);
      offset += 8;
    }

    // A conforming server never masks, but handle it rather than corrupting data.
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + length) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
    }
    this.#buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    if (opcode === OP_PING) { this.#sendFrame(OP_PONG, payload); return; }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) {
      // Echo the close frame, then let the socket teardown emit 'close'.
      try { this.#sendFrame(OP_CLOSE, payload.subarray(0, 2)); } catch { /* already gone */ }
      this.socket?.end();
      return;
    }

    if (opcode === OP_CONTINUATION) {
      if (this.#fragmentOpcode === null) { this.#emit('error', new Error('unexpected continuation frame')); return; }
      this.#fragments.push(payload);
    } else {
      if (!fin) { this.#fragmentOpcode = opcode; this.#fragments = [payload]; return; }
      this.#deliver(opcode, payload);
      return;
    }

    if (fin) {
      const complete = Buffer.concat(this.#fragments);
      const originalOpcode = this.#fragmentOpcode;
      this.#fragments = [];
      this.#fragmentOpcode = null;
      this.#deliver(originalOpcode, complete);
    }
  }

  #deliver(opcode, payload) {
    if (opcode === OP_TEXT) this.#emit('message', payload.toString('utf8'));
    else if (opcode === OP_BINARY) this.#emit('message', payload);
  }

  #sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('websocket is not open');
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const maskKey = randomBytes(4);
    maskKey.copy(header, header.length - 4);
    const masked = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ maskKey[i & 3];
    this.socket.write(Buffer.concat([header, masked]));
  }

  /** @param {string} data */
  send(data) {
    this.#sendFrame(OP_TEXT, Buffer.from(data, 'utf8'));
  }

  close() {
    if (this.closed || !this.socket) return;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1000, 0);
      this.#sendFrame(OP_CLOSE, payload);
    } catch { /* nothing to close */ }
    this.socket.end();
  }
}
