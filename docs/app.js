'use strict';
/* global Signal, api */
const $ = (s) => document.querySelector(s);
const fmtId = (id) => String(id).replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
const cleanId = (s) => String(s || '').replace(/\D/g, '');
const fmtSize = (b) => b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' КБ' : b < 1024 ** 3 ? (b / 1048576).toFixed(1) + ' МБ' : (b / 1024 ** 3).toFixed(2) + ' ГБ';
const fmtTime = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = {};           // настройки
let INFO = {};
const QUALITY = {
  eco:    { label: 'Экономно',  w: 1366, h: 800,  fps: 8,  kbps: 700 },
  normal: { label: 'Обычно',    w: 1920, h: 1200, fps: 15, kbps: 2000 },
  sharp:  { label: 'Чётко',     w: 2560, h: 1600, fps: 24, kbps: 4500 }
};
const REC = {
  small:  { label: 'Компактно (≈2 МБ/мин)', kbps: 300 },
  good:   { label: 'Хорошо (≈4 МБ/мин)',     kbps: 550 },
  best:   { label: 'Отлично (≈8 МБ/мин)',    kbps: 1100 }
};

function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.sipnet.ru:3478' }
  ];
  if (S.turn && S.turn.urls) list.push({ urls: S.turn.urls.split(/[\s,]+/).filter(Boolean), username: S.turn.username || '', credential: S.turn.credential || '' });
  return list;
}

// ---------- мелочи интерфейса ----------
function toast(text, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = text;
  $('#toasts').appendChild(t); setTimeout(() => t.classList.add('out'), 4200); setTimeout(() => t.remove(), 4700);
}
function show(view) { for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== view; document.body.dataset.view = view; }
function modal(id, on) { $(id).hidden = !on; }
function beep() {
  try {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); setTimeout(() => { o.frequency.value = 1175; }, 180); setTimeout(() => { o.stop(); ctx.close(); }, 380);
  } catch {}
}
async function save(patch) { S = await api.setSettings(patch); }

// ---------- сеанс ----------
let sess = null; // { role, sid, peer, peerName, pc, ctl, file, stream, ... }

function newPc() {
  const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
  pc.onicecandidate = (e) => { if (e.candidate && sess && sess.pc === pc) Signal.send(sess.peer, { t: 'ice', sid: sess.sid, c: e.candidate.toJSON() }).catch(() => {}); };
  return pc;
}
function addRemoteIce(c) {
  if (!sess) return;
  if (!sess.pc || !sess.pc.remoteDescription) { (sess.pendingIce = sess.pendingIce || []).push(c); return; }
  sess.pc.addIceCandidate(c).catch(() => {});
}
async function flushIce() { for (const c of (sess.pendingIce || [])) await sess.pc.addIceCandidate(c).catch(() => {}); sess.pendingIce = []; }

function watchConnection(pc, onUp) {
  let upOnce = false, restartTimer = null, deadTimer = null;
  const armDead = () => { if (!deadTimer) deadTimer = setTimeout(() => { if (sess && sess.pc === pc && pc.connectionState !== 'connected') endSession('Связь потеряна. Попробуйте подключиться заново.', true); }, 45000); };
  pc.onconnectionstatechange = () => {
    if (!sess || sess.pc !== pc) return;
    const st = pc.connectionState;
    if (st === 'connected') { clearTimeout(restartTimer); clearTimeout(deadTimer); deadTimer = null; sess.restarts = 0; setConnBadge(''); if (!upOnce) { upOnce = true; onUp(); } }
    else if (st === 'disconnected') { setConnBadge('Связь пропала, восстанавливаем…'); restartTimer = setTimeout(() => tryIceRestart(), 4000); armDead(); }
    else if (st === 'failed') {
      if (!upOnce) { endSession('Не удалось установить прямое соединение между компьютерами. Попробуйте ещё раз; если не выходит — смотрите раздел «Если не подключается» в инструкции.', true); }
      else { setConnBadge('Связь пропала, восстанавливаем…'); tryIceRestart(); armDead(); }
    }
  };
  setTimeout(() => {
    if (sess && sess.pc === pc && !upOnce) endSession('Компьютеры не смогли соединиться за 30 секунд. Проверьте интернет и попробуйте ещё раз.', true);
  }, 30000);
}
async function tryIceRestart() {
  if (!sess || sess.role !== 'host' || !sess.pc) return;
  if ((sess.restarts = (sess.restarts || 0) + 1) > 5) return endSession('Связь с помощником потеряна.');
  try {
    const offer = await sess.pc.createOffer({ iceRestart: true });
    await sess.pc.setLocalDescription(offer);
    await Signal.send(sess.peer, { t: 'offer', sid: sess.sid, sdp: sess.pc.localDescription.toJSON(), restart: true });
  } catch {}
}
function setConnBadge(t) { const b = $('#connBadge'); if (!b) return; b.textContent = t; b.hidden = !t; }

