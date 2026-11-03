"use strict";
// подсказка «На экран Домой» — только в Safari, когда страница ещё не добавлена как значок
(function () {
  var standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var el = document.getElementById('a2hs'); if (el && (standalone || !ios)) el.remove();
})();
