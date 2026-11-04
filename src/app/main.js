'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Tray, Menu, nativeImage,
        clipboard, shell, dialog, Notification, powerSaveBlocker, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

app.setAppUserModelId('ru.pomoshnik.app');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (process.env.POMOSHNIK_PROFILE) app.setPath('userData', process.env.POMOSHNIK_PROFILE);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const IS_WIN = process.platform === 'win32';
const APP_DIR = __dirname;
const ICON = path.join(APP_DIR, 'icon.png');
const INSTALL_DIR = IS_WIN ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Pomoshnik') : null;
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let win = null, banner = null, tray = null, quitting = false;
let startHidden = process.argv.includes('--hidden') ||
  (process.platform === 'darwin' && (() => { try { return app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; } })());

// ---------- настройки ----------
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}
let settings = loadSettings();
if (settings.autostart === undefined) settings.autostart = true;
saveSettings(settings);

function applyAutostart() {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') {
    if (!process.execPath.startsWith('/Applications/')) return; // только из папки «Программы»
    app.setLoginItemSettings({ openAtLogin: !!settings.autostart, openAsHidden: true });
    return;
  }
  if (!IS_WIN || !isInstalled()) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.autostart, path: process.execPath, args: ['--hidden'] });
}

// ---------- окна ----------
// На Mac нужно меню «Правка», иначе не работают Cmd+C / Cmd+V в полях ввода.
// Во время управления чужим компьютером меню без сочетаний клавиш, чтобы они уходили на тот компьютер.
const IS_MAC = process.platform === 'darwin';
function setMenu(viewer) {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  const edit = viewer ? [] : [{ label: 'Правка', submenu: [
    { role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' }, { type: 'separator' },
    { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' }, { role: 'paste', label: 'Вставить' },
    { role: 'selectAll', label: 'Выбрать всё' }] }];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Помощник', submenu: viewer
        ? [{ label: 'Выйти из Помощника', click: () => { quitting = true; app.quit(); } }]
        : [{ role: 'hide', label: 'Скрыть Помощник' }, { type: 'separator' }, { label: 'Выйти из Помощника', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } }] },
    ...edit
  ]));
}
ipcMain.handle('viewer-mode', (_e, on) => setMenu(!!on));

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 680, minWidth: 720, minHeight: 520,
    title: 'Помощник', icon: ICON, show: false, backgroundColor: '#f4f1ea',
    webPreferences: { preload: path.join(APP_DIR, 'preload.js'), contextIsolation: true,
                      nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  setMenu(false);
  win.loadFile(path.join(APP_DIR, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); notifyOnce(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}
let notified = false;
function notifyOnce() {
  if (notified) return; notified = true;
  try { new Notification({ title: 'Помощник работает', body: 'Программа свёрнута в угол экрана (возле часов) и ждёт подключения.', icon: ICON }).show(); } catch {}
}
function showMain() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createTray() {
  const ti = nativeImage.createFromPath(ICON).resize({ width: IS_MAC ? 18 : 16, height: IS_MAC ? 18 : 16 });
  tray = new Tray(ti);
  tray.setToolTip('Помощник');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Помощник', click: showMain },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showMain);
}

function showBanner(name) {
  if (banner) { banner.webContents.send('banner-name', name); banner.showInactive(); return; }
  const d = screen.getPrimaryDisplay().workArea;
  banner = new BrowserWindow({
    width: 430, height: 46, x: Math.round(d.x + d.width / 2 - 215), y: d.y + 6,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, focusable: true,
    transparent: false, backgroundColor: '#b3261e', show: false,
    webPreferences: { preload: path.join(APP_DIR, 'preload.js'), contextIsolation: true }
  });
  banner.setAlwaysOnTop(true, 'screen-saver');
  banner.loadFile(path.join(APP_DIR, 'ui', 'banner.html'), { query: { name } });
  banner.once('ready-to-show', () => banner.showInactive());
  banner.on('closed', () => { banner = null; });
}
function hideBanner() { if (banner) { banner.destroy(); banner = null; } }

// ---------- установка ----------
function isInstalled() {
  if (!IS_WIN || !app.isPackaged) return true;
  return path.resolve(path.dirname(process.execPath)).toLowerCase()
    .startsWith(path.resolve(INSTALL_DIR).toLowerCase());
}
function createShortcut(target) {
  if (!IS_WIN) return;
  const ico = path.join(path.dirname(target), 'resources', 'app', 'icon.ico');
  const opts = { target, icon: ico, iconIndex: 0, description: 'Помощник — удалённая помощь', appUserModelId: 'ru.pomoshnik.app' };
  try { shell.writeShortcutLink(path.join(app.getPath('desktop'), 'Помощник.lnk'), opts); } catch {}
  try {
    const sm = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    shell.writeShortcutLink(path.join(sm, 'Помощник.lnk'), opts);
  } catch {}
}
async function doInstall() {
  const srcDir = path.dirname(process.execPath);
  const tmp = INSTALL_DIR + '.new';
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  await fs.promises.cp(srcDir, tmp, { recursive: true });
  try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }); } catch {}
  fs.renameSync(tmp, INSTALL_DIR);
  const exe = path.join(INSTALL_DIR, path.basename(process.execPath));
  createShortcut(exe);
  if (settings.autostart) app.setLoginItemSettings({ openAtLogin: true, path: exe, args: ['--hidden'] });
  quitting = true;
  app.releaseSingleInstanceLock();
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 300);
}

