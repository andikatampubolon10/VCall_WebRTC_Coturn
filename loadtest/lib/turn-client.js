/**
 * Minimal TURN client (RFC 5389 STUN + RFC 5766 TURN, UDP transport).
 *
 * Implements exactly what a browser's ICE agent does against CoTURN:
 *   Allocate (unauthenticated -> 401 -> authenticated with long-term credential)
 *   CreatePermission, ChannelBind, ChannelData (media), Refresh (lifetime=0 to release)
 *
 * One TurnClient = one UDP socket = one 5-tuple = one allocation (like one browser peer).
 */
'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MAGIC = 0x2112a442;

const MSG = {
  ALLOCATE: 0x0003,
  REFRESH: 0x0004,
  CREATE_PERMISSION: 0x0008,
  CHANNEL_BIND: 0x0009,
};
const CLASS_SUCCESS = 0x0100;
const CLASS_ERROR = 0x0110;

const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
};

// ---------- CRC32 (for FINGERPRINT) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- encoding helpers ----------
function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const b = Buffer.alloc(4 + value.length + pad);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);
  value.copy(b, 4);
  return b;
}

function xorAddress(ip, port) {
  const b = Buffer.alloc(8);
  b.writeUInt8(0, 0);
  b.writeUInt8(0x01, 1); // IPv4
  b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const parts = ip.split('.').map(Number);
  const ipInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  b.writeUInt32BE((ipInt ^ MAGIC) >>> 0, 4);
  return b;
}

function parseXorAddress(v) {
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const ipInt = (v.readUInt32BE(4) ^ MAGIC) >>> 0;
  const ip = [ipInt >>> 24, (ipInt >>> 16) & 255, (ipInt >>> 8) & 255, ipInt & 255].join('.');
  return { ip, port };
}

function parseMessage(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0) return null;
  if (buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const txId = buf.subarray(8, 20).toString('hex');
  const attrs = {};
  let off = 20;
  const end = Math.min(buf.length, 20 + len);
  while (off + 4 <= end) {
    const at = buf.readUInt16BE(off);
    const al = buf.readUInt16BE(off + 2);
    const val = buf.subarray(off + 4, off + 4 + al);
    if (!(at in attrs)) attrs[at] = val;
    off += 4 + al + ((4 - (al % 4)) % 4);
  }
  return { type, txId, attrs };
}

function parseError(v) {
  if (!v || v.length < 4) return { code: 0, reason: '' };
  return { code: (v[2] & 0x7) * 100 + v[3], reason: v.subarray(4).toString('utf8') };
}

class TurnError extends Error {
  constructor(code, reason, method) {
    super(`TURN ${method} error ${code} ${reason}`.trim());
    this.code = code;
    this.reason = reason;
  }
}

/**
 * TurnClient
 * events: 'data' (channelOrPeerKey, payloadBuffer, recvTimeMs)
 */
