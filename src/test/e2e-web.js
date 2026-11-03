const { chromium, devices } = require('playwright');
(async () => {
  const H = await chromium.connectOverCDP('http://127.0.0.1:9301');
  const hp = H.contexts()[0].pages().find(p => p.url().includes('index.html'));
  hp.on('console', m => { if (m.type() === 'error') console.log('[host]', m.text()); });
  const B = await chromium.launch({ args: ['--use-fake-ui-for-media-stream'] });
  const ctx = await B.newContext({ ...devices['iPhone 13'] });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8080' });
  const vp = await ctx.newPage();
  vp.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[phone]', m.type(), m.text()); });
  vp.on('pageerror', e => console.log('[phone] PAGEERROR', e.message));
  await vp.goto('http://127.0.0.1:8080/?relay=' + encodeURIComponent('ws://127.0.0.1:8765|mqtt'));
  await vp.waitForFunction(() => document.querySelector('#netDot').classList.contains('ok'), null, { timeout: 15000 });
  await vp.fill('#myName', 'Сын'); await vp.dispatchEvent('#myName', 'change');
  await vp.screenshot({ path: '/tmp/w1-home.png' });
  const hostId = (await hp.textContent('#myId')).replace(/ /g, '');
  await vp.fill('#peerId', hostId); await vp.click('#btnConnect');
  await hp.waitForSelector('#incoming:not([hidden])', { timeout: 30000 });
  console.log('host sees:', await hp.textContent('#inName'));
  await hp.click('#inAllow');
  await vp.waitForSelector('#viewer:not([hidden])', { timeout: 40000 });
  await vp.waitForFunction(() => document.querySelector('#remote').videoWidth > 0, null, { timeout: 20000 });
  console.log('phone video', await vp.evaluate(() => [remote.videoWidth, remote.videoHeight]));
  await vp.waitForTimeout(800);
  await vp.screenshot({ path: '/tmp/w2-help.png' });
  if (await vp.isVisible('#touchHelp')) await vp.tap('#touchHelpOk');
  // перехват того, что уходит на хост
  await hp.evaluate(() => { window.__in = []; const orig = window.api.input; window.api.input = (ev) => { window.__in.push(ev); orig(ev); }; });
  // хост вызывает api.input из onCtl -> нельзя переопределить contextBridge объект; проверим через перехват onCtl
  await hp.evaluate(() => { window.__in = []; const o = window.onCtl; window.onCtl = (m) => { window.__in.push(m); return o(m); };
    sess.ctl.onmessage = (ev) => { try { window.onCtl(JSON.parse(ev.data)); } catch {} }; });
  const box = await vp.locator('#remote').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cdp = await ctx.newCDPSession(vp);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i })) });
  // касание
  await touch('touchStart', [[cx, cy]]); await touch('touchEnd', []); await vp.waitForTimeout(300);
  // долгое нажатие
  await touch('touchStart', [[cx, cy]]); await vp.waitForTimeout(600); await touch('touchEnd', []); await vp.waitForTimeout(300);
  // прокрутка
  await touch('touchStart', [[cx, cy]]); for (let i = 1; i <= 8; i++) { await touch('touchMove', [[cx, cy + i * 12]]); await vp.waitForTimeout(20); } await touch('touchEnd', []); await vp.waitForTimeout(300);
  // перетаскивание
  await touch('touchStart', [[cx - 50, cy]]); await vp.waitForTimeout(600); for (let i = 1; i <= 5; i++) { await touch('touchMove', [[cx - 50 + i * 15, cy]]); await vp.waitForTimeout(20); } await touch('touchEnd', []); await vp.waitForTimeout(300);
  // щипок
  await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]); for (let i = 1; i <= 6; i++) { await touch('touchMove', [[cx - 30 - i * 15, cy], [cx + 30 + i * 15, cy]]); await vp.waitForTimeout(20); } await touch('touchEnd', []);
  await vp.waitForTimeout(300);
  console.log('zoom transform:', await vp.evaluate(() => remote.style.transform));
  // клавиатура
  await vp.tap('#btnKbd'); await vp.keyboard.type('Привет'); await vp.keyboard.press('Backspace'); await vp.keyboard.press('Enter');
  await vp.waitForTimeout(500);
  const got = await hp.evaluate(() => window.__in.filter(m => ['m', 'd', 'u', 'w', 'h', 'k', 't'].includes(m.t)));
  const summary = got.map(m => m.t + (m.b !== undefined ? m.b : '') + (m.t === 'w' ? '(' + m.d + ')' : '') + (m.t === 't' ? '(' + m.s + ')' : '') + (m.t === 'k' ? '(' + m.vk + (m.down ? '↓' : '↑') + ')' : ''));
  console.log('host got:', summary.filter((x, i, a) => !(x === 'm' && a[i - 1] === 'm')).join(' '));
  await vp.screenshot({ path: '/tmp/w3-viewer.png' });
  // запись
  await vp.evaluate(() => window.resetZoom());
  await vp.tap('#btnRec'); await vp.waitForTimeout(6000);
  console.log('rec', await vp.textContent('#recInfo'));
  await vp.tap('#btnRec'); await vp.waitForTimeout(1500);
  console.log('toast:', await vp.locator('#toasts .toast').last().textContent());
  // буфер: от них к нам
  await hp.evaluate(() => window.api.clipWrite('текст от мамы'));
  await vp.tap('#btnMore'); await vp.tap('#btnClipFrom'); await vp.waitForTimeout(1200);
  console.log('phone clipboard / dialog:', await vp.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR ' + e.message; } }), await vp.isVisible('#copyBox'));
  await vp.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(t => t.remove())); await vp.tap('#btnMore'); await vp.screenshot({ path: '/tmp/w4-menu.png' }); await vp.tap('#btnMore');
  await vp.tap('#btnHelp'); await vp.screenshot({ path: '/tmp/w2-help.png' }); await vp.tap('#touchHelpOk');
  // ориентация: альбомная
  await vp.setViewportSize({ width: 844, height: 390 }); await vp.waitForTimeout(500);
  await vp.screenshot({ path: '/tmp/w5-landscape.png' });
  await vp.tap('#btnDisconnect');
  await hp.waitForSelector('#home:not([hidden])', { timeout: 10000 });
  await vp.setViewportSize({ width: 390, height: 664 }); await vp.waitForTimeout(300);
  await vp.screenshot({ path: '/tmp/w6-home-after.png' });
  console.log('disconnected OK');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