async function endSession(reason, isError, notifyPeer = true) {
  if (!sess) return;
  const s = sess; sess = null;
  if (notifyPeer) Signal.send(s.peer, { t: 'bye', sid: s.sid }).catch(() => {});
  if (s.recorder) await stopRecording(s);
  try { s.pc && s.pc.close(); } catch {}
  if (s.stream) s.stream.getTracks().forEach(t => t.stop());
  clearInterval(s.statsTimer); clearTimeout(s.reqTimer);
  if (s.role === 'host') { await api.hostStop(); }
  if (s.role === 'viewer') { releaseKeys(); api.fullscreen(false); api.viewerMode(false); }
  modal('#incoming', false); modal('#waiting', false);
  show('home');
  if (reason) toast(reason, isError ? 'err' : '');
}

// ========== СТОРОНА ПОМОЩНИКА (кто подключается) ==========
async function connectTo(rawId) {
  const id = cleanId(rawId);
  if (id.length !== 9) return toast('Номер должен состоять из 9 цифр', 'err');
  if (id === Signal.id) return toast('Это номер вашего же компьютера 🙂', 'err');
  if (sess) return toast('Сначала завершите текущее подключение', 'err');
  if (!Signal.online()) return toast('Нет связи с интернетом. Проверьте подключение.', 'err');
  sess = { role: 'viewer', sid: crypto.randomUUID(), peer: id, peerName: contactLabel(id) || fmtId(id) };
  $('#waitText').textContent = 'Ищем компьютер ' + fmtId(id) + '…';
  modal('#waiting', true);
  Signal.hello(id);
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) { if (i) Signal.hello(id); ok = await Signal.waitKey(id, 4000); if (!sess || sess.peer !== id) return; }
  if (!sess || sess.peer !== id) return;
  if (!ok) return endSession('Компьютер с номером ' + fmtId(id) + ' сейчас не в сети. Убедитесь, что там включён компьютер и запущен «Помощник».', true, false);
  $('#waitText').textContent = 'Ждём, пока на том компьютере нажмут «Разрешить»…';
  await Signal.send(id, { t: 'req', sid: sess.sid, name: S.name || INFO.user || 'Помощник', computer: INFO.computer });
  sess.reqTimer = setTimeout(() => { if (sess && sess.sid && !sess.pc) endSession('Никто не ответил на запрос подключения.', true); }, 75000);
}
function cancelConnect() { if (sess && sess.role === 'viewer') { Signal.send(sess.peer, { t: 'cancel', sid: sess.sid }).catch(() => {}); endSession('', false, false); } }

async function viewerOnAccept(m) {
  clearTimeout(sess.reqTimer);
  sess.peerName = m.name || sess.peerName;
  sess.screens = m.screens || []; sess.curScreen = m.cur;
  rememberContact(sess.peer, m.name);
  $('#waitText').textContent = 'Разрешили! Соединяемся…';
}
async function viewerOnOffer(m) {
  if (!sess.pc) {
    const pc = sess.pc = newPc();
    pc.ontrack = (e) => {
      const v = $('#remote'); const st = e.streams[0] || new MediaStream([e.track]);
      sess.remoteStream = st; v.srcObject = st; v.play().catch(() => {});
      try { e.receiver.jitterBufferTarget = 0; } catch {}
    };
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'ctl') { sess.ctl = e.channel; e.channel.onmessage = (ev) => onCtl(JSON.parse(ev.data)); e.channel.onopen = () => sendCtl({ t: 'quality', p: S.quality || 'normal' }); }
      if (e.channel.label === 'file') setupFileChannel(e.channel);
    };
    watchConnection(pc, () => {
      modal('#waiting', false); show('viewer'); api.maximize(); api.viewerMode(true);
      $('#peerName').textContent = sess.peerName; renderScreens(); applyControlState();
      sess.statsTimer = setInterval(updateStats, 2000);
      toast('Подключено к ' + sess.peerName);
    });
  }
  await sess.pc.setRemoteDescription(m.sdp);
  await flushIce();
  const ans = await sess.pc.createAnswer();
  await sess.pc.setLocalDescription(ans);
  await Signal.send(sess.peer, { t: 'answer', sid: sess.sid, sdp: sess.pc.localDescription.toJSON() });
}

function sendCtl(m) { if (sess && sess.ctl && sess.ctl.readyState === 'open') sess.ctl.send(JSON.stringify(m)); }

async function onCtl(m) {
  if (!sess) return;
  if (sess.role === 'viewer') {
    if (m.t === 'screens') { sess.screens = m.list; sess.curScreen = m.cur; renderScreens(); }
    else if (m.t === 'clip-val') { if (await api.clipWrite(m.s || '')) toast('Текст из их буфера обмена скопирован к вам — можно вставлять.'); }
    else if (m.t === 'msg') toast(m.s);
    return;
  }
  // сторона хоста: команды от помощника
  if (['m', 'd', 'u', 'w', 'h', 'k', 't'].includes(m.t)) { if (sess.accepted) api.input(m); return; }
  if (m.t === 'quality' && QUALITY[m.p]) { sess.quality = m.p; await hostApplyQuality(); }
  else if (m.t === 'screen') { await hostSwitchScreen(m.id); }
  else if (m.t === 'clip-set') { await api.clipWrite(String(m.s || '')); sendCtl({ t: 'msg', s: 'Текст скопирован в буфер обмена на их компьютере' }); }
  else if (m.t === 'clip-get') { sendCtl({ t: 'clip-val', s: await api.clipRead() }); }
}

