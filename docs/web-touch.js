'use strict';
/* global sess, sendCtl, videoPoint, controlOn, toast, $ */
/*
 * Сенсорное управление для iPhone/iPad:
 *   касание — щелчок; два быстрых касания — двойной щелчок;
 *   долгое нажатие — правая кнопка; долгое нажатие и вести — перетаскивание;
 *   провести одним пальцем — прокрутка; двумя пальцами — увеличить и двигать картинку.
 */
(() => {
  const stage = document.getElementById('stage');
  const video = document.getElementById('remote');
  const ring = document.createElement('div'); ring.className = 'touch-ring'; stage.appendChild(ring);
  const view = { s: 1, x: 0, y: 0 };
  const LONG = 450, SLOP = 10;
  let g = null; // текущий жест

  function applyView() {
    const r = stage.getBoundingClientRect();
    view.s = Math.min(6, Math.max(1, view.s));
    view.x = Math.min(0, Math.max(r.width - r.width * view.s, view.x));
    view.y = Math.min(0, Math.max(r.height - r.height * view.s, view.y));
    video.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  }
  window.resetZoom = () => { view.s = 1; view.x = 0; view.y = 0; applyView(); };
  window.addEventListener('resize', applyView);

  const pt = (t) => videoPoint({ clientX: t.clientX, clientY: t.clientY });
  function showRing(t, kind) {
    const r = stage.getBoundingClientRect();
    ring.style.left = (t.clientX - r.left) + 'px'; ring.style.top = (t.clientY - r.top) + 'px';
    ring.className = 'touch-ring on ' + kind; clearTimeout(ring.tm); ring.tm = setTimeout(() => { ring.className = 'touch-ring'; }, 350);
  }

  stage.addEventListener('touchstart', (e) => {
    if (!sess || document.body.dataset.view !== 'viewer') return;
    e.preventDefault();
    const ts = e.touches;
    if (ts.length >= 2) {
      if (g && g.mode === 'drag') sendCtl({ t: 'u', b: 0, ...(g.last || {}) });
      clearTimeout(g && g.timer);
      const a = ts[0], b = ts[1]; const r = stage.getBoundingClientRect();
      g = { mode: 'pinch', d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
            m0: { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top }, v0: { ...view } };
      return;
    }
    const t = ts[0];
    g = { mode: 'tap', sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY, start: pt(t), t0: Date.now(), acc: 0, accX: 0 };
    g.timer = setTimeout(() => {
      if (!g || g.mode !== 'tap') return;
      g.mode = 'long'; showRing(t, 'long');
      if (navigator.vibrate) navigator.vibrate(15);
    }, LONG);
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    if (!g) return; e.preventDefault();
    const ts = e.touches;
    if (g.mode === 'pinch') {
      if (ts.length < 2) return;
      const a = ts[0], b = ts[1]; const r = stage.getBoundingClientRect();
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const m = { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top };
      const s = Math.min(6, Math.max(1, g.v0.s * d / g.d0));
      const px = (g.m0.x - g.v0.x) / g.v0.s, py = (g.m0.y - g.v0.y) / g.v0.s;
      view.s = s; view.x = m.x - px * s; view.y = m.y - py * s; applyView();
      return;
    }
    const t = ts[0]; const moved = Math.hypot(t.clientX - g.sx, t.clientY - g.sy) > SLOP;
    if (!controlOn()) return;
    if (g.mode === 'tap' && moved) {
      clearTimeout(g.timer); g.mode = 'scroll';
      if (g.start) sendCtl({ t: 'm', ...g.start });
    }
    if (g.mode === 'long' && moved) {
      g.mode = 'drag'; if (g.start) sendCtl({ t: 'd', b: 0, ...g.start });
    }
    if (g.mode === 'scroll') {
      const k = 2.4 / view.s;
      g.acc += (t.clientY - g.ly) * k; g.accX += (t.clientX - g.lx) * k;
      g.lx = t.clientX; g.ly = t.clientY;
      if (!g.raf) g.raf = requestAnimationFrame(() => {
        if (!g) return; g.raf = 0;
        if (Math.abs(g.acc) >= 1) { sendCtl({ t: 'w', d: Math.round(g.acc) }); g.acc = 0; }
        if (Math.abs(g.accX) >= 1) { sendCtl({ t: 'h', d: Math.round(-g.accX) }); g.accX = 0; }
      });
    } else if (g.mode === 'drag') {
      const p = pt(t); if (p) { g.last = p; sendCtl({ t: 'm', ...p }); }
    }
  }, { passive: false });

  const end = (e) => {
    if (!g) return; e.preventDefault();
    if (g.mode === 'pinch') { if (e.touches.length === 0) g = null; return; }
    clearTimeout(g.timer);
    const on = controlOn();
    if (on && g.start) {
      if (g.mode === 'tap') { sendCtl({ t: 'm', ...g.start }); sendCtl({ t: 'd', b: 0, ...g.start }); sendCtl({ t: 'u', b: 0, ...g.start }); showRing({ clientX: g.sx, clientY: g.sy }, 'tap'); }
      else if (g.mode === 'long') { sendCtl({ t: 'm', ...g.start }); sendCtl({ t: 'd', b: 2, ...g.start }); sendCtl({ t: 'u', b: 2, ...g.start }); }
      else if (g.mode === 'drag') sendCtl({ t: 'u', b: 0, ...(g.last || g.start) });
    }
    g = null;
  };
  stage.addEventListener('touchend', end, { passive: false });
  stage.addEventListener('touchcancel', end, { passive: false });

  // ---- экранная клавиатура ----
  const kbd = document.getElementById('kbd');
  const VK = { ArrowUp: [38, 1], ArrowDown: [40, 1], ArrowLeft: [37, 1], ArrowRight: [39, 1], Escape: [27, 0], Tab: [9, 0], Delete: [46, 1],
               Home: [36, 1], End: [35, 1], PageUp: [33, 1], PageDown: [34, 1] };
  const key = (vk, ext) => { sendCtl({ t: 'k', vk, down: true, ext: !!ext }); sendCtl({ t: 'k', vk, down: false, ext: !!ext }); };
  document.getElementById('btnKbd').onclick = () => {
    if (document.activeElement === kbd) { kbd.blur(); return; }
    kbd.value = ''; kbd.focus();
  };
  kbd.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (!controlOn()) return;
    if (e.inputType === 'insertText' || e.inputType === 'insertReplacementText' || e.inputType === 'insertFromPaste') {
      const s = e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''; if (s) sendCtl({ t: 't', s });
    } else if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward') key(8);
    else if (e.inputType === 'deleteContentForward') key(46, 1);
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') key(13);
  });
  kbd.addEventListener('keydown', (e) => {
    if (!controlOn()) return;
    const v = VK[e.key];
    if (v) { e.preventDefault(); key(v[0], v[1]); return; }
    if ((e.ctrlKey || e.metaKey) && e.keyCode >= 65 && e.keyCode <= 90) { // Cmd+C на клавиатуре iPad = Ctrl+C у них
      e.preventDefault();
      sendCtl({ t: 'k', vk: 17, down: true }); key(e.keyCode); sendCtl({ t: 'k', vk: 17, down: false });
    }
  });
  kbd.addEventListener('focus', () => document.body.classList.add('kbd-open'));
  kbd.addEventListener('blur', () => document.body.classList.remove('kbd-open'));

  // сбрасываем увеличение при новом подключении
  new MutationObserver(() => { if (document.body.dataset.view === 'viewer') window.resetZoom(); })
    .observe(document.body, { attributes: true, attributeFilter: ['data-view'] });

  // подсказка при первом подключении с телефона
  let hinted = false;
  try { hinted = localStorage.getItem('pomoshnik.hint') === '1'; } catch {}
  video.addEventListener('loadedmetadata', () => {
    if (hinted || !('ontouchstart' in window)) return; hinted = true;
    try { localStorage.setItem('pomoshnik.hint', '1'); } catch {}
    document.getElementById('touchHelp').hidden = false;
  });
  document.getElementById('touchHelpOk').onclick = () => { document.getElementById('touchHelp').hidden = true; };
  document.getElementById('btnHelp').onclick = () => { document.getElementById('touchHelp').hidden = false; };
})();
