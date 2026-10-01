/**
 * A minimal RFC 6455 WebSocket server — just enough for the page's one
 * socket, and no npm dependency. It carries the terminal output, the
 * keystrokes, resizes and the transcript items both ways, in order.
 *
 * What is implemented, and nothing else:
 *   * the opening handshake (`Sec-WebSocket-Accept` = base64 sha1 of the key
 *     and the RFC's GUID); version 13 only; no subprotocols, no extensions —
 *     so no permessage-deflate, and a frame with RSV bits set is an error;
 *   * client frames MUST be masked (§5.1) — an unmasked one closes with 1002;
 *   * text messages, fragmented or not, checked to be valid UTF-8 (1007);
 *     binary is refused (1003); a message over `maxMessage` closes with 1009;
 *   * ping is answered with pong, a pong is noted, close is echoed (§5.5.1);
 *     control frames must be final and at most 125 bytes;
 *   * a keepalive ping every `pingMs`, and a peer that has not answered
 *     anything for two intervals is dropped;
 *   * backpressure is REPORTED, not hidden: `send()` returns what
 *     `socket.write()` returned, `buffered` is the socket's queue, and
 *     `onDrain` fires when it empties — the caller decides what to hold back.
 *
 * Server frames are never masked and never fragmented.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The largest message a client may send. Input is capped at 256 KiB
 *  (`MAX_INPUT`) and JSON-escaping can grow it, so 1 MiB, the same bound
 *  every POST body had. */
export const MAX_MESSAGE = 1 << 20;

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64');
}

/** One unmasked server frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 0x10000) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, body]);
}

/** A masked client frame — what a browser sends. For tests and for anyone
 *  who needs to speak to this server from node. */
export function encodeClientFrame(opcode, payload = Buffer.alloc(0),
                                  { fin = true, mask = Buffer.from([1, 2, 3, 4]) } = {}) {
  const body = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(String(payload), 'utf8');
  const frame = encodeFrame(opcode, body);
  const headLen = frame.length - body.length;
  const head = Buffer.from(frame.subarray(0, headLen));
  if (!fin) head[0] &= 0x7f;
  head[1] |= 0x80;
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A protocol violation: the close code the RFC assigns to it, and why. */
class WsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Incremental parser for CLIENT frames. `push(chunk)` may be called with any
 * slicing of the byte stream; complete frames are handed to `onFrame` as
 * `{opcode, fin, payload}` with the mask already removed. Throws a `WsError`
 * on a violation — the connection turns it into a close frame.
 */
export class FrameParser {
  constructor({ onFrame, maxFrame = MAX_MESSAGE } = {}) {
    this.onFrame = onFrame;
    this.maxFrame = maxFrame;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      if (b[0] & 0x70) throw new WsError(1002, 'reserved bits set (no extension was negotiated)');
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxFrame)) throw new WsError(1009, 'frame too large');
        len = Number(big);
        off = 10;
      }
      if (!masked) throw new WsError(1002, 'client frames must be masked');
      if (opcode >= 0x8) {
        if (!fin) throw new WsError(1002, 'a control frame must not be fragmented');
        if (len > 125) throw new WsError(1002, 'a control frame carries at most 125 bytes');
      }
      if (len > this.maxFrame) throw new WsError(1009, 'frame too large');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i += 1) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this.onFrame({ opcode, fin, payload });
    }
  }
}

/**
 * One accepted connection. Callbacks, not an EventEmitter: exactly one owner
 * consumes it (`socket.mjs`).
 */
