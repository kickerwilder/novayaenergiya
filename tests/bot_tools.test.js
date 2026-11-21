"use strict";
/* Тесты инструментов чат-консультанта без LLM, без сети и без секретов: node tests/bot_tools.test.js
   Проверяют get_station (код Z, комбинация, артикул ZF) и list_stations (сортировка, limit, body) на data/kb.json.
   Таблица артикулов берётся из scripts/add_articles.py (источник правды), а не из kb.json. */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const T = require(path.join(ROOT, "bot", "tools.js"));
const kb = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "kb.json"), "utf8"));

const py = fs.readFileSync(path.join(ROOT, "scripts", "add_articles.py"), "utf8");
const TABLE = {};
for (const m of py.matchAll(/"(Z\d+-\d+-[DL])":\s*"(ZF[^"]+)"/g)) TABLE[m[1]] = m[2];

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); }
}
const get = (code) => T.execute("get_station", { code }, kb);
const list = (args) => T.execute("list_stations", args, kb);

console.log("get_station");
test("таблица артикулов: 42 версии, kb.json полный и с теми же кодами", () => {
  assert.strictEqual(Object.keys(TABLE).length, 42);
  assert.strictEqual(kb.stations.length, 42);
  assert.deepStrictEqual(Object.keys(TABLE).sort(), kb.stations.map((s) => s.code).sort());
});
test("все 42 артикула находятся, станции совпадают с таблицей", () => {
  for (const [code, art] of Object.entries(TABLE)) {
    const r = get(art);
    assert.ok(r.ok, art + " не найден");
    assert.strictEqual(r.matched_by, "article");
    assert.ok(r.stations.some((s) => s.code === code), art + ": нет станции " + code);
    r.stations.forEach((s) => assert.strictEqual(s.article, TABLE[s.code], art + ": у " + s.code + " чужой артикул " + s.article));
    assert.ok(r.stations.every((s) => s.article === art), art + ": вернулась станция с другим артикулом");
  }
});
test("регистр и пробелы не важны", () => {
  for (const q of ["zf80-20023", " ZF80-20023 ", "zf 80-20023", "Zf80 - 20023"]) {
    const r = get(q);
    assert.ok(r.ok, JSON.stringify(q) + " не найден");
    assert.ok(r.stations.every((s) => s.article === "ZF80-20023"));
  }
});
test("ZF16-2005 и ZF16-2005.0 — разные станции, без нечёткого поиска", () => {
  const a = get("ZF16-2005"), b = get("zf16-2005.0");
  assert.deepStrictEqual(a.stations.map((s) => s.code), ["Z1600-5000-D"]);
  assert.deepStrictEqual(b.stations.map((s) => s.code), ["Z1600-5000-L"]);
  assert.strictEqual(a.stations[0].article, "ZF16-2005");
  assert.strictEqual(b.stations[0].article, "ZF16-2005.0");
});
test("общий артикул у D и L возвращает обе версии", () => {
  assert.deepStrictEqual(get("ZF28-2003.8").stations.map((s) => s.code).sort(), ["Z2800-3800-D", "Z2800-3800-L"]);
});
test("неизвестный артикул ZF99-9999: ok:false, подсказка про код Z и артикул ZF", () => {
  const r = get("ZF99-9999");
  assert.strictEqual(r.ok, false);
  assert.ok(/код Z\.\.\. или артикул ZF\.\.\./.test(r.hint), r.hint);
});
test("частичный артикул не находится (нет нечёткого поиска)", () => {
  for (const q of ["ZF16", "ZF16-200", "ZF16-2005.", "16-2005"]) assert.strictEqual(get(q).ok, false, q);
});
test("пустой запрос: ok:false", () => {
  assert.strictEqual(get("").ok, false);
  assert.strictEqual(T.execute("get_station", {}, kb).ok, false);
});
test("код Z с суффиксом и без суффикса работает как раньше, в ответе есть article", () => {
  const one = get("Z2800-3800-L"), two = get("z2800-3800");
  assert.deepStrictEqual(one.stations.map((s) => s.code), ["Z2800-3800-L"]);
  assert.strictEqual(one.stations[0].article, TABLE["Z2800-3800-L"]);
  assert.deepStrictEqual(two.stations.map((s) => s.code).sort(), ["Z2800-3800-D", "Z2800-3800-L"]);
  assert.strictEqual(get("Z9999-9999-D").ok, false);
});