// ----- ввод мышью и клавиатурой -----
const pressed = new Set();
let lastMove = null, moveQueued = false;
function videoPoint(e) {
  const v = $('#remote'); const r = v.getBoundingClientRect();
  const vw = v.videoWidth, vh = v.videoHeight; if (!vw || !vh) return null;
  let x0 = r.left, y0 = r.top, w = r.width, h = r.height;
  if (!document.body.classList.contains('actual')) {
    const s = Math.min(r.width / vw, r.height / vh); w = vw * s; h = vh * s;
    x0 = r.left + (r.width - w) / 2; y0 = r.top + (r.height - h) / 2;
  }
  const x = (e.clientX - x0) / w, y = (e.clientY - y0) / h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: +x.toFixed(5), y: +y.toFixed(5) };
}
function controlOn() { return sess && sess.role === 'viewer' && sess.control !== false; }
function setupViewerInput() {
  const v = $('#remote');
  v.addEventListener('mousemove', (e) => {
    if (!controlOn()) return; lastMove = videoPoint(e);
    if (!moveQueued) { moveQueued = true; requestAnimationFrame(() => { moveQueued = false; if (lastMove) sendCtl({ t: 'm', ...lastMove }); }); }
  });
  v.addEventListener('mousedown', (e) => { if (!controlOn()) return; const p = videoPoint(e); if (!p) return; e.preventDefault(); v.focus(); sendCtl({ t: 'd', b: e.button, ...p }); });
  window.addEventListener('mouseup', (e) => { if (!controlOn()) return; const p = videoPoint(e) || lastMove || {}; sendCtl({ t: 'u', b: e.button, ...p }); });
  v.addEventListener('contextmenu', (e) => e.preventDefault());
  v.addEventListener('auxclick', (e) => e.preventDefault());
  v.addEventListener('wheel', (e) => {
    if (!controlOn()) return; e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1.2;
    if (e.deltaY) sendCtl({ t: 'w', d: Math.round(-e.deltaY * k) });
    if (e.deltaX) sendCtl({ t: 'h', d: Math.round(e.deltaX * k) });
  }, { passive: false });
  const EXT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'NumpadEnter', 'NumpadDivide', 'ControlRight', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu', 'NumLock', 'PrintScreen']);
  const onKey = (down) => (e) => {
    if (!controlOn() || document.body.dataset.view !== 'viewer') return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    let vk = e.keyCode; if (!vk || vk === 229) return;
    e.preventDefault();
    let code = e.code;
    if (INFO.platform === 'darwin' && (code === 'MetaLeft' || code === 'MetaRight')) { vk = 17; code = 'ControlLeft'; } // Cmd на Mac = Ctrl на Windows
    const ext = EXT.has(code);
    if (down) pressed.add(vk + ':' + (ext ? 1 : 0)); else pressed.delete(vk + ':' + (ext ? 1 : 0));
    sendCtl({ t: 'k', vk, down, ext });
  };
  window.addEventListener('keydown', onKey(true), true);
  window.addEventListener('keyup', onKey(false), true);
  window.addEventListener('blur', releaseKeys);
}
function releaseKeys() {
  for (const p of pressed) { const [vk, ext] = p.split(':'); sendCtl({ t: 'k', vk: +vk, down: false, ext: ext === '1' }); }
  pressed.clear();
}
function combo(keys) { // keys: [[vk, ext], ...]
  for (const [vk, ext] of keys) sendCtl({ t: 'k', vk, down: true, ext: !!ext });
  for (const [vk, ext] of [...keys].reverse()) sendCtl({ t: 'k', vk, down: false, ext: !!ext });
}
function applyControlState() {
  const on = controlOn();
  $('#btnControl').classList.toggle('on', on);
  $('#btnControl').querySelector('span').textContent = on ? 'Управление: вкл' : 'Только просмотр';
  document.body.classList.toggle('viewonly', !on);
}

