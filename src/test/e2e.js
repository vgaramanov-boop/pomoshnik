const { chromium } = require('playwright');
(async () => {
  const H = await chromium.connectOverCDP('http://127.0.0.1:9301');
  const V = await chromium.connectOverCDP('http://127.0.0.1:9302');
  const hp = H.contexts()[0].pages().find(p => p.url().includes('index.html'));
  const vp = V.contexts()[0].pages().find(p => p.url().includes('index.html'));
  for (const [n, p] of [['host', hp], ['helper', vp]]) p.on('console', m => console.log(`[${n}]`, m.type(), m.text()));
  await hp.waitForFunction(() => /\d{3} \d{3} \d{3}/.test(document.querySelector('#myId').textContent));
  await hp.waitForFunction(() => document.querySelector('#netDot').classList.contains('ok'), null, { timeout: 15000 });
  await vp.waitForFunction(() => document.querySelector('#netDot').classList.contains('ok'), null, { timeout: 15000 });
  const hostId = (await hp.textContent('#myId')).trim();
  console.log('host id', hostId);
  await vp.screenshot({ path: '/tmp/s1-home.png' });
  await vp.fill('#peerId', hostId.replace(/ /g, ''));
  await vp.click('#btnConnect');
  await hp.waitForSelector('#incoming:not([hidden])', { timeout: 30000 });
  await hp.screenshot({ path: '/tmp/s2-incoming.png' });
  console.log('incoming shown:', await hp.textContent('#inName'));
  await hp.click('#inAllow');
  await vp.waitForSelector('#viewer:not([hidden])', { timeout: 40000 });
  await vp.waitForFunction(() => document.querySelector('#remote').videoWidth > 0, null, { timeout: 20000 });
  console.log('video', await vp.evaluate(() => [remote.videoWidth, remote.videoHeight]));
  await vp.waitForTimeout(3000);
  console.log('stats:', await vp.textContent('#stats'));
  await hp.screenshot({ path: '/tmp/s3-host.png' });
  // управление мышью — проверяем, что сообщения доходят до хоста
  await hp.evaluate(() => { window.__got = []; const o = window.api.input; });
  await vp.mouse.move(400, 400); await vp.mouse.down(); await vp.mouse.up();
  // запись 8 секунд
  await vp.click('#btnRec'); await vp.waitForTimeout(8000);
  console.log('rec info', await vp.textContent('#recInfo'));
  await vp.screenshot({ path: '/tmp/s4-viewer.png' });
  await vp.click('#btnRec'); await vp.waitForTimeout(2000);
  // буфер обмена
  await hp.evaluate(() => window.api.clipWrite('привет от мамы'));
  await vp.click('#btnMore'); await vp.click('#btnClipFrom'); await vp.waitForTimeout(1500);
  console.log('helper clipboard:', await vp.evaluate(() => window.api.clipRead()));
  // качество
  await vp.selectOption('#selQuality', 'eco'); await vp.waitForTimeout(3000);
  console.log('after eco video', await vp.evaluate(() => [remote.videoWidth, remote.videoHeight]), await vp.textContent('#stats'));
  console.log('host track', await hp.evaluate(() => JSON.stringify(sess.stream.getVideoTracks()[0].getSettings()) + ' screens ' + JSON.stringify(sess.screens)));
  await vp.waitForTimeout(3000); console.log('viewer later', await vp.evaluate(() => [remote.videoWidth, remote.videoHeight]));
  await vp.click('#btnDisconnect');
  await hp.waitForSelector('#home:not([hidden])', { timeout: 10000 });
  console.log('disconnected OK');
  await H.close(); await V.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
