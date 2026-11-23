"use strict";
/* Тесты маскирования персональных данных (bot/pii.js и его применение в bot/core.js) без LLM и без сети: node tests/bot_pii.test.js */
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

  console.log("\nитого: ok " + passed + ", ошибок " + failed);
  process.exit(failed ? 1 : 0);
})();