function renderScreens() {
  const sel = $('#selScreen'); const list = (sess && sess.screens) || [];
  sel.innerHTML = list.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.primary ? ' (основной)' : ''}</option>`).join('');
  sel.value = sess && sess.curScreen; sel.parentElement.hidden = list.length < 2;
}

async function updateStats() {
  if (!sess || !sess.pc) return;
  const st = await sess.pc.getStats(); let fps = 0, bytes = 0, rtt = null, type = '';
  st.forEach(r => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') { fps = r.framesPerSecond || 0; bytes = r.bytesReceived; }
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
      rtt = r.currentRoundTripTime; const lc = st.get(r.localCandidateId); type = lc ? lc.candidateType : '';
    }
  });
  const now = performance.now(); let kbps = 0;
  if (sess.lastBytes != null) kbps = (bytes - sess.lastBytes) * 8 / (now - sess.lastT);
  sess.lastBytes = bytes; sess.lastT = now;
  const ms = rtt != null ? Math.round(rtt * 1000) : null;
  const q = ms == null ? '' : ms < 80 ? 'отличная' : ms < 200 ? 'хорошая' : 'медленная';
  $('#stats').textContent = `Связь ${q}${ms != null ? ' · ' + ms + ' мс' : ''} · ${Math.round(fps)} кадр/с · ${kbps > 1000 ? (kbps / 1000).toFixed(1) + ' Мбит/с' : Math.round(kbps) + ' кбит/с'}${type === 'relay' ? ' · через TURN' : ''}`;
}

// ----- запись экрана -----
function pickMime() {
  const list = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find(m => MediaRecorder.isTypeSupported(m)) || '';
}
async function startRecording() {
  if (!sess || !sess.remoteStream || sess.recorder) return;
  const mime = pickMime(); const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const q = REC[S.recQuality || 'good'];
  const rec = new MediaRecorder(sess.remoteStream, { mimeType: mime, videoBitsPerSecond: q.kbps * 1000 });
  const { id, file } = await api.recStart(ext);
  sess.recorder = rec; sess.rec = { id, file, size: 0, started: Date.now(), pausedMs: 0, pausedAt: 0, chain: Promise.resolve() };
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return; const r = sess && sess.rec ? sess.rec : null; if (!r) return;
    r.chain = r.chain.then(async () => { r.size = await api.recChunk(id, await e.data.arrayBuffer()); });
  };
  rec.onerror = () => { toast('Запись остановилась из-за ошибки, сохранённая часть в папке записей', 'err'); stopRecording(sess); };
  rec.start(2000);
  document.body.classList.add('recording');
  sess.recTimer = setInterval(updateRecUi, 500); updateRecUi();
}
function updateRecUi() {
  if (!sess || !sess.rec) return; const r = sess.rec;
  const paused = sess.recorder && sess.recorder.state === 'paused';
  const el = (Date.now() - r.started - r.pausedMs - (paused ? Date.now() - r.pausedAt : 0)) / 1000;
  $('#recInfo').textContent = (paused ? '⏸ ' : '') + fmtTime(el) + ' · ' + fmtSize(r.size);
}
function pauseRecording() {
  if (!sess || !sess.recorder) return; const r = sess.recorder;
  if (r.state === 'recording') { r.pause(); sess.rec.pausedAt = Date.now(); $('#btnRecPause').textContent = 'Продолжить'; }
  else if (r.state === 'paused') { r.resume(); sess.rec.pausedMs += Date.now() - sess.rec.pausedAt; $('#btnRecPause').textContent = 'Пауза'; }
  updateRecUi();
}
function stopRecording(s = sess) {
  if (!s || !s.recorder) return Promise.resolve();
  const rec = s.recorder, info = s.rec; s.recorder = null;
  clearInterval(s.recTimer); document.body.classList.remove('recording');
  $('#btnRecPause').textContent = 'Пауза';
  return new Promise((res) => {
    rec.onstop = async () => {
      await info.chain; const r = await api.recStop(info.id);
      s.rec = null;
      if (r) showSaved(r.file, r.size);
      res();
    };
    try { rec.state !== 'inactive' ? rec.stop() : rec.onstop(); } catch { rec.onstop(); }
  });
}
function showSaved(file, size) {
  const t = document.createElement('div'); t.className = 'toast ok';
  t.innerHTML = INFO.viewerOnly ? `Запись готова (${fmtSize(size)}). <button class="link">Сохранить / отправить</button>` : `Запись сохранена (${fmtSize(size)}). <button class="link">Показать файл</button>`;
  t.querySelector('button').onclick = () => api.recShow(file);
  $('#toasts').appendChild(t);
  if (!INFO.viewerOnly) { setTimeout(() => t.classList.add('out'), 9000); setTimeout(() => t.remove(), 9500); }
  else { const x = document.createElement('button'); x.className = 'link'; x.textContent = '✕'; x.onclick = () => t.remove(); t.appendChild(x); }
}

// ----- передача файлов -----
function setupFileChannel(ch) {
  ch.binaryType = 'arraybuffer'; ch.bufferedAmountLowThreshold = 1 << 20; sess.file = ch;
  let cur = null, chain = Promise.resolve();
  ch.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.t === 'start') { cur = { id: m.id, name: m.name, size: m.size, got: 0 }; chain = chain.then(() => api.fileRecvStart(m.id, m.name)); progress(`Получаем «${m.name}»`, 0); }
      else if (m.t === 'end' && cur) {
        const c = cur; cur = null;
        chain = chain.then(async () => { const f = await api.fileRecvEnd(c.id, true); progress(null); if (f) fileToast(INFO.viewerOnly ? `Получен файл «${c.name}»` : `Получен файл «${c.name}» — он на рабочем столе, в папке «Помощник — полученные файлы»`, f); });
      }
      return;
    }
    if (!cur) return; const c = cur; const buf = e.data; c.got += buf.byteLength;
    chain = chain.then(() => api.fileRecvChunk(c.id, buf)); progress(`Получаем «${c.name}»`, c.got / c.size);
  };
}
async function sendFile(info) {
  if (!sess || !sess.file || sess.file.readyState !== 'open') return toast('Нет соединения для передачи файлов', 'err');
  if (sess.sending) return toast('Дождитесь окончания предыдущей передачи');
  const ch = sess.file; const id = crypto.randomUUID(); const CH = 64 * 1024; sess.sending = true;
  try {
    ch.send(JSON.stringify({ t: 'start', id, name: info.name, size: info.size }));
    for (let off = 0; off < info.size; off += CH) {
      if (!sess || ch.readyState !== 'open') throw new Error('closed');
      if (ch.bufferedAmount > 8 * CH * 16) await new Promise(r => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; r(); }; });
      const b = await api.fileRead(info.path, off, Math.min(CH, info.size - off));
      ch.send(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      progress(`Отправляем «${info.name}»`, (off + CH) / info.size);
    }
    ch.send(JSON.stringify({ t: 'end', id }));
    toast(`Файл «${info.name}» отправлен`, 'ok');
  } catch { toast('Передача файла прервалась', 'err'); }
  finally { api.fileClose(info.path); progress(null); if (sess) sess.sending = false; }
}
function progress(text, frac) {
  const p = $('#progress'); if (!text) { p.hidden = true; return; }
  p.hidden = false; p.querySelector('span').textContent = text + ` ${Math.min(100, Math.round(frac * 100))}%`;
  p.querySelector('i').style.width = Math.min(100, frac * 100) + '%';
}
function fileToast(text, file) {
  const t = document.createElement('div'); t.className = 'toast ok';
  t.innerHTML = esc(text) + ` <button class="link">${INFO.viewerOnly ? 'Сохранить' : 'Открыть папку'}</button>`;
  t.querySelector('button').onclick = () => api.fileShow(file);
  $('#toasts').appendChild(t); setTimeout(() => t.classList.add('out'), 10000); setTimeout(() => t.remove(), 10500);
}

// ========== СТОРОНА ХОСТА (кому помогают) ==========
let pendingReq = null;
async function onRequest(m) {
  if (INFO.viewerOnly) { Signal.send(m.from, { t: 'rej', sid: m.sid, reason: 'noscreen' }).catch(() => {}); return; }
  if (sess) { Signal.send(m.from, { t: 'rej', sid: m.sid, reason: 'busy' }).catch(() => {}); return; }
  const trusted = (S.trusted || {})[m.from];
  if (trusted && trusted.pub === Signal.knownKey(m.from)) { await hostAccept(m, false); toast(`${m.name} подключился (вы разрешили ему подключаться без вопросов)`); return; }
  pendingReq = m;
  $('#inName').textContent = m.name || 'Кто-то';
  $('#inId').textContent = fmtId(m.from);
  $('#inTrust').checked = false;
  modal('#incoming', true); api.flash(); beep();
  try { new Notification('Помощник: запрос на подключение', { body: `${m.name || 'Кто-то'} хочет подключиться к вашему компьютеру` }); } catch {}
  let left = 60; $('#inTimer').textContent = left;
  clearInterval(pendingReq.timer);
  pendingReq.timer = setInterval(() => { left--; $('#inTimer').textContent = left; if (left <= 0) hostReject(); }, 1000);
}
function hostReject() {
  if (!pendingReq) return; clearInterval(pendingReq.timer);
  Signal.send(pendingReq.from, { t: 'rej', sid: pendingReq.sid, reason: 'no' }).catch(() => {});
  pendingReq = null; modal('#incoming', false);
}
async function hostAccept(m, fromDialog = true) {
  if (fromDialog) {
    clearInterval(m.timer); modal('#incoming', false);
    if ($('#inTrust').checked) { const tr = Object.assign({}, S.trusted || {}); tr[m.from] = { pub: Signal.knownKey(m.from), name: m.name }; await save({ trusted: tr }); }
    pendingReq = null;
  }
  if (INFO.platform === 'darwin') {
    const pm = await api.macPerms();
    if (pm && pm.screen !== 'granted') {
      Signal.send(m.from, { t: 'rej', sid: m.sid, reason: 'perm' }).catch(() => {});
      checkMacPerms(true); api.show();
      return toast('Чтобы показать экран, разрешите «Запись экрана» (подсказка в окне программы)', 'err');
    }
    if (pm && !pm.access) toast('Управление мышью не разрешено — помощник сможет только смотреть. Разрешите «Универсальный доступ».', 'err');
  }
  const screens = await api.listScreens();
  if (!screens.length) { Signal.send(m.from, { t: 'rej', sid: m.sid, reason: 'noscreen' }).catch(() => {}); return toast('Не удалось получить изображение экрана', 'err'); }
  sess = { role: 'host', sid: m.sid, peer: m.from, peerName: m.name || fmtId(m.from), screens, cur: screens[0].id, quality: 'normal', accepted: true };
  await Signal.send(m.from, { t: 'acc', sid: m.sid, name: S.name || INFO.user, screens: screens.map(s => ({ id: s.id, name: s.name, primary: s.primary })), cur: sess.cur });
  try {
    sess.stream = await captureScreen(sess.cur, QUALITY[sess.quality]);
  } catch (e) { console.error(e); return endSession('Не удалось начать показ экрана', true); }
  const pc = sess.pc = newPc();
  const track = sess.stream.getVideoTracks()[0]; track.contentHint = 'detail';
  const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [sess.stream] });
  sess.sender = tr.sender;
  try {
    const caps = RTCRtpSender.getCapabilities('video').codecs;
    const rank = (c) => /h264/i.test(c.mimeType) ? (/profile-level-id=42e0/.test(c.sdpFmtpLine || '') ? 0 : 1) : /vp8/i.test(c.mimeType) ? 2 : /vp9/i.test(c.mimeType) ? 3 : 4;
    tr.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b)));
  } catch {}
  const ctl = sess.ctl = pc.createDataChannel('ctl', { ordered: true });
  ctl.onmessage = (ev) => { try { onCtl(JSON.parse(ev.data)); } catch {} };
  ctl.onopen = () => sendCtl({ t: 'screens', list: sess.screens.map(s => ({ id: s.id, name: s.name, primary: s.primary })), cur: sess.cur });
  setupFileChannel(pc.createDataChannel('file', { ordered: true }));
  watchConnection(pc, async () => {
    await hostApplyQuality();
    const scr = sess.screens.find(s => s.id === sess.cur);
    await api.hostStart({ displayId: scr && scr.displayId, name: sess.peerName });
    $('#hostName').textContent = sess.peerName; show('host');
    setTimeout(() => { if (sess && sess.role === 'host') api.minimize(); }, 1200);
  });
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await Signal.send(m.from, { t: 'offer', sid: m.sid, sdp: pc.localDescription.toJSON() });
}
async function captureScreen(sourceId, q) {
  // размер подбираем точно по пропорциям экрана — без чёрных полос и лишних пикселей
  const scr = (sess && sess.screens || []).find(s => s.id === sourceId) || { width: q.w, height: q.h };
  const k = Math.min(1, q.w / scr.width, q.h / scr.height);
  const w = Math.max(2, Math.round(scr.width * k / 2) * 2), h = Math.max(2, Math.round(scr.height * k / 2) * 2);
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, minWidth: w, maxWidth: w, minHeight: h, maxHeight: h,
    maxFrameRate: q.fps, minFrameRate: 1 } } });
}
async function hostApplyQuality() {
  if (!sess || !sess.sender) return; const q = QUALITY[sess.quality];
  const p = sess.sender.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = q.kbps * 1000; p.encodings[0].maxFramerate = q.fps;
  p.degradationPreference = 'maintain-resolution';
  try { await sess.sender.setParameters(p); } catch (e) { console.warn(e); }
  if (sess.appliedQ && sess.appliedQ !== sess.quality) await hostReplaceTrack(sess.cur);
  sess.appliedQ = sess.quality;
}
async function hostReplaceTrack(sourceId) {
  const ns = await captureScreen(sourceId, QUALITY[sess.quality]);
  const t = ns.getVideoTracks()[0]; t.contentHint = 'detail';
  await sess.sender.replaceTrack(t);
  sess.stream.getTracks().forEach(x => x.stop()); sess.stream = ns;
}
async function hostSwitchScreen(id) {
  const scr = sess.screens.find(s => s.id === id); if (!scr) return;
  sess.cur = id; await hostReplaceTrack(id); await api.setDisplay(scr.displayId);
  sendCtl({ t: 'screens', list: sess.screens.map(s => ({ id: s.id, name: s.name, primary: s.primary })), cur: id });
}

// ========== маршрутизация сигналов ==========
Signal.on(async (m) => {
  if (m.t === '_key') { const kk = Object.assign({}, S.knownKeys || {}); kk[m.from] = m.pub; save({ knownKeys: kk }); return; }
  if (m.t === 'req') return onRequest(m);
  if (m.t === 'cancel') { if (pendingReq && pendingReq.sid === m.sid) { clearInterval(pendingReq.timer); pendingReq = null; modal('#incoming', false); toast('Запрос на подключение отменён'); } return; }
  if (!sess || m.sid !== sess.sid || m.from !== sess.peer) return;
  switch (m.t) {
    case 'acc': if (sess.role === 'viewer') viewerOnAccept(m); break;
    case 'rej': if (sess.role === 'viewer') endSession(m.reason === 'busy' ? 'К этому компьютеру уже кто-то подключён.' : m.reason === 'perm' ? 'На том Mac ещё не разрешена «Запись экрана». Там в окне «Помощника» есть подсказка, как это включить.' : m.reason === 'noscreen' ? 'К этому устройству подключиться нельзя (это телефон или браузер).' : 'На том компьютере отклонили подключение.', true, false); break;
    case 'offer': if (sess.role === 'viewer') viewerOnOffer(m).catch(e => { console.error(e); endSession('Ошибка соединения', true); }); break;
    case 'answer': if (sess.role === 'host' && sess.pc) { await sess.pc.setRemoteDescription(m.sdp); await flushIce(); } break;
    case 'ice': addRemoteIce(m.c); break;
    case 'bye': endSession(sess.role === 'host' ? 'Помощник отключился.' : 'Подключение завершено на том компьютере.', false, false); break;
  }
});

// ========== контакты ==========
function contactLabel(id) { const c = (S.contacts || []).find(c => c.id === id); return c && c.label; }
async function rememberContact(id, name) {
  const list = (S.contacts || []).filter(c => c.id !== id);
  const old = (S.contacts || []).find(c => c.id === id);
  list.unshift({ id, label: (old && old.label) || name || fmtId(id), last: Date.now() });
  await save({ contacts: list.slice(0, 12) }); renderContacts();
}
function renderContacts() {
  const box = $('#contacts'); const list = S.contacts || [];
  box.innerHTML = list.length ? '' : '<p class="muted">Здесь появятся компьютеры, к которым вы подключались.</p>';
  for (const c of list) {
    const row = document.createElement('div'); row.className = 'contact';
    row.innerHTML = `<div class="c-main"><b>${esc(c.label)}</b><small>${fmtId(c.id)}</small></div>
      <button class="ghost sm" data-a="ren" title="Переименовать">✎</button>
      <button class="ghost sm" data-a="del" title="Убрать из списка">✕</button>
      <button class="primary sm" data-a="go">Подключиться</button>`;
    row.querySelector('[data-a=go]').onclick = () => connectTo(c.id);
    row.querySelector('[data-a=del]').onclick = async () => { await save({ contacts: (S.contacts || []).filter(x => x.id !== c.id) }); renderContacts(); };
    row.querySelector('[data-a=ren]').onclick = () => {
      const m = row.querySelector('.c-main'); m.innerHTML = `<input class="ren" value="${esc(c.label)}" maxlength="40">`;
      const i = m.querySelector('input'); i.focus(); i.select();
      const done = async () => { const l = i.value.trim() || c.label; await save({ contacts: (S.contacts || []).map(x => x.id === c.id ? { ...x, label: l } : x) }); renderContacts(); };
      i.onkeydown = (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') renderContacts(); }; i.onblur = done;
    };
    box.appendChild(row);
  }
}
function renderTrusted() {
  const box = $('#trustedList'); const tr = S.trusted || {}; const ids = Object.keys(tr);
  box.innerHTML = ids.length ? '' : '<p class="muted">Никому не разрешено подключаться без вопроса.</p>';
  for (const id of ids) {
    const row = document.createElement('div'); row.className = 'contact';
    row.innerHTML = `<div class="c-main"><b>${esc(tr[id].name || 'Без имени')}</b><small>${fmtId(id)}</small></div><button class="ghost sm">Запретить</button>`;
    row.querySelector('button').onclick = async () => { const t = Object.assign({}, S.trusted); delete t[id]; await save({ trusted: t }); renderTrusted(); };
    box.appendChild(row);
  }
}

// ========== разрешения macOS ==========
let permScreenAsked = false;
async function checkMacPerms(force) {
  if (INFO.platform !== 'darwin') return;
  const pm = await api.macPerms(); if (!pm) return;
  const all = pm.screen === 'granted' && pm.access && pm.inApps;
  const box = $('#macPerm');
  box.hidden = all || (S.macPermSkip && !force);
  const st = (el, ok) => { el.textContent = ok ? '✓' : '○'; el.className = ok ? 'ok' : ''; };
  st($('#permScreenSt'), pm.screen === 'granted'); st($('#permAccessSt'), pm.access);
  $('#permScreen').hidden = pm.screen === 'granted'; $('#permAccess').hidden = pm.access;
  $('#permRestart').hidden = !(permScreenAsked && pm.screen !== 'granted');
  $('#permMove').hidden = pm.inApps;
}

// ========== запуск ==========
async function boot() {
  S = await api.getSettings(); INFO = await api.info();
  if (!S.name) await save({ name: INFO.user || '' });
  if (INFO.platform === 'win32' && INFO.packaged && !INFO.installed && !S.skipInstall) { show('install'); }
  else show('home');

  const id = await Signal.init(S, save, INFO.testRelay);
  $('#myId').textContent = fmtId(id);
  Signal.onStatus((n, total, list) => {
    const ok = n > 0; $('#netDot').className = 'dot ' + (ok ? 'ok' : 'bad');
    $('#netText').textContent = ok ? `Готов к подключению (${n} из ${total})` : 'Нет связи с интернетом — ждём…';
    $('#netList').innerHTML = (list || []).map(t => `<div class="perm-row"><span class="${t.ok ? 'ok' : ''}">${t.ok ? '✓' : '✗'}</span> ${esc(t.name)}</div>`).join('');
  });
  $('.net').onclick = () => { modal('#netBox', true); };
  $('#netClose').onclick = () => modal('#netBox', false);
  renderContacts();

  // домашний экран
  $('#myName').value = S.name || '';
  $('#myName').onchange = (e) => save({ name: e.target.value.trim() });
  $('#btnCopyId').onclick = () => { api.clipWrite(id); toast('Номер скопирован'); };
  const inp = $('#peerId');
  inp.oninput = () => { const d = cleanId(inp.value).slice(0, 9); inp.value = fmtId(d); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') connectTo(inp.value); };
  $('#btnConnect').onclick = () => connectTo(inp.value);
  $('#btnCancelWait').onclick = cancelConnect;

  // разрешения macOS
  if (INFO.platform === 'darwin') {
    checkMacPerms();
    window.addEventListener('focus', () => checkMacPerms());
    $('#permScreen').onclick = () => { permScreenAsked = true; api.macAsk('screen'); setTimeout(checkMacPerms, 1500); };
    $('#permAccess').onclick = () => { api.macAsk('access'); };
    $('#permRelaunch').onclick = () => api.relaunch();
    $('#permSkip').onclick = async () => { await save({ macPermSkip: true }); $('#macPerm').hidden = true; };
  }

  // установка
  $('#btnInstall').onclick = async () => { $('#btnInstall').disabled = true; $('#btnInstall').textContent = 'Устанавливаем…'; try { await api.install(); } catch (e) { toast('Не получилось установить: ' + e.message, 'err'); $('#btnInstall').disabled = false; } };
  $('#btnSkipInstall').onclick = () => { save({ skipInstall: true }); show('home'); };

  // настройки
  $('#btnSettings').onclick = () => { $('#optAutostart').checked = !!S.autostart; $('#optRecQ').value = S.recQuality || 'good';
    $('#turnUrls').value = (S.turn && S.turn.urls) || ''; $('#turnUser').value = (S.turn && S.turn.username) || ''; $('#turnPass').value = (S.turn && S.turn.credential) || '';
    renderTrusted(); modal('#settings', true); };
  $('#btnCloseSettings').onclick = () => modal('#settings', false);
  $('#optAutostart').onchange = (e) => save({ autostart: e.target.checked });
  $('#optRecQ').innerHTML = Object.entries(REC).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#optRecQ').onchange = (e) => { save({ recQuality: e.target.value }); syncRecQ(); };
  $('#turnSave').onclick = () => { save({ turn: { urls: $('#turnUrls').value.trim(), username: $('#turnUser').value.trim(), credential: $('#turnPass').value } }); toast('Сохранено'); };
  $('#btnRecFolder').onclick = () => api.recOpenFolder();
  $('#btnRecFolder2').onclick = () => api.recOpenFolder();

  // входящий запрос
  $('#inAllow').onclick = () => pendingReq && hostAccept(pendingReq).catch(e => { console.error(e); endSession('Ошибка при подключении', true); });
  $('#inDeny').onclick = hostReject;

  // экран хоста
  $('#btnHostStop').onclick = () => endSession('Вы отключили помощника.');
  api.onHostDisconnect(() => endSession('Вы отключили помощника.'));
  $('#btnHostFile').onclick = async () => { const f = await api.filePick(); if (f) sendFile(f); };

  // экран просмотра
  setupViewerInput();
  $('#btnDisconnect').onclick = () => endSession('Подключение завершено.');
  $('#btnControl').onclick = () => { sess.control = sess.control === false; applyControlState(); if (!controlOn()) releaseKeys(); };
  const sq = $('#selQuality'); sq.innerHTML = Object.entries(QUALITY).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  sq.value = S.quality || 'normal';
  sq.onchange = () => { save({ quality: sq.value }); sendCtl({ t: 'quality', p: sq.value }); };
  $('#selScreen').onchange = (e) => sendCtl({ t: 'screen', id: e.target.value });
  $('#btnFit').onclick = () => { document.body.classList.toggle('actual'); $('#btnFit').querySelector('span').textContent = document.body.classList.contains('actual') ? '1:1' : 'Вписать'; };
  $('#btnFull').onclick = () => api.fullscreen();
  $('#btnRec').onclick = () => sess && (sess.recorder ? stopRecording() : startRecording());
  $('#btnRecPause').onclick = pauseRecording;
  const rq = $('#selRecQ'); rq.innerHTML = Object.entries(REC).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  const syncRecQ = () => { rq.value = S.recQuality || 'good'; };
  syncRecQ(); rq.onchange = () => save({ recQuality: rq.value });
  $('#btnClipTo').onclick = async () => {
    const t = await api.clipRead();
    if (t == null) { $('#typeText').value = ''; $('#typeBox').dataset.mode = 'clip'; modal('#typeBox', true); $('#typeText').focus(); return; }
    sendCtl({ t: 'clip-set', s: t });
  };
  $('#btnClipFrom').onclick = () => sendCtl({ t: 'clip-get' });
  $('#btnType').onclick = () => { $('#typeText').value = ''; $('#typeBox').dataset.mode = 'type'; modal('#typeBox', true); $('#typeText').focus(); };
  $('#typeSend').onclick = () => { const s = $('#typeText').value; if (s) sendCtl($('#typeBox').dataset.mode === 'clip' ? { t: 'clip-set', s } : { t: 't', s }); modal('#typeBox', false); };
  $('#typeCancel').onclick = () => modal('#typeBox', false);
  $('#btnSendFile').onclick = async () => { const f = await api.filePick(); if (f) sendFile(f); };
  const menu = $('#keysMenu');
  $('#btnKeys').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; more.hidden = true; };
  const more = $('#moreMenu');
  $('#btnMore').onclick = (e) => { e.stopPropagation(); more.hidden = !more.hidden; menu.hidden = true; };
  more.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { more.hidden = true; }));
  document.addEventListener('click', () => { menu.hidden = true; more.hidden = true; });
  const K = { win: [[91, 1]], alttab: [[18], [9]], taskmgr: [[17], [16], [27]], winD: [[91, 1], [68]], winE: [[91, 1], [69]], altf4: [[18], [115]], ctrlC: [[17], [67]], ctrlV: [[17], [86]], winR: [[91, 1], [82]], esc: [[27]] };
  menu.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { combo(K[b.dataset.k]); menu.hidden = true; });
  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drop'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
  stage.addEventListener('drop', async (e) => {
    e.preventDefault(); stage.classList.remove('drop');
    const f = e.dataTransfer.files[0]; if (!f) return;
    const info = await api.fileStat(api.pathForFile(f)); if (info) sendFile(info);
  });
  window.addEventListener('beforeunload', () => { if (sess) Signal.send(sess.peer, { t: 'bye', sid: sess.sid }); });
}
boot().catch(e => { console.error(e); toast('Ошибка запуска: ' + e.message, 'err'); });
