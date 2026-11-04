// Помощник: исполнитель команд мыши и клавиатуры на macOS (JavaScript for Automation + CoreGraphics).
// Запускается программой через `osascript -l JavaScript`, читает команды построчно из stdin.
// Работает только пока идёт сеанс, разрешённый пользователем. Нужно разрешение «Универсальный доступ».
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');

var TAP = 0; // kCGHIDEventTap
var F = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 };
// коды клавиш Windows (VK) -> коды клавиш Mac
var MAP = {
  8: 51, 9: 48, 13: 36, 16: 56, 17: 55, 18: 58, 20: 57, 27: 53, 32: 49, 33: 116, 34: 121, 35: 119, 36: 115,
  37: 123, 38: 126, 39: 124, 40: 125, 45: 114, 46: 117, 91: 59, 92: 59, 93: 110,
  48: 29, 49: 18, 50: 19, 51: 20, 52: 21, 53: 23, 54: 22, 55: 26, 56: 28, 57: 25,
  65: 0, 66: 11, 67: 8, 68: 2, 69: 14, 70: 3, 71: 5, 72: 4, 73: 34, 74: 38, 75: 40, 76: 37, 77: 46,
  78: 45, 79: 31, 80: 35, 81: 12, 82: 15, 83: 1, 84: 17, 85: 32, 86: 9, 87: 13, 88: 7, 89: 16, 90: 6,
  96: 82, 97: 83, 98: 84, 99: 85, 100: 86, 101: 87, 102: 88, 103: 89, 104: 91, 105: 92,
  106: 67, 107: 69, 109: 78, 110: 65, 111: 75,
  112: 122, 113: 120, 114: 99, 115: 118, 116: 96, 117: 97, 118: 98, 119: 100, 120: 101, 121: 109, 122: 103, 123: 111,
  186: 41, 187: 24, 188: 43, 189: 27, 190: 47, 191: 44, 192: 50, 219: 33, 220: 42, 221: 30, 222: 39
};
// Ctrl с Windows работает как Cmd на Mac (Ctrl+C = копировать), Win — как Control, Alt — как Option
var MOD = { 16: 'shift', 17: 'cmd', 18: 'alt', 91: 'ctrl', 92: 'ctrl' };
var mods = { shift: false, ctrl: false, alt: false, cmd: false };
function flags() { var f = 0; for (var k in mods) if (mods[k]) f |= F[k]; return f; }

var pos = { x: 0, y: 0 };
var down = { 0: false, 1: false, 2: false };
var last = { t: 0, x: -99, y: -99, b: -1, n: 0 };

function post(e) { if (e) { $.CGEventSetFlags(e, flags()); $.CGEventPost(TAP, e); } }
function mouse(type, btn, clicks) {
  var e = $.CGEventCreateMouseEvent(null, type, { x: pos.x, y: pos.y }, btn);
  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); // kCGMouseEventClickState: двойной щелчок
  post(e);
}
function move(x, y) {
  pos.x = x; pos.y = y;
  if (down[0]) mouse(6, 0); else if (down[2]) mouse(7, 1); else if (down[1]) mouse(27, 2); else mouse(5, 0);
}
function button(b, isDown) {
  var cg = b === 0 ? 0 : b === 2 ? 1 : 2;
  var type = b === 0 ? (isDown ? 1 : 2) : b === 2 ? (isDown ? 3 : 4) : (isDown ? 25 : 26);
  if (isDown) {
    var now = Date.now();
    if (now - last.t < 450 && Math.abs(pos.x - last.x) < 6 && Math.abs(pos.y - last.y) < 6 && last.b === b) last.n++; else last.n = 1;
    last.t = now; last.x = pos.x; last.y = pos.y; last.b = b;
  }
  down[b] = isDown;
  mouse(type, cg, last.n);
}
function wheel(d, horizontal) {
  var px = Math.round(d / 3) * (horizontal ? -1 : 1); // 120 единиц Windows ≈ 40 точек
  var e = null;
  try { e = horizontal ? $.CGEventCreateScrollWheelEvent2(null, 0, 2, 0, px, 0) : $.CGEventCreateScrollWheelEvent2(null, 0, 1, px, 0, 0); } catch (x) { e = null; }
  if (!e) { // запасной путь: прокрутка стрелками
    var n = Math.max(1, Math.min(10, Math.round(Math.abs(d) / 40)));
    var code = horizontal ? (d > 0 ? 124 : 123) : (d > 0 ? 126 : 125);
    for (var i = 0; i < n; i++) { post($.CGEventCreateKeyboardEvent(null, code, true)); post($.CGEventCreateKeyboardEvent(null, code, false)); }
    return;
  }
  post(e);
}
function key(vk, isDown) {
  if (MOD[vk]) mods[MOD[vk]] = isDown;
  var code = MAP[vk]; if (code === undefined) return;
  post($.CGEventCreateKeyboardEvent(null, code, isDown));
}
// текст на любом языке: через буфер обмена и Cmd+V, затем буфер возвращается как был
function text(s) {
  var pb = $.NSPasteboard.generalPasteboard;
  var old = pb.stringForType($.NSPasteboardTypeString);
  pb.clearContents; pb.setStringForType($(s), $.NSPasteboardTypeString);
  var saved = { shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt, cmd: mods.cmd };
  mods = { shift: false, ctrl: false, alt: false, cmd: true };
  post($.CGEventCreateKeyboardEvent(null, 9, true)); post($.CGEventCreateKeyboardEvent(null, 9, false));
  mods = saved;
  delay(0.3);
  if (old && !old.isNil()) { pb.clearContents; pb.setStringForType(old, $.NSPasteboardTypeString); }
}
function b64(s) {
  var d = $.NSData.alloc.initWithBase64EncodedStringOptions($(s), 0);
  return $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js;
}

function handle(line) {
  var p = line.split(' ');
  try {
    switch (p[0]) {
      case 'm': move(+p[1], +p[2]); break;
      case 'd': button(+p[1], true); break;
      case 'u': button(+p[1], false); break;
      case 'w': wheel(+p[1], false); break;
      case 'h': wheel(+p[1], true); break;
      case 'k': key(+p[1], p[2] === '1'); break;
      case 't': text(b64(p[1])); break;
      case 'q': return false;
    }
  } catch (e) { }
  return true;
}

function run() {
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  out.writeData($('READY ' + ($.AXIsProcessTrusted() ? '1' : '0') + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  var inp = $.NSFileHandle.fileHandleWithStandardInput;
  var buf = '';
  while (true) {
    var data = inp.availableData;
    if (!data || data.length === 0) break;
    buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    var i;
    while ((i = buf.indexOf('\n')) >= 0) {
      var line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!handle(line)) return;
    }
  }
}