// ---------- управление вводом (только Windows) ----------
let inputProc = null, inputReady = false;
function startInput() {
  if (inputProc) return;
  if (process.platform === 'darwin') {
    inputProc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', path.join(APP_DIR, 'input-mac.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
    inputProc.stdout.on('data', (d) => { if (String(d).includes('READY')) inputReady = true; });
    inputProc.on('exit', () => { inputProc = null; inputReady = false; });
    return;
  }
  if (!IS_WIN) return;
  const script = path.join(APP_DIR, 'input.ps1');
  inputProc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
                    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  inputProc.stdout.on('data', (d) => { if (String(d).includes('READY')) inputReady = true; });
  inputProc.on('exit', () => { inputProc = null; inputReady = false; });
}
function stopInput() {
  if (inputProc) { try { inputProc.stdin.write('q\n'); } catch {} setTimeout(() => { try { inputProc && inputProc.kill(); } catch {} }, 500); }
}
function sendInput(line) { if (inputProc && inputProc.stdin.writable) inputProc.stdin.write(line + '\n'); }

let activeDisplay = null; // экран, который сейчас показываем
function displayById(id) {
  const all = screen.getAllDisplays();
  return all.find(d => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}
function toPhysical(nx, ny) {
  const d = activeDisplay || screen.getPrimaryDisplay();
  const b = d.bounds;
  const p = { x: b.x + Math.max(0, Math.min(1, nx)) * (b.width - 1), y: b.y + Math.max(0, Math.min(1, ny)) * (b.height - 1) };
  if (process.platform === 'darwin') return { x: Math.round(p.x), y: Math.round(p.y) }; // macOS: те же точки, что у CoreGraphics
  if (IS_WIN && screen.dipToScreenPoint) {
    const q = screen.dipToScreenPoint(p);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  }
  return { x: Math.round(p.x * d.scaleFactor), y: Math.round(p.y * d.scaleFactor) };
}

// ---------- запись ----------
const recordings = new Map(); // id -> fd
function videosDir() {
  const dir = path.join(app.getPath('videos'), 'Помощник');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let psbId = null;

// ---------- IPC ----------
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  settings = Object.assign(settings, patch); saveSettings(settings);
  if ('autostart' in patch) applyAutostart();
  return settings;
});
ipcMain.handle('app:info', () => ({
  platform: process.platform, installed: isInstalled(), packaged: app.isPackaged,
  version: app.getVersion(), computer: os.hostname(), user: os.userInfo().username,
  testRelay: process.env.POMOSHNIK_TEST_RELAY || null
}));
ipcMain.handle('app:install', () => doInstall());
// разрешения macOS, без которых к этому Mac нельзя подключиться
ipcMain.handle('mac:perms', () => {
  if (process.platform !== 'darwin') return null;
  return { screen: systemPreferences.getMediaAccessStatus('screen'), access: systemPreferences.isTrustedAccessibilityClient(false),
           inApps: process.execPath.startsWith('/Applications/') };
});
ipcMain.handle('mac:ask', async (_e, which) => {
  if (process.platform !== 'darwin') return;
  if (which === 'access') {
    systemPreferences.isTrustedAccessibilityClient(true);
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  } else {
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch {}
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});
ipcMain.handle('app:relaunch', () => { quitting = true; app.relaunch(); app.exit(0); });
ipcMain.handle('app:show', () => showMain());
ipcMain.handle('app:flash', () => { showMain(); if (win) { win.setAlwaysOnTop(true); win.flashFrame(true); setTimeout(() => win && win.setAlwaysOnTop(false), 1500); } });

ipcMain.handle('screens:list', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  const prim = screen.getPrimaryDisplay().id;
  return sources.map((s, i) => {
    const d = displays.find(x => String(x.id) === String(s.display_id)) || displays[i] || screen.getPrimaryDisplay();
    return { id: s.id, displayId: String(d.id), name: `Экран ${i + 1}`, primary: d.id === prim,
             width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
  }).sort((a, b) => (b.primary - a.primary));
});
ipcMain.handle('session:host-start', (_e, { displayId, name }) => {
  activeDisplay = displayById(displayId);
  startInput();
  showBanner(name || 'помощник');
  if (psbId === null) psbId = powerSaveBlocker.start('prevent-display-sleep');
  return true;
});
ipcMain.handle('session:set-display', (_e, displayId) => { activeDisplay = displayById(displayId); });
ipcMain.handle('session:host-stop', () => {
  hideBanner(); stopInput(); activeDisplay = null;
  if (psbId !== null) { powerSaveBlocker.stop(psbId); psbId = null; }
});
ipcMain.on('input', (_e, ev) => {
  if (!activeDisplay) return; // ввод принимается только во время разрешённого сеанса
  switch (ev.t) {
    case 'm': { const p = toPhysical(ev.x, ev.y); sendInput(`m ${p.x} ${p.y}`); break; }
    case 'd': case 'u': {
      if (ev.x !== undefined) { const p = toPhysical(ev.x, ev.y); sendInput(`m ${p.x} ${p.y}`); }
      sendInput(`${ev.t} ${ev.b | 0}`); break;
    }
    case 'w': sendInput(`w ${Math.max(-1200, Math.min(1200, ev.d | 0))}`); break;
    case 'h': sendInput(`h ${Math.max(-1200, Math.min(1200, ev.d | 0))}`); break;
    case 'k': sendInput(`k ${ev.vk & 0xffff} ${ev.down ? 1 : 0} ${ev.ext ? 1 : 0}`); break;
    case 't': sendInput(`t ${Buffer.from(String(ev.s).slice(0, 5000), 'utf8').toString('base64')}`); break;
  }
});
ipcMain.on('banner:disconnect', () => { if (win) win.webContents.send('host:disconnect'); });

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_e, t) => { clipboard.writeText(String(t)); return true; });

