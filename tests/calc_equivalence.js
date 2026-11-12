"use strict";
/* Сверка «до/после» после выноса расчётов в assets/calc.js.
   «До» — функции из assets/app.js на указанной ревизии git (по умолчанию c86afc3, последняя ревизия до выноса в calc.js), «после» — текущий app.js + calc.js.
   Матрица: все 42 версии × случайные наборы из 18 приборов (+ пустой, одиночные, все сразу).
   Запуск из корня репозитория: node tests/calc_equivalence.js [ревизия] [число_наборов] */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REV = process.argv[2] || "c86afc3"; /* последняя ревизия до выноса расчётов в calc.js */
const SETS = parseInt(process.argv[3] || "400", 10);

function readJs(rel, names) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return vm.runInNewContext(code + "\n;({" + names.join(",") + "})");
}
const { DATA } = readJs("data/catalog.js", ["DATA"]);
const { CHARGE } = readJs("data/charge.js", ["CHARGE"]);
const NECalc = require(path.join(ROOT, "assets", "calc.js"));

/* вырезает function name(...){...} из исходника по скобкам */
function extractFn(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("нет функции " + name);
  let j = src.indexOf("{", i), depth = 0;
  for (let k = j; k < src.length; k++) {
    const ch = src[k];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error("не закрыта функция " + name);
}

/* «до»: функции старого app.js как есть */
const oldSrc = execFileSync("git", ["show", REV + ":assets/app.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
const starLine = /var low=[^\n]*;/.exec(oldSrc)[0];
const oldNames = ["N", "dec", "hoursText", "lw", "la", "peakOf", "selInfo", "fits", "runtimeFor", "plural", "rangeText", "chargeHtml"];
const oldBody = oldNames.map((n) => extractFn(oldSrc, n)).join("\n") + "\nfunction starText(r){" + starLine + " return tx;}\n";
const oldApi = vm.runInNewContext(
  "var D=DATA, EFF=D.eff, PH=D.phone_wh; var nf=new Intl.NumberFormat('ru-RU'); var state={sel:{}};\n" + oldBody +
  "\n({state:state, N:N, hoursText:hoursText, lw:lw, la:la, peakOf:peakOf, selInfo:selInfo, fits:fits, runtimeFor:runtimeFor, rangeText:rangeText, chargeHtml:chargeHtml, starText:starText})",
  { DATA, CHARGE, Intl });

/* «после»: функции текущего app.js, которые теперь опираются на calc.js */
const newSrc = fs.readFileSync(path.join(ROOT, "assets", "app.js"), "utf8");
const newBody = ["selInfo", "runtimeFor", "chargeTimesOf", "chargeHtml"].map((n) => extractFn(newSrc, n)).join("\n");
const newApi = vm.runInNewContext(
  "var C=NECalc, D=DATA, EFF=D.eff, PH=D.phone_wh, N=C.N, dec=C.dec, state={sel:{}};\n" + newBody +
  "\n({state:state, selInfo:selInfo, runtimeFor:runtimeFor, chargeHtml:chargeHtml, hoursText:C.hoursText, fits:C.fits, rangeText:C.rangeText, shortage:C.shortage, tableText:C.tableText})",
  { DATA, CHARGE, NECalc, Intl });

/* детерминированный генератор */
let seed = 20261111;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

const loads = DATA.loads;
const sets = [{}];
loads.forEach((l) => { const s = {}; s[l.key] = true; sets.push(s); });
const all = {}; loads.forEach((l) => { all[l.key] = true; }); sets.push(all);
for (let i = 0; i < SETS; i++) {
  const p = [0.1, 0.2, 0.3, 0.5][i % 4], s = {};
  loads.forEach((l) => { if (rnd() < p) s[l.key] = true; });
  sets.push(s);
}

let checks = 0, bad = 0; const samples = [];
function eq(label, a, b, ctx) {
  checks++;
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) { bad++; if (samples.length < 8) samples.push(label + " " + ctx + "\n   до:    " + A + "\n   после: " + B); }
}

let versions = 0;
DATA.combos.forEach((c) => {
  Object.keys(c.vers).forEach((k) => {
    const V = c.vers[k]; versions++;
    const ctx = V.code;
    /* зарядка: у версий с подтверждёнными данными и расчётом числа часов те же, что до выноса в calc.js (формулировка строки изменена);
       у версий с ориентировочным диапазоном (basis "range", новое) строка содержит диапазон и пометку */
    const hoursOf = (arr) => (arr[0].match(/\d+(?:,\d+)? ч/g) || []).join("|");
    if ((CHARGE[V.code] || {}).basis === "range") {
      const t = newApi.chargeHtml(V, c)[0];
      eq("зарядка: диапазон и пометка", /≈ [\d,]+–[\d,]+ ч.*≈ [\d,]+–[\d,]+ ч.*ориентировочно/.test(t), true, ctx + " " + t);
    } else eq("зарядка (часы)", hoursOf(oldApi.chargeHtml(V, c)), hoursOf(newApi.chargeHtml(V, c)), ctx);
    eq("maxSocket (calc.js vs поле каталога)", V.maxSocket, NECalc.maxSocket(c.power, V.sockets), ctx);
    eq("пик", oldApi.peakOf(c), NECalc.peakOf(c), ctx);
    sets.forEach((sel, n) => {
      oldApi.state.sel = sel; newApi.state.sel = sel;
      const So = oldApi.selInfo(), Sn = newApi.selInfo(), cx = ctx + " набор#" + n + " " + Object.keys(sel).join("+");
      eq("итоги набора", So, Sn, cx);
      eq("fits", oldApi.fits(c, So), newApi.fits(c, Sn), cx);
      if (So.any) {
        eq("часы по сумме avg", oldApi.hoursText(c.cap * DATA.eff / So.avg), newApi.hoursText(c.cap * DATA.eff / Sn.avg), cx);
        if (!oldApi.fits(c, So)) eq("чего не хватает", c.power < So.t ? "power" : "peak", newApi.shortage(c, Sn), cx);
      }
    });
    const ro = oldApi.runtimeFor(c), rn = newApi.runtimeFor(c);
    eq("таблица «Хватит на»: строки", ro.map((r) => [r.l.key, r.ok, r.text, r.h]), rn.map((r) => [r.l.key, r.ok, r.text, r.h]), ctx);
    eq("таблица «Хватит на»: тексты со звёздочкой", ro.map((r) => oldApi.starText(r)), rn.map((r) => newApi.tableText(r)), ctx);
  });
});
for (let i = 0; i < 300; i++) { const a = rnd() * 100, b = a + rnd() * 100; eq("rangeText", oldApi.rangeText(a, b), newApi.rangeText(a, b), a.toFixed(2) + "–" + b.toFixed(2)); }

console.log("ревизия «до»: " + REV + "; версий: " + versions + "; наборов приборов на версию: " + sets.length + " (случайных " + SETS + " + пустой + одиночные + все)");
console.log("сравнений: " + checks + "; расхождений: " + bad);
if (bad) { console.log(samples.join("\n")); process.exit(1); }
console.log("РЕЗУЛЬТАТЫ ИДЕНТИЧНЫ");
