'use strict';
/*
 * Сигнализация без своего сервера.
 * Компьютеры «знакомятся» через бесплатные публичные службы (PeerJS Cloud и несколько MQTT-брокеров).
 * Все важные сообщения шифруются (ECDH P-256 + AES-GCM): службы видят только номер и открытый ключ.
 * Номер компьютера = отпечаток его открытого ключа, поэтому подделать чужой номер нельзя.
 * Само изображение и управление идут напрямую между компьютерами (WebRTC, шифрование DTLS-SRTP).
 */
const Signal = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

  let myId = null, myPubB64 = null, myPriv = null;
  const keyCache = new Map();   // pubB64 -> AES key
  const peerPubs = new Map();   // id -> pubB64
  const seen = new Map();       // uid -> ts
  const listeners = [];
  const transports = [];
  let statusCb = () => {};

  async function idFromPub(pubB64) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', unb64(pubB64)));
    let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
    return String((n % 900000000n) + 100000000n);
  }

  async function init(settings, save, testRelay) {
    let ident = settings.identity;
    if (!ident) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
      const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      ident = { pub: b64(raw), priv: jwk, token: rid(8) };
      await save({ identity: ident });
    }
    myPubB64 = ident.pub;
    myPriv = await crypto.subtle.importKey('jwk', ident.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    myId = await idFromPub(myPubB64);
    for (const [id, p] of Object.entries(settings.knownKeys || {})) peerPubs.set(id, p);

    if (testRelay) { // только для проверки разработчиком
      const [base, kind] = testRelay.split('|');
      transports.push(kind === 'mqtt' ? new MqttTransport(base + '/mqtt', myId) : new PeerJsTransport(base + '/peerjs', 'pomoshnik-' + myId, ident.token));
    } else {
      transports.push(new PeerJsTransport('wss://0.peerjs.com/peerjs', 'pomoshnik-' + myId, ident.token));
      for (const url of ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt',
                         'wss://mqtt.eclipseprojects.io:443/mqtt'])
        transports.push(new MqttTransport(url, myId));
    }
    for (const t of transports) { t.onMessage = onEnvelope; t.onStatus = reportStatus; t.start(); }
    setInterval(() => { const now = Date.now(); for (const [k, v] of seen) if (now - v > 600000) seen.delete(k); }, 60000);
    return myId;
  }
  function reportStatus() { statusCb(transports.filter(t => t.connected).length, transports.length, transports.map(t => ({ name: t.label, ok: t.connected }))); }

  async function aesKeyFor(pubB64) {
    if (keyCache.has(pubB64)) return keyCache.get(pubB64);
    const pub = await crypto.subtle.importKey('raw', unb64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, myPriv, 256);
    const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('pomoshnik-v1'), info: new Uint8Array() },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    keyCache.set(pubB64, key); return key;
  }

  function broadcast(to, env) { for (const t of transports) if (t.connected) t.send(to, env); }

  // приветствие: обмен открытыми ключами
  function hello(to, reply = false) {
    broadcast(to, { v: 1, u: rid(), k: reply ? 'hi2' : 'hi', f: myId, pub: myPubB64 });
  }
  async function send(to, inner) {
    const pub = peerPubs.get(to);
    if (!pub) throw new Error('no-key');
    const key = await aesKeyFor(pub);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    inner = Object.assign({ ts: Date.now() }, inner);
    const ad = enc.encode(myId + '>' + to);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, enc.encode(JSON.stringify(inner)));
    broadcast(to, { v: 1, u: rid(), k: 'e', f: myId, iv: b64(iv), ct: b64(ct) });
  }
  const keyWaiters = new Map();
  function waitKey(id, ms) {
    if (peerPubs.has(id)) return Promise.resolve(true);
    return new Promise((res) => {
      const t = setTimeout(() => { keyWaiters.delete(id); res(false); }, ms);
      keyWaiters.set(id, () => { clearTimeout(t); keyWaiters.delete(id); res(true); });
    });
  }

  async function onEnvelope(env) {
    try {
      if (!env || env.v !== 1 || !env.u || seen.has(env.u)) return;
      seen.set(env.u, Date.now());
      if (typeof env.f !== 'string' || env.f === myId) return;
      if (env.k === 'hi' || env.k === 'hi2') {
        if (typeof env.pub !== 'string' || (await idFromPub(env.pub)) !== env.f) return; // номер не совпадает с ключом
        const isNew = peerPubs.get(env.f) !== env.pub;
        peerPubs.set(env.f, env.pub);
        if (isNew) emit({ t: '_key', from: env.f, pub: env.pub });
        if (env.k === 'hi') hello(env.f, true);
        const w = keyWaiters.get(env.f); if (w) w();
        return;
      }
      if (env.k === 'e') {
        const pub = peerPubs.get(env.f);
        if (!pub) { hello(env.f); return; }
        const key = await aesKeyFor(pub);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: enc.encode(env.f + '>' + myId) }, key, unb64(env.ct));
        const inner = JSON.parse(dec.decode(pt));
        if (Math.abs(Date.now() - (inner.ts || 0)) > 30 * 60 * 1000) return; // слишком старое
        inner.from = env.f;
        emit(inner);
      }
    } catch (e) { /* чужое или испорченное сообщение — игнорируем */ }
  }
  function emit(m) { for (const l of listeners) { try { l(m); } catch (e) { console.error(e); } } }

  // ---------- PeerJS Cloud ----------
  class PeerJsTransport {
    constructor(base, pid, token) { this.base = base; this.pid = pid; this.token = token; this.connected = false; this.delay = 2000; this.label = 'PeerJS'; }
    start() {
      const url = `${this.base}?key=peerjs&id=${encodeURIComponent(this.pid)}&token=${this.token}&version=1.5.4`;
      let ws;
      try { ws = new WebSocket(url); } catch { return this.retry(); }
      this.ws = ws;
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'OPEN') { this.connected = true; this.delay = 2000; this.onStatus(); }
        else if (m.type === 'ID-TAKEN') { this.token = rid(8); }
        else if (m.type === 'OFFER' && m.payload) this.onMessage(m.payload);
      };
      ws.onclose = () => { this.connected = false; clearInterval(this.hb); this.onStatus(); this.retry(); };
      ws.onerror = () => {};
      this.hb = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"HEARTBEAT"}'); }, 5000);
    }
    retry() { setTimeout(() => this.start(), this.delay); this.delay = Math.min(this.delay * 2, 60000); }
    send(to, env) { try { this.ws.send(JSON.stringify({ type: 'OFFER', dst: 'pomoshnik-' + to, payload: env })); } catch {} }
  }

  // ---------- MQTT 3.1.1 поверх WebSocket (минимальный клиент) ----------
  class MqttTransport {
    constructor(url, id) { this.url = url; this.id = id; this.connected = false; this.delay = 2000; this.buf = new Uint8Array(0);
      const h = url.replace(/^wss?:\/\//, '').split(/[:/]/)[0]; this.label = h.split('.').slice(-2, -1)[0] || h; }
    topic(id) { return 'pomoshnik/v1/' + id; }
    static str(s) { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; }
    static len(n) { const o = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return o; }
    packet(type, body) { return new Uint8Array([type, ...MqttTransport.len(body.length), ...body]); }
    start() {
      let ws;
      try { ws = new WebSocket(this.url, ['mqtt']); } catch { return this.retry(); }
      ws.binaryType = 'arraybuffer'; this.ws = ws; this.buf = new Uint8Array(0);
      ws.onopen = () => {
        const cid = 'pm' + this.id + '-' + rid(4);
        const body = [...MqttTransport.str('MQTT'), 4, 0x02, 0, 60, ...MqttTransport.str(cid)];
        ws.send(this.packet(0x10, body));
      };
      ws.onmessage = (e) => { this.feed(new Uint8Array(e.data)); };
      ws.onclose = () => { this.connected = false; clearInterval(this.ping); this.onStatus(); this.retry(); };
      ws.onerror = () => {};
      this.ping = setInterval(() => { if (ws.readyState === 1) ws.send(new Uint8Array([0xC0, 0])); }, 30000);
    }
    retry() { setTimeout(() => this.start(), this.delay); this.delay = Math.min(this.delay * 2, 60000); }
    feed(chunk) {
      const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
      while (this.buf.length >= 2) {
        let mul = 1, len = 0, i = 1, byte;
        do { if (i >= this.buf.length) return; byte = this.buf[i++]; len += (byte & 127) * mul; mul *= 128; } while (byte & 128);
        if (this.buf.length < i + len) return;
        const type = this.buf[0], body = this.buf.subarray(i, i + len);
        this.handle(type, body);
        this.buf = this.buf.slice(i + len);
      }
    }
    handle(type, body) {
      const t = type >> 4;
      if (t === 2) { // CONNACK
        if (body[1] !== 0) return this.ws.close();
        const sub = [0, 1, ...MqttTransport.str(this.topic(this.id)), 0];
        this.ws.send(this.packet(0x82, sub));
      } else if (t === 9) { // SUBACK
        this.connected = true; this.delay = 2000; this.onStatus();
      } else if (t === 3) { // PUBLISH
        const tl = (body[0] << 8) | body[1]; let off = 2 + tl;
        if ((type >> 1) & 3) off += 2;
        try { this.onMessage(JSON.parse(dec.decode(body.subarray(off)))); } catch {}
      }
    }
    send(to, env) {
      try {
        const body = [...MqttTransport.str(this.topic(to)), ...enc.encode(JSON.stringify(env))];
        this.ws.send(this.packet(0x30, body));
      } catch {}
    }
  }

  return {
    init, hello, send, waitKey,
    get id() { return myId; },
    knownKey: (id) => peerPubs.get(id),
    on: (fn) => listeners.push(fn),
    onStatus: (fn) => { statusCb = fn; reportStatus(); },
    online: () => transports.some(t => t.connected)
  };
})();