ipcMain.handle('rec:start', (_e, ext) => {
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const file = path.join(videosDir(), `Запись ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`);
  const fd = fs.openSync(file, 'w'); const id = String(Date.now());
  recordings.set(id, { fd, file, size: 0 });
  return { id, file };
});
ipcMain.handle('rec:chunk', (_e, id, buf) => {
  const r = recordings.get(id); if (!r) return 0;
  const b = Buffer.from(buf); fs.writeSync(r.fd, b); r.size += b.length; return r.size;
});
ipcMain.handle('rec:stop', (_e, id) => {
  const r = recordings.get(id); if (!r) return null;
  fs.closeSync(r.fd); recordings.delete(id); return { file: r.file, size: r.size };
});
ipcMain.handle('rec:open-folder', () => shell.openPath(videosDir()));
ipcMain.handle('rec:show', (_e, file) => shell.showItemInFolder(file));

// приём файлов
const incoming = new Map();
function receivedDir() {
  const dir = path.join(app.getPath('desktop'), 'Помощник — полученные файлы');
  fs.mkdirSync(dir, { recursive: true }); return dir;
}
ipcMain.handle('file:recv-start', (_e, id, name) => {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'файл';
  let file = path.join(receivedDir(), safe); let n = 1;
  const ext = path.extname(safe); const base = safe.slice(0, safe.length - ext.length);
  while (fs.existsSync(file)) file = path.join(receivedDir(), `${base} (${n++})${ext}`);
  incoming.set(id, { fd: fs.openSync(file, 'w'), file }); return file;
});
ipcMain.handle('file:recv-chunk', (_e, id, buf) => { const f = incoming.get(id); if (f) fs.writeSync(f.fd, Buffer.from(buf)); });
ipcMain.handle('file:recv-end', (_e, id, ok) => {
  const f = incoming.get(id); if (!f) return null; fs.closeSync(f.fd); incoming.delete(id);
  if (!ok) { try { fs.unlinkSync(f.file); } catch {} return null; }
  return f.file;
});
ipcMain.handle('file:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Какой файл отправить?', properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0]; const st = fs.statSync(p);
  return { path: p, name: path.basename(p), size: st.size };
});
ipcMain.handle('file:stat', (_e, p) => { const st = fs.statSync(p); return { path: p, name: path.basename(p), size: st.size }; });
const openReads = new Map();
ipcMain.handle('file:read', (_e, p, offset, len) => {
  let fd = openReads.get(p); if (fd === undefined) { fd = fs.openSync(p, 'r'); openReads.set(p, fd); }
  const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, offset);
  return b.subarray(0, n);
});
ipcMain.handle('file:close', (_e, p) => { const fd = openReads.get(p); if (fd !== undefined) { fs.closeSync(fd); openReads.delete(p); } });
ipcMain.handle('file:show', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('win:fullscreen', (_e, on) => { if (win) win.setFullScreen(on === undefined ? !win.isFullScreen() : !!on); return win && win.isFullScreen(); });
ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win:maximize', () => { if (win && !win.isMaximized()) win.maximize(); });

// ---------- запуск ----------
app.on('second-instance', () => { startHidden = false; showMain(); });
app.on('activate', () => showMain());
app.whenReady().then(() => {
  createWindow(); createTray(); applyAutostart();
});
app.on('before-quit', () => { quitting = true; stopInput(); });
app.on('window-all-closed', (e) => { if (!quitting) e.preventDefault(); });
