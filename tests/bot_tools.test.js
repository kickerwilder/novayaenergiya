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
test("строки содержат нужные поля (включая specs и unconfirmed)", () => {
  const row = list({ limit: 1 }).stations[0];
  assert.deepStrictEqual(Object.keys(row).sort(), ["article", "body", "cap_wh", "code", "peak_w", "power_w", "price_note", "price_rub", "specs", "title", "unconfirmed"]);
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

console.log("specs (характеристики по каталогам завода)");
const SPEC_KEYS = ["weight_kg", "weight_packed_kg", "size_cm", "package_cm", "sockets_ac", "dc_voltage_v", "dc_connectors", "usb"];
test("на каждый артикул есть specs: 31 артикул, 42 версии, все поля, у D и L общего артикула обе записи с полем body", () => {
  assert.strictEqual(Object.keys(kb.specs).length, 31);
  assert.strictEqual(Object.values(kb.specs).reduce((n, v) => n + v.length, 0), 42);
  for (const art of new Set(kb.stations.map((s) => s.article))) {
    const entries = kb.specs[art];
    assert.ok(entries && entries.length, "нет specs для " + art);
    const bodies = kb.stations.filter((s) => s.article === art).map((s) => s.body).sort();
    assert.deepStrictEqual(entries.map((e) => e.body).sort(), bodies, art + ": корпуса specs и станций не совпали");
    entries.forEach((e) => {
      SPEC_KEYS.forEach((k) => assert.ok(e.specs[k] !== undefined && e.specs[k] !== null && e.specs[k] !== "", art + " " + e.body + ": нет поля " + k));
      assert.ok(Array.isArray(e.unconfirmed));
    });
  }
});
test("get_station отдаёт specs и unconfirmed для всех 42 версий", () => {
  for (const st of kb.stations) {
    const s0 = get(st.code).stations[0];
    assert.ok(s0.specs && s0.specs.weight_kg > 0, st.code + ": нет specs");
    assert.ok(Array.isArray(s0.unconfirmed), st.code + ": нет unconfirmed");
    assert.ok(/каталогу завода/.test(s0.specs_note));
  }
});
test("значения specs совпадают с исходной таблицей data/source/station_specs.json", () => {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "source", "station_specs.json"), "utf8")).stations;
  assert.strictEqual(Object.keys(src).length, 42);
  for (const [code, e] of Object.entries(src)) {
    const s0 = get(code).stations[0];
    assert.strictEqual(s0.article, e.article);
    assert.strictEqual(s0.specs.weight_kg, e.weight_kg);
    assert.deepStrictEqual(s0.specs.size_cm, e.size_cm);
    assert.deepStrictEqual(s0.specs.sockets_ac, e.sockets_ac);
    assert.strictEqual(s0.specs.usb, e.usb);
    assert.deepStrictEqual(s0.unconfirmed.map((u) => u.field), e.unconfirmed.map((u) => u.field));
  }
});
test("Z1600-5000-L: порты USB помечены unconfirmed (бот не должен называть USB-C фактом)", () => {
  const u = get("Z1600-5000-L").stations[0].unconfirmed.find((x) => x.field === "usb");
  assert.ok(u && /расходятся/.test(u.note));
});
test("Z4000-4600-D: розетка 16 А «до 4000 Вт» помечена unconfirmed (socket16)", () => {
  const s0 = get("Z4000-4600-D").stations[0];
  assert.strictEqual(s0.specs.sockets_ac.ac_16a.max_w, 4000);
  assert.ok(s0.unconfirmed.some((x) => x.field === "socket16"));
});
test("шесть светлых версий: XT90 «30 А и 900/1000 Вт при 24 В» помечено unconfirmed (dc_connectors), числа остаются только в specs", () => {
  for (const code of ["Z2800-6200-L", "Z4000-6200-L", "Z4000-8600-L", "Z4000-10000-L", "Z5000-8600-L", "Z5000-10000-L"]) {
    const s0 = get(code).stations[0];
    const u = s0.unconfirmed.find((x) => x.field === "dc_connectors");
    assert.ok(u && /не согласуется/.test(u.note) && /уточняется у завода/.test(u.note), code + ": нет пометки dc_connectors");
    assert.ok(/XT90/.test(s0.specs.dc_connectors), code);
  }
  assert.ok(!get("Z1600-5000-L").stations[0].unconfirmed.some((x) => x.field === "dc_connectors"), "лишняя пометка у Z1600-5000-L");
});
test("list_stations отдаёт specs и unconfirmed в строках", () => {
  list({ limit: 10 }).stations.forEach((row) => {
    assert.ok(row.specs && row.specs.weight_kg > 0, row.code);
    assert.ok(Array.isArray(row.unconfirmed));
  });
});
test("публичные файлы без запрещённых слов", () => {
  for (const f of ["data/kb.json", "data/source/station_specs.json", "bot/prompt.md"]) {
    assert.ok(!/постав[щ]ик|наце[н]к|себесто[и]м|мар[ж]а/i.test(fs.readFileSync(path.join(ROOT, f), "utf8")), f + ": запрещённое слово");
  }
});