export class WsConnection {
  constructor(socket, { maxMessage = MAX_MESSAGE, pingMs = 25000 } = {}) {
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.open = true;
    this.onMessage = null;      // (text) => void
    this.onClose = null;        // (code, reason) => void
    this._drain = new Set();
    this._frag = null;          // {chunks, size} while a message is fragmented
    this._closeSent = false;
    this._seen = Date.now();
    this.parser = new FrameParser({ maxFrame: maxMessage, onFrame: (f) => this._frame(f) });
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => {
      this._seen = Date.now();
      try { this.parser.push(chunk); }
      catch (err) { this.close(err.code || 1002, err.message); }
    });
    socket.on('drain', () => { for (const fn of [...this._drain]) fn(); });
    socket.on('close', () => this._gone(1006, 'connection lost'));
    socket.on('error', () => this._gone(1006, 'socket error'));
    this._ping = setInterval(() => {
      if (Date.now() - this._seen > pingMs * 2) { socket.destroy(); return; }
      this._write(OP.PING, Buffer.alloc(0));
    }, pingMs);
    this._ping.unref?.();
  }

  /** Bytes queued in the socket and not yet taken by the kernel. */
  get buffered() { return this.socket.writableLength || 0; }

  /** Run `fn` each time the socket's queue drains; returns an unsubscribe. */
  onDrain(fn) {
    this._drain.add(fn);
    return () => this._drain.delete(fn);
  }

  /** Send one text message. The return value is `socket.write()`'s: false
   *  means the queue is past its high-water mark — see `buffered`. */
  send(text) {
    if (!this.open) return false;
    return this._write(OP.TEXT, Buffer.from(String(text), 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    if (!this._closeSent) {
      this._closeSent = true;
      const why = Buffer.from(String(reason).slice(0, 100), 'utf8');
      const body = Buffer.alloc(2 + why.length);
      body.writeUInt16BE(code, 0);
      why.copy(body, 2);
      this._write(OP.CLOSE, body);
    }
    // the peer answers with its own close; one that does not is not waited for
    const t = setTimeout(() => this.socket.destroy(), 1000);
    t.unref?.();
    this.socket.end();
    this._gone(code, reason);
  }

  _write(opcode, payload) {
    if (this.socket.destroyed) return false;
    try { return this.socket.write(encodeFrame(opcode, payload)); }
    catch { return false; }
  }

  _gone(code, reason) {
    if (!this.open) return;
    this.open = false;
    clearInterval(this._ping);
    this._drain.clear();
    try { this.onClose?.(code, reason); } catch { /* the owner's problem */ }
  }

  _frame({ opcode, fin, payload }) {
    if (!this.open) return;
    if (opcode === OP.PING) { this._write(OP.PONG, payload); return; }
    if (opcode === OP.PONG) return;
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      // echo a sane code back, per §5.5.1; 1005/1006/1015 are never sent
      const echo = [1005, 1006, 1015].includes(code) || code < 1000 ? 1000 : code;
      this.close(echo, 'closing');
      return;
    }
    if (opcode === OP.BINARY) throw new WsError(1003, 'only text messages are accepted');
    if (opcode === OP.TEXT) {
      if (this._frag) throw new WsError(1002, 'a new message began inside a fragmented one');
      if (fin) { this._text(payload); return; }
      this._frag = { chunks: [payload], size: payload.length };
      return;
    }
    if (opcode === OP.CONT) {
      if (!this._frag) throw new WsError(1002, 'a continuation frame with nothing to continue');
      this._frag.size += payload.length;
      if (this._frag.size > this.maxMessage) throw new WsError(1009, 'message too large');
      this._frag.chunks.push(payload);
      if (!fin) return;
      const whole = Buffer.concat(this._frag.chunks);
      this._frag = null;
      this._text(whole);
      return;
    }
    throw new WsError(1002, `unknown opcode ${opcode}`);
  }

  _text(buf) {
    let text;
    try { text = utf8.decode(buf); }
    catch { throw new WsError(1007, 'a text message that is not UTF-8'); }
    try { this.onMessage?.(text); } catch { /* one bad handler must not kill the socket */ }
  }
}

/**
 * Answer an HTTP `upgrade` with the handshake, or refuse it with a plain
 * HTTP status. Returns the connection, or null when it was refused.
 */
export function acceptUpgrade(req, socket, head, opts = {}) {
  const refuse = (status, text) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n`
      + 'Content-Length: 0\r\n\r\n');
    return null;
  };
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || !/\bupgrade\b/.test(connection)) {
    return refuse(400, 'Bad Request');
  }
  if (req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n'
      + 'Connection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    return refuse(400, 'Bad Request');
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
    + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  const conn = new WsConnection(socket, opts);
  if (head && head.length) socket.emit('data', head);
  return conn;
}
