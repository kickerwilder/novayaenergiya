"use strict";
/* Тесты маскирования персональных данных (bot/pii.js и его применение в bot/core.js) без LLM и без сети: node tests/bot_pii.test.js
   Включая номера (карты, паспорт, ИНН, СНИЛС, счёт) и адреса. В тестах только вымышленные данные (тестовые номера карт, выдуманные паспорта и адреса). */
const path = require("path");
const assert = require("assert");

const { maskPII } = require(path.join(__dirname, "..", "bot", "pii.js"));
const core = require(path.join(__dirname, "..", "bot", "core.js"));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); }
}

(async () => {
  console.log("maskPII");
  await test("телефоны в разных записях → [ТЕЛЕФОН]", () => {
    for (const p of ["+7 978 728-00-02", "8 (978) 728-00-02", "89787280002", "7-978-728-00-02", "978 728 00 02", "+7(978)7280002", "+380 67 123 45 67", "8 800 555 35 35", "+7.978.728.00.02"]) {
      const out = maskPII("Позвоните мне: " + p + " после обеда");
      assert.strictEqual(out, "Позвоните мне: [ТЕЛЕФОН] после обеда", p + " → " + out);
    }
  });
  await test("e-mail → [EMAIL]", () => {
    assert.strictEqual(maskPII("пишите ivan.petrov@mail.ru, спасибо"), "пишите [EMAIL], спасибо");
    assert.strictEqual(maskPII("a_b+c@sub.domain.ru"), "[EMAIL]");
  });
  await test("цепочки, похожие на ФИО → [ФИО]", () => {
    assert.strictEqual(maskPII("Меня зовут Иванов Иван Иванович, нужна станция"), "Меня зовут [ФИО], нужна станция");
    assert.strictEqual(maskPII("Мария Ивановна"), "[ФИО]");
    assert.strictEqual(maskPII("Звать Мария Ивановна"), "[ФИО]", "слово перед именем с заглавной тоже маскируется (лучше лишнее, чем утечка)");
    assert.strictEqual(maskPII("Иван Петров хочет заказать"), "[ФИО] хочет заказать");
    assert.strictEqual(maskPII("Сидорова Анна Сергеевна"), "[ФИО]");
    assert.strictEqual(maskPII("Воробьёв Александр"), "[ФИО]");
    assert.strictEqual(maskPII("это Иванов И.И. звонил"), "это [ФИО] звонил");
    assert.strictEqual(maskPII("это И.И. Иванов звонил"), "это [ФИО] звонил");
  });
  await test("всё сразу: имя, телефон и почта в одном сообщении", () => {
    const out = maskPII("Петров Пётр Петрович, +7 978 728-00-02, pp@mail.ru");
    assert.strictEqual(out, "[ФИО], [ТЕЛЕФОН], [EMAIL]");
  });
  await test("обычные вопросы не портятся (цены, мощности, артикулы, названия)", () => {
    for (const t of [
      "Хочу станцию 1600 4200 2000 Вт", "Цена 315 330 ₽ с доставкой", "ZF16-2005.0 подойдёт для котла?", "Z2800-3800-L на 2 800 Вт · 3,8 кВт·ч",
      "8 000 Вт и 15 000 Вт·ч", "Внешний Аккумулятор НОВАЯ ЭНЕРДЖИ", "Нужна Станция Новая Энергия", "Холодильник 150 Вт, роутер 12 Вт, свет 50 Вт на 8 часов",
      "ZF80-20023", "Можно ли заряжать от генератора?", "Какая гарантия?", "Привезите в Симферополь Крым",
    ]) assert.strictEqual(maskPII(t), t, t + " → " + maskPII(t));
  });
  await test("пустые и нестроковые значения не падают", () => {
    assert.strictEqual(maskPII(""), "");
    assert.strictEqual(maskPII(null), "");
    assert.strictEqual(maskPII(undefined), "");
  });

  console.log("применение в core.js");
  function fake(capture) {
    return async (a) => { capture.contents = JSON.parse(JSON.stringify(a.contents)); return { content: { role: "model", parts: [{ text: "ок" }] }, text: "ок", calls: [], finishReason: "STOP" }; };
  }
  const baseEnv = (cap) => ({ __fakeModel: fake(cap), ALLOW_LOCALHOST: "1", RATE_LIMIT: "100000", DAILY_CAP: "1000000" });
  const post = (env, messages) => core.handle(new Request("http://bot.local/chat", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:1" }, body: JSON.stringify({ messages }) }), env);

  await test("в LLM уходит замаскированный текст клиента (и в истории), ответы бота не меняются", async () => {
    const cap = {};
    const res = await post(baseEnv(cap), [
      { role: "user", text: "Я Иванов Иван Иванович, телефон +7 978 728-00-02, почта ivan@mail.ru" },
      { role: "assistant", text: "Здравствуйте! Позвоните +7 978 728-00-02 или напишите на apv0050@gmail.com" },
      { role: "user", text: "А какая станция для холодильника?" },
    ]);
    assert.strictEqual(res.status, 200);
    const sent = JSON.stringify(cap.contents);
    assert.ok(sent.includes("[ФИО]") && sent.includes("[ТЕЛЕФОН]") && sent.includes("[EMAIL]"), sent);
    assert.ok(!/Иванов|ivan@mail|728-00-02.{0,200}после/.test(sent.split("model")[0] || ""), "ПДн клиента ушли в LLM");
    const userParts = cap.contents.filter((c) => c.role === "user").map((c) => c.parts[0].text).join(" | ");
    assert.ok(!/Иванов|ivan@mail\.ru|978 728/.test(userParts), userParts);
    const modelPart = cap.contents.find((c) => c.role === "model").parts[0].text;
    assert.ok(modelPart.includes("+7 978 728-00-02") && modelPart.includes("apv0050@gmail.com"), "контакты менеджера в ответе бота не маскируются");
  });
  await test("логи без текстов диалогов и без контактов (в том числе при сбое модели)", async () => {
    const logs = [];
    const oldLog = console.log, oldErr = console.error, oldWarn = console.warn;
    console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
    try {
      const secret = "Иванов Иван Иванович +7 978 111-22-33 ivan@mail.ru";
      await post(Object.assign(baseEnv({}), { LOG_QUESTIONS: "1" }), [{ role: "user", text: secret }]);
      const failing = Object.assign(baseEnv({}), { __fakeModel: async () => { throw new Error("сбой: " + secret); } });
      await post(failing, [{ role: "user", text: secret }]);
    } finally { console.log = oldLog; console.error = oldErr; console.warn = oldWarn; }
    const all = logs.join("\n");
    assert.ok(!/Иванов|111-22-33|ivan@mail/.test(all), "в логах есть данные клиента: " + all.slice(0, 200));
  });

  /* ===================== расширенное маскирование: номера и адреса (вымышленные данные) ===================== */
  const fs = require("fs");
  const ROOT = path.join(__dirname, "..");
  const kb = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "kb.json"), "utf8"));
  const eq = (input, expected) => assert.strictEqual(maskPII(input), expected, JSON.stringify(input) + " -> " + JSON.stringify(maskPII(input)));

  console.log("номера: положительные");
  await test("карта: с пробелами, с дефисами, слитно; 15-значная 4-6-5; карта не по Луну только со словом «карта»", () => {
    eq("Оплачу картой 4111 1111 1111 1111 завтра", "Оплачу картой [НОМЕР КАРТЫ] завтра");
    eq("карта 4111-1111-1111-1111", "карта [НОМЕР КАРТЫ]");
    eq("номер 4111111111111111", "номер [НОМЕР КАРТЫ]");
    eq("5555 5555 5555 4444", "[НОМЕР КАРТЫ]");
    eq("3782 822463 10005", "[НОМЕР КАРТЫ]");
    eq("6221234567890123456", "[НОМЕР КАРТЫ]");                       /* 19 цифр слитно */
    eq("карта 1234 5678 9012 3456", "карта [НОМЕР КАРТЫ]");            /* не проходит проверку Луна, но есть слово «карта» */
  });
  await test("осознанные ограничения: перечень чисел 4-4-4-4 без слова «карта» и без Луна не маскируется; «круглые» числа картой не считаются даже со случайным Луном", () => {
    eq("1234 5678 9012 3456", "1234 5678 9012 3456");
    eq("2800 3800 5000 8600", "2800 3800 5000 8600");
    eq("карта 2800 3800 5000 8600", "карта [НОМЕР КАРТЫ]");
    eq("1000 152841", "1000 152841");                                   /* мощность и цена без единиц, а не паспорт */
    eq("паспорт 1000 152841", "паспорт [ПАСПОРТ]");
    eq("150 300 100 60", "150 300 100 60");                             /* перечень мощностей, а не СНИЛС */
  });
  await test("паспорт РФ: 4512 345678, 45 12 345678, 4512345678 (со словом «паспорт»), серия и номер словами", () => {
    eq("4512 345678", "[ПАСПОРТ]");
    eq("45 12 345678", "[ПАСПОРТ]");
    eq("45-12-345678", "[ПАСПОРТ]");
    eq("Паспорт 4512345678 выдан", "Паспорт [ПАСПОРТ] выдан");
    eq("паспорт: 45 12 345678", "паспорт: [ПАСПОРТ]");
    eq("серия 4512 номер 345678", "[ПАСПОРТ]");
    eq("0412345678", "[ПАСПОРТ]");                                     /* десять цифр подряд не с 3-9: не телефон */
  });
  await test("ИНН 10 и 12 цифр, СНИЛС, расчётный счёт (20 цифр, слитно и группами)", () => {
    eq("ИНН 1234567890", "ИНН [НОМЕР]");
    eq("ИНН: 123456789012", "ИНН: [НОМЕР]");
    eq("123456789012", "[НОМЕР]");
    eq("СНИЛС 112-233-445 95", "СНИЛС [НОМЕР]");
    eq("123-456-789 01", "[НОМЕР]");
    eq("12345678901", "[НОМЕР]");
    eq("СНИЛС 11223344595", "СНИЛС [НОМЕР]");
    eq("р/с 40817810123456789012", "р/с [НОМЕР]");
    eq("счёт 40817 810 1 2345 6789012", "счёт [НОМЕР]");
  });
  await test("десять цифр подряд без подписи остаются за телефонной функцией (приоритет у неё)", () => {
    eq("4512345678", "[ТЕЛЕФОН]");
    eq("9787280002", "[ТЕЛЕФОН]");
    eq("978 728 00 02", "[ТЕЛЕФОН]");
    eq("+7 978 728-00-02", "[ТЕЛЕФОН]");
  });

  console.log("адреса: положительные");
  await test("улица и улица с названием: ул., улица, пр-т, проспект, пер., переулок, ш., шоссе, б-р, бульвар, наб., пл., мкр.", () => {
    eq("Живу на ул. Тестовая, д. 5, кв. 12", "Живу на [АДРЕС]");
    eq("улица Мира 10", "[АДРЕС]");
    eq("на улице Мира дом 5", "на [АДРЕС]");
    eq("проспект Победы, дом 5А, корп. 2, кв. 7", "[АДРЕС]");
    eq("пр-т Мира 10/2", "[АДРЕС]");
    eq("пер. Садовый д.3/2", "[АДРЕС]");
    eq("переулок Тихий, 4", "[АДРЕС]");
    eq("ш. Московское 15", "[АДРЕС]");
    eq("б-р Строителей, д. 8, стр. 1", "[АДРЕС]");
    eq("бульвар Весенний 3, подъезд 2, этаж 5, офис 17", "[АДРЕС]");
    eq("наб. Речная д. 1", "[АДРЕС]");
    eq("пл. Свободы, дом 9", "[АДРЕС]");
    eq("мкр. Северный, д. 14", "[АДРЕС]");
    eq("ул. 8 Марта 5", "[АДРЕС]");
    eq("ул. 50 лет Октября, д. 3", "[АДРЕС]");
    eq("на ул. тестовая 5", "на [АДРЕС]");
  });
  await test("«д. 5, кв. 12» и «кв. 12» отдельно; индекс только со словом «индекс»", () => {
    eq("д. 5, кв. 12", "[АДРЕС]");
    eq("дом 7 квартира 3", "[АДРЕС]");
    eq("Привезите в д. 5 корп. 2, кв. 12", "Привезите в [АДРЕС]");
    eq("кв. 12", "[АДРЕС]");
    eq("индекс 298100", "индекс [АДРЕС]");
    eq("индекс: 298100, Ялта", "индекс: [АДРЕС], Ялта");
    eq("298100 (индекс)", "[АДРЕС] (индекс)");
    eq("Ялта, 298100", "Ялта, 298100");                                  /* без слова «индекс» не маскируем */
  });
  await test("город и регион сами по себе не маскируются; адрес в середине фразы и в конце", () => {
    eq("Доставка в Симферополь, Крым, ул. Тестовая 5, срок?", "Доставка в Симферополь, Крым, [АДРЕС], срок?");
    eq("Мой адрес: г. Ялта, ул. Тестовая, д. 5, кв. 12", "Мой адрес: г. Ялта, [АДРЕС]");
    eq("Республика Крым, г. Севастополь", "Республика Крым, г. Севастополь");
  });
  await test("несколько данных в одном сообщении: e-mail, телефон, карта, паспорт, адрес, ФИО", () => {
    const out = maskPII("Иванов Иван Иванович, паспорт 4512 345678, карта 4111 1111 1111 1111, тел. +7 978 111-22-33, ivan@mail.ru, ул. Тестовая, д. 5, кв. 12");
    assert.strictEqual(out, "[ФИО], паспорт [ПАСПОРТ], карта [НОМЕР КАРТЫ], тел. [ТЕЛЕФОН], [EMAIL], [АДРЕС]");
  });
  await test("порядок: сначала e-mail и телефоны, затем номера и адреса, затем ФИО (название улицы не принимается за фамилию)", () => {
    eq("Звоните +7 978 111-22-33, живу на ул. Льва Толстого, д. 5", "Звоните [ТЕЛЕФОН], живу на [АДРЕС]");
    eq("ул. Ломоносова 12, Петров Пётр Петрович", "[АДРЕС], [ФИО]");
  });

  console.log("идемпотентность, сохранение текста, история");
  const POSITIVE = ["Оплачу картой 4111 1111 1111 1111 завтра", "Паспорт 4512345678 выдан", "ИНН 123456789012", "СНИЛС 112-233-445 95", "р/с 40817810123456789012",
    "ул. Тестовая, д. 5, кв. 12", "д. 5, кв. 12", "индекс 298100", "Иванов Иван Иванович, +7 978 111-22-33, ivan@mail.ru, ул. Мира 10, карта 5555 5555 5555 4444"];
  await test("идемпотентность: повторный вызов ничего не меняет; метки не ломаются", () => {
    for (const s of POSITIVE) assert.strictEqual(maskPII(maskPII(s)), maskPII(s), s);
    const labels = "[ТЕЛЕФОН] [EMAIL] [ФИО] [НОМЕР КАРТЫ] [ПАСПОРТ] [НОМЕР] [АДРЕС]";
    assert.strictEqual(maskPII(labels), labels);
    assert.strictEqual(maskPII("Позвоните [ТЕЛЕФОН], карта [НОМЕР КАРТЫ], ул. [АДРЕС]"), "Позвоните [ТЕЛЕФОН], карта [НОМЕР КАРТЫ], ул. [АДРЕС]");
  });
  await test("остальной текст сохраняется до символа (пробелы, переносы, знаки, регистр)", () => {
    eq("Здравствуйте!\n\nМоя карта — 4111 1111 1111 1111; адрес: ул. Тестовая, д. 5.\nСпасибо  ,  до связи!", "Здравствуйте!\n\nМоя карта — [НОМЕР КАРТЫ]; адрес: [АДРЕС].\nСпасибо  ,  до связи!");
    eq("  начало 12345678901 конец  ", "  начало [НОМЕР] конец  ");
  });
  await test("пустые и нестроковые значения по-прежнему не падают", () => {
    for (const v of ["", null, undefined, 0, 12345678901234567890]) assert.doesNotThrow(() => maskPII(v));
  });

  console.log("отрицательные: ничего не должно маскироваться");
  const NEG_FIXED = [
    "на улице", "на улице холодно", "на улице 5 градусов", "на улице Мира 5 градусов", "для дома и дачи", "для квартиры", "для квартиры 60 кв. м", "100 кв.м", "в частном доме", "в доме", "квартира", "Квартира большая",
    "СНТ", "гараж", "дача в СНТ", "дом 5 этажей", "улица Ленина", "проспект", "переулок", "шоссе рядом", "площадь дома 120 м", "набережная",
    "Цена 1 500 000 ₽", "до 5 000 000 ₽", "5 000 000 000 ₽", "Хочу станцию 1600 4200 2000 Вт", "1600 4200 2000", "2800 3800 5000 8600", "1600 5000 77237", "8 000 Вт и 15 000 Вт·ч",
    "габариты 45х30х28 см", "размер 45x30x28", "вес 25 кг", "вес 19,5 кг", "в 2024 году", "в 2023-2025 годах", "скидка 15 %", "в 10:30", "с 9:00 до 18:00", "25 августа 2026",
    "z1600-5000-L", "Z1600-4200-D и Z2800-3800-L", "ZF16-2002.6", "ZF16-2005.0", "ZF80-20023", "z1600-5000-8600-10000", "1600-5000-8600", "заряд 80 % за 2,5 часа",
    "Нужно 150 Вт холодильник, 60 Вт роутер, 100 Вт котёл", "ёмкость 5000 Вт·ч, мощность 1600 Вт, пик 3200 Вт", "срок доставки 25 дней", "гарантия 6 месяцев, продление +10 000 ₽",
  ];
  await test("фразы из задания и типичные числа (" + NEG_FIXED.length + " фраз): текст не изменился", () => {
    const bad = NEG_FIXED.filter((s) => maskPII(s) !== s).map((s) => s + " -> " + maskPII(s));
    assert.deepStrictEqual(bad, []);
  });

  /* вопросы по КАЖДОЙ модели из data/: цена, мощность, ёмкость, габариты, вес, артикулы в разных записях */
  const fmt = (n, sep) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const stations = kb.stations;
  const dataPhrases = [];
  for (const s of stations) {
    const sp = ((kb.specs[s.article] || []).find((x) => x.body === s.body) || {}).specs || {};
    const price = s.price_rub, p = s.power_w, c = s.cap_wh;
    for (const sep of [" ", " ", " ", ""]) dataPhrases.push("Сколько стоит " + s.code + " за " + fmt(price, sep) + " ₽ с доставкой?");
    dataPhrases.push("Станция " + s.article + ": " + p + " Вт, " + c + " Вт·ч, цена " + fmt(price, " ") + " руб.");
    dataPhrases.push("Хочу " + p + " Вт и " + c + " Вт·ч, бюджет " + price + " ₽");
    dataPhrases.push(p + " " + c + " " + price);
    dataPhrases.push(p + " Вт " + c + " Вт·ч " + fmt(price, " ") + " ₽");
    dataPhrases.push("Нужна " + s.code + " или " + s.article + ", " + (s.peak_w || p) + " Вт пик");
    if (sp.size_cm) dataPhrases.push("Габариты " + sp.size_cm.l + "х" + sp.size_cm.w + "х" + sp.size_cm.h + " см, вес " + sp.weight_kg + " кг, в упаковке " + sp.weight_packed_kg + " кг");
    if (sp.package_cm) dataPhrases.push("Упаковка " + sp.package_cm.l + "х" + sp.package_cm.w + "х" + sp.package_cm.h + " см, " + sp.package_cm.l + " " + sp.package_cm.w + " " + sp.package_cm.h);
  }
  for (let i = 0; i < stations.length - 1; i++) {    /* соседние модели: числа двух моделей подряд */
    const a = stations[i], b = stations[i + 1];
    dataPhrases.push(a.power_w + " " + a.cap_wh + " " + b.power_w + " " + b.cap_wh);
    dataPhrases.push(a.code + " и " + b.code + ": " + fmt(a.price_rub, " ") + " ₽ и " + fmt(b.price_rub, " ") + " ₽");
    dataPhrases.push(a.price_rub + " " + b.price_rub);
  }
  let negChecked = 0;
  await test("для каждой из " + stations.length + " моделей из data/kb.json: цена в разных записях, мощность, ёмкость, габариты, вес, артикулы (" + dataPhrases.length + " фраз): ложных срабатываний 0", () => {
    const bad = dataPhrases.filter((s) => maskPII(s) !== s).map((s) => s + " -> " + maskPII(s));
    negChecked = dataPhrases.length;
    assert.deepStrictEqual(bad.slice(0, 5), []);
    assert.ok(dataPhrases.length > 400, "слишком мало фраз: " + dataPhrases.length);
  });
  await test("все сообщения клиента из tests/bot_cases.json не получают новых меток (номер, адрес, паспорт, карта)", () => {
    const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "bot_cases.json"), "utf8"));
    const texts = [];
    for (const c of cases) { (c.messages || []).forEach((m) => m.role === "user" && texts.push(m.text)); (c.turns || []).forEach((t) => texts.push(t.say)); }
    const bad = texts.filter((t) => /\[(НОМЕР КАРТЫ|ПАСПОРТ|НОМЕР|АДРЕС)\]/.test(maskPII(t)));
    assert.deepStrictEqual(bad, []);
    assert.ok(texts.length > 80, "корпус слишком мал: " + texts.length);
  });
  console.log("  (отрицательных фраз проверено: " + (NEG_FIXED.length + negChecked) + " из заданных и построенных по данным каталога, ложных срабатываний 0)");

  console.log("сквозной тест через core (модель подменена)");
  const SECRETS = ["4111 1111 1111 1111", "4512 345678", "123456789012", "Тестовая", "298100", "ivan@mail.ru", "111-22-33", "Иванов"];
  await test("в запрос к модели (история и текущее сообщение) вместо данных стоят метки; ответы бота не меняются; в логах ни данных, ни меток", async () => {
    const cap = {};
    const logs = [];
    const old = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" ")); console.warn = (...a) => logs.push(a.join(" "));
    let res;
    try {
      res = await post(baseEnv(cap), [
        { role: "user", text: "Паспорт 4512 345678, карта 4111 1111 1111 1111, ИНН 123456789012" },
        { role: "assistant", text: "Здравствуйте! Личные данные в чате не нужны. Позвоните +7 978 728-00-02." },
        { role: "user", text: "Доставка: индекс 298100, г. Ялта, ул. Тестовая, д. 5, кв. 12. Иванов Иван Иванович, +7 978 111-22-33, ivan@mail.ru. Какая станция нужна для холодильника?" },
      ]);
    } finally { console.log = old.log; console.error = old.error; console.warn = old.warn; }
    assert.strictEqual(res.status, 200);
    const sent = JSON.stringify(cap.contents);
    for (const s of SECRETS) assert.ok(!sent.includes(s), "в запрос к модели ушло: " + s);
    for (const label of ["[ПАСПОРТ]", "[НОМЕР КАРТЫ]", "[НОМЕР]", "[АДРЕС]", "[ТЕЛЕФОН]", "[EMAIL]", "[ФИО]"]) assert.ok(sent.includes(label), "нет метки " + label + " в: " + sent);
    assert.ok(sent.includes("Личные данные в чате не нужны") && sent.includes("+7 978 728-00-02"), "ответ бота и контакты менеджера не должны маскироваться");
    assert.ok(sent.includes("Какая станция нужна для холодильника?"), "обычный вопрос не должен меняться");
    const all = logs.join("\n");
    for (const s of SECRETS.concat(["[ПАСПОРТ]", "[НОМЕР КАРТЫ]", "[АДРЕС]", "[НОМЕР]"])) assert.ok(!all.includes(s), "в логе: " + s);
  });
  await test("в Telegram-уведомление менеджеру уходят только метки, без номеров и адреса клиента", async () => {
    const sent = [];
    const e = Object.assign(baseEnv({}), {
      TELEGRAM_BOT_TOKEN: "123456:TEST-TOKEN-DO-NOT-LEAK", TELEGRAM_MANAGER_CHAT_ID: "-100500",
      __telegram: async (method, payload) => { sent.push(payload.text); return { ok: true }; },
      __fakeModel: async () => ({ content: { role: "model", parts: [{ text: "Уточните у менеджера: позвоните +7 978 728-00-02." }] }, text: "Уточните у менеджера: позвоните +7 978 728-00-02.", calls: [], finishReason: "STOP" }),
    });
    const res = await post(e, [{ role: "user", text: "Паспорт 4512 345678, карта 4111 1111 1111 1111, адрес ул. Тестовая, д. 5, кв. 12: какой тип сертификата?" }]);
    assert.strictEqual((await res.json()).handoff, true);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(sent.length, 1);
    for (const s of ["4512 345678", "4111 1111 1111 1111", "Тестовая", "кв. 12"]) assert.ok(!sent[0].includes(s), "в уведомлении: " + s);
    assert.ok(/\[ПАСПОРТ\]/.test(sent[0]) && /\[НОМЕР КАРТЫ\]/.test(sent[0]) && /\[АДРЕС\]/.test(sent[0]), sent[0]);
  });

  console.log("\nитого: ok " + passed + ", ошибок " + failed);
  process.exit(failed ? 1 : 0);
})();