console.log("информация владельца: тип розеток и способы зарядки");
const SRC_SPECS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "source", "station_specs.json"), "utf8"));
const OC = SRC_SPECS.common.owner_confirmed;
test("station_specs.json: блок common.owner_confirmed с источником «информация владельца», _meta.not_in_catalog не тронут", () => {
  assert.ok(/информация владельца.*не подтверждено заводом/.test(OC.source));
  assert.ok(/европейского типа/.test(OC.ac_socket_type));
  const m = OC.charging_methods;
  assert.strictEqual(m.solar.external_mppt, true);
  assert.strictEqual(m.solar.in_kit, false);
  assert.strictEqual(m.solar.builtin_mppt, false);
  assert.strictEqual(m.car.connector, "XT90");
  assert.ok(m.generator.short && m.generator.full);
  assert.ok(SRC_SPECS._meta.not_in_catalog.includes("тип розеток 220 В (форма вилки)"), "_meta.not_in_catalog изменён");
  assert.strictEqual(SRC_SPECS._meta.not_in_catalog.length, 7);
});
test("kb.json: owner_confirmed импортирован из таблицы (не вручную)", () => {
  assert.deepStrictEqual(kb.owner_confirmed, { source: OC.source, ac_socket_type: OC.ac_socket_type, charging_methods: OC.charging_methods });
});
test("car_ok = dc_voltage_v 12 В из данных: 12 версий, совпадает с таблицей", () => {
  const need = OC.charging_methods.car.requires_dc_voltage_v;
  const expected = Object.entries(SRC_SPECS.stations).filter(([, e]) => e.dc_voltage_v === need).map(([c]) => c).sort();
  assert.strictEqual(expected.length, 12);
  assert.deepStrictEqual(kb.stations.filter((s) => s.car_ok).map((s) => s.code).sort(), expected);
  for (const st of kb.stations) assert.strictEqual(get(st.code).stations[0].car_ok, expected.includes(st.code), st.code);
});
test("get_station отдаёт ac_socket_type, charging (сеть, солнечные панели, авто, генератор) и источник", () => {
  for (const st of kb.stations) {
    const s0 = get(st.code).stations[0];
    assert.ok(/европейского типа/.test(s0.ac_socket_type));
    assert.ok(/информация владельца/.test(s0.owner_info_source));
    assert.strictEqual(s0.charging.solar.builtin_mppt, false);
    assert.strictEqual(s0.charging.solar.external_mppt, true);
    assert.strictEqual(s0.charging.generator.short, OC.charging_methods.generator.short);
    assert.strictEqual(s0.charging.generator.full, OC.charging_methods.generator.full);
    assert.strictEqual(s0.charging.car.car_ok, s0.car_ok);
    assert.ok(s0.car_ok ? /XT90/.test(s0.charging.car.answer) : /менеджеру с контактами/.test(s0.charging.car.answer), st.code);
  }
});
test("FAQ «Чем и как можно заряжать станцию?»: один раз, старый вопрос заменён, без «электростанц», предпоследняя строка = generator.short, последняя про температуру", () => {
  const faq = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "faq.json"), "utf8"));
  const items = faq.filter((f) => /заряж/.test(f.q));
  assert.strictEqual(items.length, 1, "вопросов про зарядку: " + items.length);
  assert.strictEqual(items[0].q, "Чем и как можно заряжать станцию?");
  assert.ok(!faq.some((f) => f.q === "Как и от чего заряжается станция?"));
  assert.ok(!/электростанц/i.test(items[0].a));
  const lines = items[0].a.split("\n");
  assert.strictEqual(lines[lines.length - 1], "Заряжать станцию можно при температуре от 0 до +45 °C.");
  assert.strictEqual(lines[lines.length - 2], OC.charging_methods.generator.short);
  assert.ok(/внешний MPPT-контроллер/.test(items[0].a) && /XT90/.test(items[0].a) && /12 В/.test(items[0].a));
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.strictEqual(html.split("Чем и как можно заряжать станцию?").length - 1, 2, "ожидалось: видимый FAQ и JSON-LD");
  assert.ok(!html.includes("Как и от чего заряжается станция?"));
  assert.strictEqual(kb.faq.filter((f) => f.q === "Чем и как можно заряжать станцию?").length, 1);
  assert.strictEqual(kb.faq.find((f) => /заряжать/.test(f.q)).a, items[0].a);
});
test("тип розеток и вход под солнечные панели больше не в списках «в данных нет / к уточнению»", () => {
  assert.ok(!kb.clarify.some((r) => /вход для солнечных панелей|Тип розеток/.test(r)));
  assert.ok(!kb.rules.some((r) => /переходник/i.test(r)));
  const prompt = fs.readFileSync(path.join(ROOT, "bot", "prompt.md"), "utf8");
  assert.ok(!/переходник/i.test(prompt));
  assert.ok(!/нет: типа розеток|вход под солнечные панели, нестандартный/.test(prompt));
});

test("catalog.js: поле dcV у всех 42 версий равно specs.dc_voltage_v из таблицы (12 В: 12, 24 В: 21, 48 В: 9)", () => {
  const vm = require("vm");
  const DATA = vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data", "catalog.js"), "utf8") + "; DATA");
  const counts = {};
  let n = 0;
  for (const c of DATA.combos) for (const v of Object.values(c.vers)) {
    n++;
    assert.strictEqual(v.dcV, SRC_SPECS.stations[v.code].dc_voltage_v, v.code);
    counts[v.dcV] = (counts[v.dcV] || 0) + 1;
  }
  assert.strictEqual(n, 42);
  assert.deepStrictEqual(counts, { 12: 12, 24: 21, 48: 9 });
});

console.log("\nитого: ok " + passed + ", ошибок " + failed);
process.exit(failed ? 1 : 0);