class TurnClient extends EventEmitter {
  constructor({ host, port = 3478, username, password, rtoMs = 500, maxRetransmits = 6, socketBuffer = 1 << 20 }) {
    super();
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.rtoMs = rtoMs;
    this.maxRetransmits = maxRetransmits;
    this.socketBuffer = socketBuffer;
    this.realm = null;
    this.nonce = null;
    this.key = null;
    this.pending = new Map(); // txId -> {resolve, reject, timer, packet, tries}
    this.relayed = null;
    this.mapped = null;
    this.lifetime = 0;
    this.retransmits = 0; // total retransmissions (indicator of loss/overload)
    this.closed = false;
    this.channels = new Map(); // channel -> peerKey
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (m) => this._onMessage(m));
    this.socket.on('error', (e) => this.emit('socketError', e));
  }

  bind() {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(0, () => {
        this.socket.removeListener('error', reject);
        try {
          this.socket.setRecvBufferSize(this.socketBuffer);
          this.socket.setSendBufferSize(this.socketBuffer);
        } catch (_) { /* OS may cap it */ }
        resolve();
      });
    });
  }

  _onMessage(m) {
    // ChannelData: first two bits 01 (channel 0x4000-0x7FFF)
    if (m.length >= 4 && (m[0] & 0xc0) === 0x40) {
      const ch = m.readUInt16BE(0);
      const len = m.readUInt16BE(2);
      this.emit('data', ch, m.subarray(4, 4 + len));
      return;
    }
    const msg = parseMessage(m);
    if (!msg) return;
    // Data indication (0x0017) fallback path
    if (msg.type === 0x0017) {
      const d = msg.attrs[ATTR.DATA];
      if (d) this.emit('data', 0, d);
      return;
    }
    const p = this.pending.get(msg.txId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.txId);
    p.resolve(msg);
  }

  _buildRequest(method, attrs, withAuth) {
    const txId = crypto.randomBytes(12);
    let body = Buffer.concat(attrs);
    if (withAuth) {
      body = Buffer.concat([
        body,
        attr(ATTR.USERNAME, Buffer.from(this.username)),
        attr(ATTR.REALM, Buffer.from(this.realm)),
        attr(ATTR.NONCE, Buffer.from(this.nonce)),
      ]);
    }
    const header = Buffer.alloc(20);
    header.writeUInt16BE(method, 0);
    header.writeUInt32BE(MAGIC, 4);
    txId.copy(header, 8);

    let msg = Buffer.concat([header, body]);
    if (withAuth) {
      msg.writeUInt16BE(body.length + 24, 2); // length includes MESSAGE-INTEGRITY
      const hmac = crypto.createHmac('sha1', this.key).update(msg).digest();
      msg = Buffer.concat([msg, attr(ATTR.MESSAGE_INTEGRITY, hmac)]);
    }
    // FINGERPRINT
    msg.writeUInt16BE(msg.length - 20 + 8, 2);
    const fp = Buffer.alloc(4);
    fp.writeUInt32BE((crc32(msg) ^ 0x5354554e) >>> 0, 0);
    msg = Buffer.concat([msg, attr(ATTR.FINGERPRINT, fp)]);
    return { txId: txId.toString('hex'), msg };
  }

  _transact(method, attrs, withAuth) {
    if (this.closed) return Promise.reject(new Error('client closed'));
    const { txId, msg } = this._buildRequest(method, attrs, withAuth);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, tries: 0, timer: null };
      const send = () => {
        if (this.closed) { this.pending.delete(txId); return reject(new Error('client closed')); }
        if (entry.tries > this.maxRetransmits) {
          this.pending.delete(txId);
          return reject(new TurnError(0, 'Timeout (no response)', methodName(method)));
        }
        if (entry.tries > 0) this.retransmits++;
        const rto = Math.min(this.rtoMs * 2 ** entry.tries, 8000);
        entry.tries++;
        this.socket.send(msg, this.port, this.host);
        entry.timer = setTimeout(send, rto);
      };
      this.pending.set(txId, entry);
      send();
    });
  }

  /** Authenticated request with automatic 401/438 challenge handling. */
  async _authRequest(method, attrs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this._transact(method, attrs, !!this.nonce);
      if ((res.type & 0x0110) === CLASS_SUCCESS) return res;
      const err = parseError(res.attrs[ATTR.ERROR_CODE]);
      if (err.code === 401 || err.code === 438) {
        if (res.attrs[ATTR.REALM]) this.realm = res.attrs[ATTR.REALM].toString();
        if (res.attrs[ATTR.NONCE]) this.nonce = res.attrs[ATTR.NONCE].toString();
        this.key = crypto.createHash('md5').update(`${this.username}:${this.realm}:${this.password}`).digest();
        if (err.code === 401 && attempt > 0) throw new TurnError(401, 'Unauthorized (credential salah)', methodName(method));
        continue;
      }
      throw new TurnError(err.code, err.reason, methodName(method));
    }
    throw new TurnError(0, 'Auth loop', methodName(method));
  }

  async allocate(lifetimeSec = 600) {
    const transport = Buffer.from([17, 0, 0, 0]); // UDP
    const lt = Buffer.alloc(4); lt.writeUInt32BE(lifetimeSec, 0);
    const res = await this._authRequest(MSG.ALLOCATE, [
      attr(ATTR.REQUESTED_TRANSPORT, transport),
      attr(ATTR.LIFETIME, lt),
    ]);
    const r = res.attrs[ATTR.XOR_RELAYED_ADDRESS];
    if (!r) throw new TurnError(0, 'No XOR-RELAYED-ADDRESS', 'Allocate');
    this.relayed = parseXorAddress(r);
    if (res.attrs[ATTR.XOR_MAPPED_ADDRESS]) this.mapped = parseXorAddress(res.attrs[ATTR.XOR_MAPPED_ADDRESS]);
    if (res.attrs[ATTR.LIFETIME]) this.lifetime = res.attrs[ATTR.LIFETIME].readUInt32BE(0);
    return this.relayed;
  }

  async createPermission(peerIp) {
    await this._authRequest(MSG.CREATE_PERMISSION, [attr(ATTR.XOR_PEER_ADDRESS, xorAddress(peerIp, 0))]);
  }

  async channelBind(channel, peerIp, peerPort) {
    const ch = Buffer.alloc(4); ch.writeUInt16BE(channel, 0);
    await this._authRequest(MSG.CHANNEL_BIND, [
      attr(ATTR.CHANNEL_NUMBER, ch),
      attr(ATTR.XOR_PEER_ADDRESS, xorAddress(peerIp, peerPort)),
    ]);
    this.channels.set(channel, `${peerIp}:${peerPort}`);
  }

  /** Send a ChannelData frame (this is how browsers send media through TURN). */
  sendChannelData(channel, payload) {
    if (this.closed) return;
    const hdr = Buffer.allocUnsafe(4);
    hdr.writeUInt16BE(channel, 0);
    hdr.writeUInt16BE(payload.length, 2);
    this.socket.send([hdr, payload], this.port, this.host);
  }

  /** Release allocation (Refresh with LIFETIME=0) and close socket. */
  async release() {
    if (this.closed) return;
    if (this.relayed && this.nonce) {
      const lt = Buffer.alloc(4); // 0
      const saveMax = this.maxRetransmits;
      this.maxRetransmits = 2;
      try { await this._authRequest(MSG.REFRESH, [attr(ATTR.LIFETIME, lt)]); } catch (_) { /* best effort */ }
      this.maxRetransmits = saveMax;
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    try { this.socket.close(); } catch (_) {}
  }
}

ATTR.DATA = 0x0013;

function methodName(m) {
  return { 3: 'Allocate', 4: 'Refresh', 8: 'CreatePermission', 9: 'ChannelBind' }[m] || `0x${m.toString(16)}`;
}

module.exports = { TurnClient, TurnError, crc32 };
