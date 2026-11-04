#!/usr/bin/env python3
"""Собирает веб-версию «Помощника» в папку dist-web из общего кода программы (app/ui) и файлов web/."""
import json, shutil, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
UI, WEB = ROOT / 'app' / 'ui', ROOT / 'web'
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'dist-web'
TEST = '--test' in sys.argv

if OUT.exists(): shutil.rmtree(OUT)
OUT.mkdir(parents=True)
for f in ['app.js', 'signal.js', 'style.css']: shutil.copy(UI / f, OUT / f)
for f in ['web-shim.js', 'web-touch.js', 'web.css']: shutil.copy(WEB / f, OUT / f)

icon = Image.open(ROOT / 'app' / 'icon.png').convert('RGBA')
# для iOS — без прозрачных углов (iOS скругляет сама)
src = Image.open(ROOT / 'app' / 'icon.png').convert('RGBA')
bg = Image.new('RGBA', src.size, (31, 111, 92, 255)); bg.alpha_composite(src.crop((0, 0) + src.size))
inner = src.crop((22, 22, 234, 234)).resize((256, 256), Image.LANCZOS)
full = Image.new('RGBA', (256, 256), (31, 111, 92, 255)); full.alpha_composite(inner)
full.convert('RGB').resize((180, 180), Image.LANCZOS).save(OUT / 'apple-touch-icon.png')
full.convert('RGB').resize((192, 192), Image.LANCZOS).save(OUT / 'icon-192.png')
full.convert('RGB').resize((512, 512), Image.LANCZOS).save(OUT / 'icon-512.png')
icon.save(OUT / 'icon.png')

(OUT / 'manifest.webmanifest').write_text(json.dumps({
    'name': 'Помощник', 'short_name': 'Помощник', 'start_url': './', 'scope': './', 'display': 'standalone',
    'background_color': '#f4f1ea', 'theme_color': '#1f6f5c', 'lang': 'ru',
    'icons': [{'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
              {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png'}]
}, ensure_ascii=False, indent=1), encoding='utf-8')

h = (UI / 'index.html').read_text(encoding='utf-8')
def rep(a, b):
    global h
    assert a in h, a[:80]
    h = h.replace(a, b, 1)

connect = 'wss://0.peerjs.com wss://broker.emqx.io:8084 wss://broker.hivemq.com:8884 wss://test.mosquitto.org:8081 wss://mqtt.eclipseprojects.io'
if TEST: connect = 'ws://127.0.0.1:8765 ' + connect
csp_start = h.index('<meta http-equiv="Content-Security-Policy"'); csp_end = h.index('>', csp_start) + 1
h = h[:csp_start] + (f'<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; '
                     f'img-src \'self\' data: blob:; media-src \'self\' blob: mediastream:; connect-src {connect}; manifest-src \'self\'">') + h[csp_end:]
rep('<title>Помощник</title>', '''<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Помощник">
<meta name="theme-color" content="#1f6f5c">
<meta name="format-detection" content="telephone=no">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" href="icon.png">
<link rel="manifest" href="manifest.webmanifest">
<title>Помощник</title>''')
rep('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="web.css">')
h = h.replace('src="../icon.png"', 'src="icon.png"')
rep('<label class="field">Ваше имя (его увидит собеседник)', '''<div class="a2hs web-only" id="a2hs">Совет: нажмите <b>«Поделиться»</b> ⬆︎ внизу Safari → <b>«На экран „Домой“»</b>. Появится значок «Помощник», и номера родителей будут всегда под рукой.</div>
      <label class="field">Ваше имя (его увидит собеседник)''')
rep('      <button id="btnControl"', '''      <button id="btnKbd" class="tb" title="Клавиатура"><i>⌨︎</i><span>Клавиатура</span></button>
      <button id="btnControl"''')
rep('      <button id="btnFit"', '      <button id="btnHelp" class="tb" title="Как управлять пальцами"><i>?</i><span>Жесты</span></button>\n      <button id="btnFit"')
rep('<div id="progress"', '''<textarea id="kbd" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Клавиатура"></textarea>

<div id="copyBox" class="modal" hidden>
  <div class="dialog">
    <h2>Текст с их компьютера</h2>
    <textarea rows="5" readonly></textarea>
    <div class="actions"><button data-a="copy" class="primary">Скопировать</button><button data-a="close" class="ghost">Закрыть</button></div>
  </div>
</div>

<div id="touchHelp" class="modal" hidden>
  <div class="dialog">
    <h2>Управление пальцами</h2>
    <ul class="help-list">
      <li><b>Коснуться</b> щелчок мышью</li>
      <li><b>Два касания</b> двойной щелчок</li>
      <li><b>Подержать</b> правая кнопка мыши</li>
      <li><b>Подержать и вести</b> перетащить</li>
      <li><b>Вести одним пальцем</b> прокрутка</li>
      <li><b>Двумя пальцами</b> увеличить и двигать картинку</li>
      <li><b>⌨︎</b> клавиатура: печатаете у них</li>
    </ul>
    <div class="actions"><button id="touchHelpOk" class="primary">Понятно</button></div>
  </div>
</div>

<div id="progress"''')
rep('<script src="signal.js"></script>', '<script src="web-shim.js"></script>\n<script src="signal.js"></script>')
rep('<script src="app.js"></script>', '<script src="app.js"></script>\n<script src="web-touch.js"></script>\n<script src="web-boot.js"></script>')
(OUT / 'index.html').write_text(h, encoding='utf-8')
(OUT / 'web-boot.js').write_text('''"use strict";
// подсказка «На экран Домой» — только в Safari, когда страница ещё не добавлена как значок
(function () {
  var standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var el = document.getElementById('a2hs'); if (el && (standalone || !ios)) el.remove();
})();
''', encoding='utf-8')
(OUT / '.nojekyll').write_text('')
print('ok', OUT)