console.log("list_stations");
const maxPower = Math.max(...kb.stations.map((s) => s.power_w));
const maxCap = Math.max(...kb.stations.map((s) => s.cap_wh));
test("объявлен в declarations и в execute", () => {
  assert.ok(T.declarations.some((d) => d.name === "list_stations"));
  assert.strictEqual(T.execute("list_stations", {}, kb).ok, true);
});
test("по умолчанию: power desc, limit 5, первая = максимум power_w в kb.json", () => {
  const r = list({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stations.length, 5);
  assert.strictEqual(r.stations[0].power_w, maxPower);
  for (let i = 1; i < r.stations.length; i++) assert.ok(r.stations[i - 1].power_w >= r.stations[i].power_w);
  assert.strictEqual(r.first_value_ties, kb.stations.filter((s) => s.power_w === maxPower).length);
  assert.strictEqual(r.total_matching, 42);
  assert.strictEqual(r.models_matching, 29);
});
test("строки компактные и содержат нужные поля", () => {
  const row = list({ limit: 1 }).stations[0];
  assert.deepStrictEqual(Object.keys(row).sort(), ["article", "body", "cap_wh", "code", "peak_w", "power_w", "price_note", "price_rub", "title"]);
  const st = kb.stations.find((s) => s.code === row.code);
  assert.strictEqual(row.article, st.article);
  assert.strictEqual(row.peak_w, st.peak_w);
  assert.strictEqual(row.price_rub, st.price_rub);
});
test("limit: по умолчанию 5, максимум 10, минимум 1, мусор → 5", () => {
  assert.strictEqual(list({ limit: 3 }).stations.length, 3);
  assert.strictEqual(list({ limit: 10 }).stations.length, 10);
  assert.strictEqual(list({ limit: 50 }).stations.length, 10);
  assert.strictEqual(list({ limit: 0 }).stations.length, 1);
  assert.strictEqual(list({ limit: "много" }).stations.length, 5);
});
test("body: D и L фильтруют, total_matching считает только их", () => {
  const d = list({ body: "D", limit: 10 }), l = list({ body: "L", limit: 10 });
  assert.ok(d.stations.every((s) => s.code.endsWith("-D")));
  assert.ok(l.stations.every((s) => s.code.endsWith("-L")));
  assert.strictEqual(d.total_matching, 22);
  assert.strictEqual(l.total_matching, 20);
  assert.strictEqual(l.stations[0].power_w, Math.max(...kb.stations.filter((s) => s.body === "L").map((s) => s.power_w)));
});
test("capacity desc: первая = максимум cap_wh; asc: минимум", () => {
  assert.strictEqual(list({ sort_by: "capacity" }).stations[0].cap_wh, maxCap);
  assert.strictEqual(list({ sort_by: "capacity", order: "asc" }).stations[0].cap_wh, Math.min(...kb.stations.map((s) => s.cap_wh)));
});
test("price asc: самая дешёвая = минимальная ненулевая цена; цена по запросу (0) в конце", () => {
  const prices = kb.stations.map((s) => s.price_rub).filter((p) => p > 0);
  assert.strictEqual(list({ sort_by: "price", order: "asc", limit: 10 }).stations[0].price_rub, Math.min(...prices));
  const kb0 = JSON.parse(JSON.stringify(kb));
  kb0.stations[0].price_rub = 0;
  kb0.stations[5].price_rub = 0;
  for (const order of ["asc", "desc"]) {
    const rows = T.execute("list_stations", { sort_by: "price", order, limit: 10 }, kb0).stations;
    const firstZero = rows.findIndex((s) => !s.price_rub);
    const tail = firstZero < 0 ? [] : rows.slice(firstZero);
    assert.ok(tail.every((s) => !s.price_rub), "нулевые цены не в конце (" + order + ")");
  }
  const all = T.execute("list_stations", { sort_by: "price", order: "asc", limit: 10 }, kb0);
  assert.ok(all.stations.every((s) => s.price_rub > 0), "первые 10 по возрастанию цены не должны содержать «по запросу»");
});
test("неизвестные параметры: ok:false с подсказкой", () => {
  assert.strictEqual(list({ sort_by: "weight" }).ok, false);
  assert.strictEqual(list({ order: "up" }).ok, false);
  assert.strictEqual(list({ body: "X" }).ok, false);
});
test("результат детерминирован (одинаковый вызов — одинаковый ответ)", () => {
  assert.deepStrictEqual(list({ sort_by: "power" }), list({ sort_by: "power" }));
});

console.log("\nитого: ok " + passed + ", ошибок " + failed);
process.exit(failed ? 1 : 0);
