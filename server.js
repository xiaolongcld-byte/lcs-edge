// LCS Edge Node - VLESS over WebSocket, dependency-free (no npm install required).
// Works on Render / Koyeb / Hugging Face Spaces / Railway / Fly / any Node 18+ host.
// Same wire format as the Cloudflare Pages worker, so sing-box/v2rayN clients reuse the same link.

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const UUID = (process.env.LCS_UUID || 'b8842589-bf9c-4a9b-a0c0-811e6ebaa629').toLowerCase();
const WS_PATH = process.env.LCS_PATH || '/ws-f798d2b213';

// ---------------- VLESS ----------------
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
const UUID_BYTES = uuidToBytes(UUID);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function readVless(buf) {
  if (buf.length < 18) return null;
  const ver = buf[0];
  if (!buf.slice(1, 17).equals(UUID_BYTES)) return { error: 'uuid' };
  let p = 17;
  const addonLen = buf[p]; p += 1;
  if (buf.length < p + addonLen + 4) return null;
  p += addonLen;
  const cmd = buf[p]; p += 1;
  const port = buf.readUInt16BE(p); p += 2;
  const atyp = buf[p]; p += 1;
  let host = '';
  if (atyp === 1) {
    if (buf.length < p + 4) return null;
    host = `${buf[p]}.${buf[p + 1]}.${buf[p + 2]}.${buf[p + 3]}`;
    p += 4;
  } else if (atyp === 2) {
    if (buf.length < p + 1) return null;
    const n = buf[p]; p += 1;
    if (buf.length < p + n) return null;
    host = buf.slice(p, p + n).toString('utf8');
    p += n;
  } else if (atyp === 3) {
    if (buf.length < p + 16) return null;
    const b = buf.slice(p, p + 16);
    const seg = [];
    for (let i = 0; i < 16; i += 2) seg.push(b.readUInt16BE(i).toString(16));
    host = seg.join(':');
    p += 16;
  } else {
    return { error: 'atyp' };
  }
  return { ver, cmd, host, port, rest: buf.slice(p) };
}

// ---------------- minimal RFC6455 ----------------
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsFrame(payload, opcode = 0x2) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function wsParse(buf) {
  // returns {frames:[{op,data}], rest} or null when incomplete
  const frames = [];
  let p = 0;
  while (p + 2 <= buf.length) {
    const b0 = buf[p];
    const b1 = buf[p + 1];
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = p + 2;
    if (len === 126) {
      if (off + 2 > buf.length) return null;
      len = buf.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (off + 8 > buf.length) return null;
      len = Number(buf.readBigUInt64BE(off)); off += 8;
    }
    let mask = null;
    if (masked) {
      if (off + 4 > buf.length) return null;
      mask = buf.slice(off, off + 4); off += 4;
    }
    if (off + len > buf.length) return null;
    const data = Buffer.from(buf.slice(off, off + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ op, data });
    p = off + len;
  }
  return { frames, rest: buf.slice(p) };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset=utf-8><title>edge</title><h3>ok</h3>');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || !(req.url || '').startsWith(WS_PATH)) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);

  let handshakeDone = false;
  let remote = null;
  let pending = Buffer.alloc(0);

  const send = (buf, op) => {
    if (!socket.destroyed) socket.write(wsFrame(buf, op));
  };
  const closeWith = (code, reason) => {
    const b = Buffer.alloc(2 + Buffer.byteLength(reason));
    b.writeUInt16BE(code, 0);
    b.write(reason, 2);
    send(b, 0x8);
    setTimeout(() => socket.destroy(), 120);
  };

  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const parsed = wsParse(pending);
    if (!parsed) return;
    pending = parsed.rest;
    for (const f of parsed.frames) {
      if (f.op === 0x8) { if (remote) remote.destroy(); socket.destroy(); return; }
      if (f.op === 0x9) { send(f.data, 0xa); continue; }
      if (f.op !== 0x2 && f.op !== 0x0) continue;

      if (!handshakeDone) {
        const h = readVless(f.data);
        if (!h) { pending = Buffer.concat([f.data, pending]); continue; }
        if (h.error) { closeWith(1008, h.error); return; }
        handshakeDone = true;
        remote = net.connect({ host: h.host, port: h.port }, () => {
          send(Buffer.from([h.ver, 0]));
          if (h.rest.length) remote.write(h.rest);
        });
        remote.setNoDelay(true);
        remote.on('data', (d) => send(d, 0x2));
        remote.on('error', (e) => closeWith(1011, 'err:' + e.code));
        remote.on('close', () => closeWith(1000, 'done'));
        socket.on('close', () => { if (remote) remote.destroy(); });
        socket.on('error', () => { if (remote) remote.destroy(); });
      } else if (remote && f.data.length) {
        remote.write(f.data);
      }
    }
  });

  socket.on('error', () => { if (remote) remote.destroy(); });
});

server.listen(PORT, () => console.log(`lcs-edge listening on ${PORT} path=${WS_PATH}`));
