// Minimal RFC 6455 WebSocket server (no dependencies). Text frames only; client frames must be masked; fragmentation supported.
import { createHash } from 'node:crypto';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const decoder = new TextDecoder('utf-8', { fatal: true });

export class Conn {
  constructor(socket, opts) {
    this.socket = socket; this.opts = opts; this.buf = Buffer.alloc(0); this.frag = []; this.fragLen = 0; this.fragOp = 0;
    this.closed = false; this.ip = opts.ip; this.origin = opts.origin; this.lastRx = Date.now();
    this.onmessage = () => {}; this.onclose = () => {};
    this.bucket = opts.burst; this.bucketAt = Date.now();
    socket.setNoDelay(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed(1006));
    socket.on('error', () => this._closed(1006));
  }
  _closed(code) { if (this.closed) return; this.closed = true; clearInterval(this._hb); try { this.socket.destroy(); } catch {} this.onclose(code); }
  startHeartbeat(everyMs = 15000, idleMs = 45000) {
    this._hb = setInterval(() => {
      if (Date.now() - this.lastRx > idleMs) return this.close(4000, 'idle');
      this._frame(0x9, Buffer.alloc(0));
    }, everyMs); this._hb.unref?.();
  }
  _data(d) {
    if (this.closed) return;
    this.lastRx = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > Math.max(65536, this.opts.maxPayload * 8)) return this.close(1009, 'too big');
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, rsv = b[0] & 0x70, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (rsv) return this.close(1002, 'rsv');
      if (!masked) return this.close(1002, 'unmasked');
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2); if (hi) return this.close(1009, 'too big'); len = b.readUInt32BE(6); off = 10; }
      if (op >= 8 && (len > 125 || !fin)) return this.close(1002, 'bad control');
      if (len > this.opts.maxPayload) return this.close(1009, 'too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (!this._frameIn(fin, op, payload)) return;
    }
  }
  _frameIn(fin, op, payload) {
    if (op === 0x8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; this._frame(0x8, payload.subarray(0, 2)); this._closed(code); return false; }
    if (op === 0x9) { this._frame(0xA, payload); return true; }
    if (op === 0xA) return true;
    if (op === 0x2) { this.close(1003, 'binary not supported'); return false; }
    if (op === 0x1 || op === 0x0) {
      if (op === 0x1) { if (this.frag.length) { this.close(1002, 'bad fragment'); return false; } this.fragOp = 1; }
      else if (!this.frag.length) { this.close(1002, 'bad continuation'); return false; }
      this.frag.push(payload); this.fragLen += payload.length;
      if (this.fragLen > this.opts.maxPayload) { this.close(1009, 'too big'); return false; }
      if (!fin) return true;
      const whole = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag); this.frag = []; this.fragLen = 0;
      let text; try { text = decoder.decode(whole); } catch { this.close(1007, 'bad utf8'); return false; }
      // per-connection rate limit (token bucket)
      const now = Date.now(); this.bucket = Math.min(this.opts.burst, this.bucket + (now - this.bucketAt) * this.opts.ratePerSec / 1000); this.bucketAt = now;
      if (--this.bucket < 0) { this.close(4008, 'rate limit'); return false; }
      try { this.onmessage(text); } catch (e) { this.opts.onError?.(e); }
      return !this.closed;
    }
    this.close(1002, 'bad opcode'); return false;
  }
  _frame(op, payload) {
    if (this.closed || !this.socket.writable) return;
    const n = payload.length; let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(n, 6); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(text) {
    if (this.closed) return false;
    if (this.socket.writableLength > 1_000_000) { this.close(1013, 'slow consumer'); return false; }   // never buffer without limit
    this._frame(0x1, Buffer.from(text, 'utf8')); return true;
  }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 100)), p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._frame(0x8, p);
    setTimeout(() => this._closed(code), 50).unref?.();
  }
}

/** Attach to a Node http.Server. `accept(req)` may return false to refuse with 403. */
export function attachWebSocket(server, opts, onConnection) {
  server.on('upgrade', (req, socket) => {
    const reject = (code, msg) => { try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {} socket.destroy(); };
    const key = req.headers['sec-websocket-key'];
    if (req.method !== 'GET' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') return reject(400, 'Bad Request');
    if (!key || Buffer.from(key, 'base64').length !== 16) return reject(400, 'Bad Request');
    const ip = (opts.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '';
    if (opts.accept && !opts.accept(req, ip)) return reject(403, 'Forbidden');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new Conn(socket, { maxPayload: opts.maxPayload || 4096, burst: opts.burst || 120, ratePerSec: opts.ratePerSec || 80, ip, origin: req.headers.origin || '', onError: opts.onError });
    conn.startHeartbeat(opts.heartbeatMs, opts.idleMs);
    onConnection(conn, req);
  });
}
