// Тестовый локальный ретранслятор: эмулирует PeerJS Cloud (/peerjs) и MQTT-брокер (/mqtt) для проверки.
const http = require('http'); const crypto = require('crypto');
const peers = new Map(); const subs = new Map(); // topic -> Set(sock)
function frame(data, binary) {
  const p = Buffer.isBuffer(data) ? data : Buffer.from(data); const n = p.length; let h;
  if (n < 126) h = Buffer.from([binary ? 0x82 : 0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = binary ? 0x82 : 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = binary ? 0x82 : 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function wsAccept(req, sock, onMsg, proto) {
  const key = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + (proto ? '\r\nSec-WebSocket-Protocol: ' + proto : '') + '\r\n\r\n');
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128; const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len)); if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      const op = buf[0] & 15; buf = buf.subarray(off + len);
      if (op === 8) { sock.end(); return; }
      if (op === 1 || op === 2) onMsg(payload, op === 2);
    }
  });
}
const srv = http.createServer((q, r) => { r.end('relay'); });
srv.on('upgrade', (req, sock) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/peerjs') {
    const id = u.searchParams.get('id'); peers.set(id, sock);
    wsAccept(req, sock, (p) => {
      const m = JSON.parse(p.toString());
      if (m.type === 'OFFER') { const d = peers.get(m.dst); if (d) d.write(frame(JSON.stringify({ type: 'OFFER', src: id, payload: m.payload }))); }
    });
    sock.write(frame(JSON.stringify({ type: 'OPEN' })));
    sock.on('close', () => { if (peers.get(id) === sock) peers.delete(id); }); sock.on('error', () => {});
  } else if (u.pathname === '/mqtt') {
    let mb = Buffer.alloc(0);
    const send = (b) => sock.write(frame(Buffer.from(b), true));
    wsAccept(req, sock, (p) => {
      mb = Buffer.concat([mb, p]);
      while (mb.length >= 2) {
        let mul = 1, len = 0, i = 1, b; do { b = mb[i++]; len += (b & 127) * mul; mul *= 128; } while (b & 128);
        if (mb.length < i + len) return; const type = mb[0]; const body = mb.subarray(i, i + len); mb = mb.subarray(i + len);
        const t = type >> 4;
        if (t === 1) send([0x20, 2, 0, 0]);
        else if (t === 8) { const tl = body.readUInt16BE(2); const topic = body.subarray(4, 4 + tl).toString(); if (!subs.has(topic)) subs.set(topic, new Set()); subs.get(topic).add(sock); send([0x90, 3, body[0], body[1], 0]); }
        else if (t === 3) { const tl = body.readUInt16BE(0); const topic = body.subarray(2, 2 + tl).toString(); const pk = Buffer.concat([Buffer.from([type]), encLen(len), body]); for (const s of subs.get(topic) || []) s.write(frame(pk, true)); }
        else if (t === 12) send([0xD0, 0]);
      }
    }, 'mqtt');
    sock.on('close', () => { for (const s of subs.values()) s.delete(sock); }); sock.on('error', () => {});
  } else sock.destroy();
});
function encLen(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return Buffer.from(o); }
srv.listen(8765, '127.0.0.1', () => console.log('relay on 8765'));
