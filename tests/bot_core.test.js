"use strict";
/* Тесты ядра бота (передача менеджеру, handoff) без LLM, без сети и без секретов: node tests/bot_core.test.js
   Модель подменяется функцией env.__fakeModel (тестовый хук в bot/core.js; в process.env функции быть не может). */
const path = require("path");
const assert = require("assert");

const core = require(path.join(__dirname, "..", "bot", "core.js"));
const { handle, HANDOFF_PHRASES, wantsHandoff, resolveHandoff } = core;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); }
}

const CONTACTS = "позвоните +7 978 728-00-02 или напишите на apv0050@gmail.com";

/* фейковая модель: отдаёт по одному заранее заданному шагу за вызов (text или вызов инструмента) */
function fakeModel(steps) {
  let i = 0;
  return async function () {
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s.call) return { content: { role: "model", parts: [{ functionCall: s.call }] }, text: "", calls: [s.call], finishReason: "STOP" };
    return { content: { role: "model", parts: [{ text: s.text }] }, text: s.text, calls: [], finishReason: "STOP" };
  };
}
async function ask(messages, steps) {
  const env = { __fakeModel: fakeModel(steps), RATE_LIMIT: "100000", DAILY_CAP: "1000000", TIMEOUT_MS: "5000" };
  const req = new Request("http://bot.local/chat", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:38800" },
    body: JSON.stringify({ messages }),
  });
  const res = await handle(req, env);
  assert.strictEqual(res.status, 200);
  return res.json();
}

(async () => {
  console.log("wantsHandoff / resolveHandoff");
  await test("список фраз вынесен в константу HANDOFF_PHRASES (не менее трёх)", () => {
    assert.ok(Array.isArray(HANDOFF_PHRASES) && HANDOFF_PHRASES.length >= 3);
  });
  await test("фразы «Уточните у менеджера», «уточним у менеджера», «передам менеджеру» (любой регистр) → handoff", () => {
    for (const t of ["Уточните у менеджера.", "это УТОЧНИТЕ У МЕНЕДЖЕРА", "Это уточним у менеджера", "Передам менеджеру ваш вопрос"]) assert.strictEqual(wantsHandoff(t), true, t);
  });
  await test("контакты менеджера в ответе (телефон в разных записях, почта) → handoff", () => {
    for (const t of ["Звоните +7 978 728-00-02", "позвоните 8 (978) 728-00-02", "+79787280002", "пишите на APV0050@gmail.com"]) assert.strictEqual(wantsHandoff(t), true, t);
  });
  await test("обычный ответ без фраз и контактов → не handoff", () => {
    for (const t of ["Подойдёт станция на 2 800 Вт, хватит на 12 часов.", "Цена 79 506 ₽ с доставкой.", "", null]) assert.strictEqual(wantsHandoff(t), false, String(t));
  });
  await test("resolveHandoff: первый раз true, при уже сказанном в истории false, вызов инструмента тоже без дубля", () => {
    const first = [{ role: "user", text: "q" }];
    assert.strictEqual(resolveHandoff("Уточните у менеджера: " + CONTACTS, first, false), true);
    assert.strictEqual(resolveHandoff("обычный ответ", first, true), true);
    const hist = [{ role: "user", text: "q" }, { role: "assistant", text: "Уточните у менеджера: " + CONTACTS }, { role: "user", text: "q2" }];
    assert.strictEqual(resolveHandoff("Уточните у менеджера: " + CONTACTS, hist, false), false);
    assert.strictEqual(resolveHandoff("обычный ответ", hist, true), false);
  });

  console.log("handle() с фейковой моделью");
  await test("ответ с «Уточните у менеджера» без вызова инструмента → handoff = true", async () => {
    const d = await ask([{ role: "user", text: "Какой тип розеток?" }], [{ text: "Уточните у менеджера: " + CONTACTS + "." }]);
    assert.strictEqual(d.handoff, true);
    assert.ok(/менеджер/.test(d.reply));
  });
  await test("ответ только с контактами (без фраз) → handoff = true", async () => {
    const d = await ask([{ role: "user", text: "Как заказать?" }], [{ text: "Заказ оформляет менеджер: " + CONTACTS + "." }]);
    assert.strictEqual(d.handoff, true);
  });
  await test("обычный ответ → handoff = false", async () => {
    const d = await ask([{ role: "user", text: "Привет" }], [{ text: "Здравствуйте! Какие приборы нужно питать?" }]);
    assert.strictEqual(d.handoff, false);
  });
  await test("модель вызвала handoff_to_manager → handoff = true", async () => {
    const d = await ask([{ role: "user", text: "Хочу заказать" }], [{ call: { name: "handoff_to_manager", args: { reason: "заказ" } } }, { text: "Передаю вас менеджеру." }]);
    assert.strictEqual(d.handoff, true);
  });
  await test("два таких ответа в одном диалоге → одно уведомление (второй handoff = false)", async () => {
    const reply1 = "Уточните у менеджера: " + CONTACTS + ".";
    const d1 = await ask([{ role: "user", text: "Какой тип розеток?" }], [{ text: reply1 }]);
    assert.strictEqual(d1.handoff, true);
    const history = [{ role: "user", text: "Какой тип розеток?" }, { role: "assistant", text: d1.reply }, { role: "user", text: "А сертификаты есть?" }];
    const d2 = await ask(history, [{ text: "Уточните у менеджера: " + CONTACTS + "." }]);
    assert.strictEqual(d2.handoff, false);
    assert.ok(/менеджер/.test(d2.reply), "текст ответа с контактами остаётся");
    const history3 = history.concat([{ role: "assistant", text: d2.reply }, { role: "user", text: "И гарантия завода?" }]);
    const d3 = await ask(history3, [{ call: { name: "handoff_to_manager", args: {} } }, { text: "Уточните у менеджера: " + CONTACTS + "." }]);
    assert.strictEqual(d3.handoff, false, "и вызов инструмента в том же диалоге не даёт повторного handoff");
  });
  await test("диалог без передачи менеджеру, затем передача: handoff только на втором ответе", async () => {
    const d1 = await ask([{ role: "user", text: "Привет" }], [{ text: "Здравствуйте! Что нужно питать?" }]);
    assert.strictEqual(d1.handoff, false);
    const history = [{ role: "user", text: "Привет" }, { role: "assistant", text: d1.reply }, { role: "user", text: "Есть сертификаты?" }];
    const d2 = await ask(history, [{ text: "Уточните у менеджера: " + CONTACTS + "." }]);
    assert.strictEqual(d2.handoff, true);
  });

  console.log("\nитого: ok " + passed + ", ошибок " + failed);
  process.exit(failed ? 1 : 0);
})();
