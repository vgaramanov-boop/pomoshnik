'use strict';
/* Веб-версия «Помощника» (iPhone/iPad/любой браузер): заменяет то, что в программе делает Electron. */
(() => {
  document.documentElement.classList.add('web');
  const KEY = 'pomoshnik.settings.v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let settings = load();
  const recs = new Map();
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const relay = local ? new URLSearchParams(location.search).get('relay') : null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function copyDialog(text) {
    const m = document.getElementById('copyBox'); if (!m) return;
    m.querySelector('textarea').value = text; m.hidden = false;
  }

  window.api = {
    getSettings: async () => settings,
    setSettings: async (patch) => {
      settings = Object.assign(load(), settings, patch);
      try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
      return settings;
    },
    info: async () => ({ platform: 'web', ios: isIOS, viewerOnly: true, installed: true, packaged: false, version: '1.0.0',
                         computer: isIOS ? 'iPhone' : 'Браузер', user: '', testRelay: relay }),
    install: async () => {}, show: async () => {}, flash: async () => {},
    listScreens: async () => [], hostStart: async () => {}, hostStop: async () => {}, setDisplay: async () => {},
    input: () => {},
    clipRead: async () => { try { return await navigator.clipboard.readText(); } catch { return null; } },
    clipWrite: async (t) => {
      try { await navigator.clipboard.writeText(String(t)); return true; }
      catch { copyDialog(String(t)); return false; }
    },
    recStart: async (ext) => {
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      const id = String(Date.now());
      const name = `Запись ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}.${ext}`;
      recs.set(id, { name, ext, parts: [], size: 0 });
      return { id, file: id };
    },
    recChunk: async (id, buf) => { const r = recs.get(id); if (!r) return 0; r.parts.push(buf); r.size += buf.byteLength; return r.size; },
    recStop: async (id) => {
      const r = recs.get(id); if (!r) return null;
      r.blob = new Blob(r.parts, { type: r.ext === 'mp4' ? 'video/mp4' : 'video/webm' }); r.parts = null;
      return { file: id, size: r.size };
    },
    recOpenFolder: async () => {},
    recShow: async (id) => {
      const r = recs.get(id); if (!r || !r.blob) return;
      const file = new File([r.blob], r.name, { type: r.blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: r.name }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.blob); a.download = r.name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
    },
    fileRecvStart: async (id, name) => { recs.set('f' + id, { name, parts: [] }); return name; },
    fileRecvChunk: async (id, buf) => { const f = recs.get('f' + id); if (f) f.parts.push(buf); },
    fileRecvEnd: async (id, ok) => {
      const f = recs.get('f' + id); if (!f) return null;
      if (!ok) { recs.delete('f' + id); return null; }
      recs.set('f' + id + ':done', { name: f.name, blob: new Blob(f.parts) }); recs.delete('f' + id);
      return 'f' + id + ':done';
    },
    fileShow: async (key) => {
      const f = recs.get(key); if (!f) return;
      const file = new File([f.blob], f.name);
      if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch {} }
      const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    },
    filePick: () => new Promise((res) => {
      const i = document.createElement('input'); i.type = 'file'; i.style.display = 'none'; document.body.appendChild(i);
      i.onchange = () => { const f = i.files[0]; i.remove(); res(f ? { path: f, name: f.name, size: f.size } : null); };
      i.addEventListener('cancel', () => { i.remove(); res(null); });
      i.click();
    }),
    fileStat: async (f) => (f && f.size !== undefined ? { path: f, name: f.name, size: f.size } : null),
    fileRead: async (f, off, len) => new Uint8Array(await f.slice(off, off + len).arrayBuffer()),
    fileClose: async () => {},
    fullscreen: async (on) => {
      const el = document.documentElement;
      try {
        if (on === false) { if (document.fullscreenElement) await document.exitFullscreen(); }
        else if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen();
        else if (document.fullscreenElement) await document.exitFullscreen();
      } catch {}
      return !!document.fullscreenElement;
    },
    maximize: async () => {}, minimize: async () => {}, viewerMode: async () => {},
    onHostDisconnect: () => {}, bannerDisconnect: () => {}, onBannerName: () => {},
    pathForFile: (f) => f
  };

  if (!('Notification' in window)) window.Notification = function () {};

  // окно «скопируйте вручную» — iPhone не даёт сайту класть текст в буфер без нажатия
  document.addEventListener('DOMContentLoaded', () => {
    const m = document.getElementById('copyBox'); if (!m) return;
    m.querySelector('[data-a=copy]').onclick = async () => {
      const t = m.querySelector('textarea');
      try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand('copy'); }
      m.hidden = true;
    };
    m.querySelector('[data-a=close]').onclick = () => { m.hidden = true; };
  });
})();
