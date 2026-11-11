/* Расчёты каталога: подбор по приборам, часы работы, зарядка, предел розетки.
   Общий модуль для сайта (window.NECalc) и бота (require("./assets/calc.js")). Без зависимостей, без DOM.
   Данные приходят аргументами (DATA.loads, DATA.eff, DATA.phone_wh, комбинации и версии из DATA.combos). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NECalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var nf = new Intl.NumberFormat("ru-RU");

  function N(x) { return x == null ? "—" : nf.format(x); }
  function dec(x, d) { return String(Math.round(x * Math.pow(10, d)) / Math.pow(10, d)).replace(".", ","); }
  function plural(n, f) { var a = n % 10, b = n % 100; return f[(b > 10 && b < 20) ? 2 : (a === 1 ? 0 : (a >= 2 && a <= 4 ? 1 : 2))]; }

  /* время работы словами: «≈ 45 мин», «≈ 7,7 ч», «≈ 23 ч», «≈ 2,2 сут» */
  function hoursText(h) {
    if (h < 1) return "≈ " + Math.round(h * 60) + " мин";
    if (h < 10) return "≈ " + dec(h, 1) + " ч";
    if (h < 48) return "≈ " + Math.round(h) + " ч";
    return "≈ " + dec(h / 24, 1) + " сут";
  }
  /* диапазон часов для группы: «21–37 ч» или «2,2–3,7 сут» */
  function rangeText(a, b) {
    if (a >= 48) return dec(a / 24, 1) + "–" + dec(b / 24, 1) + " сут";
    return Math.round(a) + "–" + Math.round(b) + " ч";
  }

  /* Нагрузка прибора: watts — мощность при работе (подбор и проверка станции), avg — в среднем (для часов,
     по умолчанию = watts), start — пусковая, Вт (по умолчанию нет). У смартфона watts = null: в сумме 20 Вт. */
  function loadWatts(l) { return l.watts == null ? 20 : l.watts; }
  function loadAvg(l) { return l.avg == null ? loadWatts(l) : l.avg; }
  /* пик станции: 2 × номинала, до 0,3 с, по паспорту изделия */
  function peakOf(c) { return 2 * c.power; }

  /* Итог по выбранным приборам. sel: {ключ: true}. Возвращает {t: сумма watts, avg: сумма avg, start: максимальная пусковая, any} */
  function selection(loads, sel) {
    var s = { t: 0, avg: 0, start: 0, any: false };
    loads.forEach(function (l) {
      if (sel[l.key]) {
        s.any = true; s.t += loadWatts(l); s.avg += loadAvg(l);
        if (l.start && l.start > s.start) s.start = l.start;
      }
    });
    return s;
  }
  /* станция подходит: power >= сумма watts и peak >= максимальная пусковая среди выбранных */
  function fits(c, S) { return !S.any || (c.power >= S.t && peakOf(c) >= S.start); }

  /* что именно не хватает (для объяснений): "power" | "peak" | null */
  function shortage(c, S) {
    if (!S.any) return null;
    if (c.power < S.t) return "power";
    if (peakOf(c) < S.start) return "peak";
    return null;
  }

  /* время работы станции на каждом приборе списка */
  function runtimeFor(c, loads, eff, phoneWh) {
    return loads.map(function (l) {
      if (l.watts == null) return { l: l, ok: true, text: "≈ " + N(Math.floor(c.cap * eff / phoneWh)) + " раз" };
      if (c.power < l.watts || (l.start && peakOf(c) < l.start)) return { l: l, ok: false, text: "не потянет" };
      return { l: l, ok: true, h: c.cap * eff / loadAvg(l), text: hoursText(c.cap * eff / loadAvg(l)) };
    });
  }
  /* строка таблицы «Хватит на»: у приборов со средним расходом до 100 Вт — «до N суток *» */
  function tableText(r) {
    var low = r.ok && r.l.watts != null && loadAvg(r.l) <= 100;
    return low ? r.text.replace("≈ ", "до ").replace(" сут", " суток") + " *" : r.text;
  }

  /* зарядка от розетки 220 В: t80 = 0,8·E/(P·0,9); t100 = E/(P·0,9)·1,2; округление до 0,1 ч.
     ch = CHARGE[код] ({acW, basis}); нет данных — null («Время зарядки уточняется») */
  function chargeTimes(cap, ch) {
    if (!(ch && ch.acW)) return null;
    var p = ch.acW * 0.9, r1 = function (x) { return Math.round(x * 10) / 10; };
    return { t80: r1(0.8 * cap / p), t100: r1(cap / p * 1.2), estimate: ch.basis === "estimate" };
  }

  /* предел одной розетки: для каждой группы «k × A А (до N Вт)» min(N, мощность станции, 2200 для 10 А, 3500 для 16 А);
     берётся максимум по группам. Совпадает с полем maxSocket в data/catalog.js */
  var AMP_LIMIT = { 10: 2200, 16: 3500 };
  function maxSocket(power, sockets) {
    var best = 0;
    sockets.forEach(function (s) {
      var m = /^\s*\d+\s*×\s*(\d+)\s*А\s*\(до\s*([\d\s ]+)Вт\)/.exec(s);
      if (!m) return;
      var n = parseInt(m[2].replace(/\D/g, ""), 10);
      best = Math.max(best, Math.min(n, power, AMP_LIMIT[m[1]] || n));
    });
    return best;
  }

  return {
    N: N, dec: dec, plural: plural, hoursText: hoursText, rangeText: rangeText,
    loadWatts: loadWatts, loadAvg: loadAvg, peakOf: peakOf,
    selection: selection, fits: fits, shortage: shortage,
    runtimeFor: runtimeFor, tableText: tableText, chargeTimes: chargeTimes, maxSocket: maxSocket
  };
});
