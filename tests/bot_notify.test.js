"use strict";
/* Тесты уведомления менеджеру в Telegram, CORS и маршрутизации через PROXY_URL без LLM и без сети наружу: node tests/bot_notify.test.js
   Telegram подменяется функцией env.__telegram (тестовый хук в bot/telegram.js), модель — env.__fakeModel. */
const fs = require("fs");
const net = require("net");
const path = require("path");
const assert = require("assert");

const BOT = path.join(__dirname, "..", "bot");
const core = require(path.join(BOT, "core.js"));
const tg = require(path.join(BOT, "telegram.js"));
const { transport } = require(path.join(BOT, "provider.js"));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); }
}

const CONTACTS = "позвоните +7 978 728-00-02 или напишите на apv0050@gmail.com";
const MANAGER = "Уточните у менеджера: " + CONTACTS + ".";
const TOKEN = "123456:TEST-TOKEN-DO-NOT-LEAK";
const fakeModel = (text) => async () => ({ content: { role: "model", parts: [{ text }] }, text, calls: [], finishReason: "STOP" });
function env(extra) {
  const sent = [];
  const e = Object.assign({
    ALLOW_LOCALHOST: "1", RATE_LIMIT: "100000", DAILY_CAP: "1000000", TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_MANAGER_CHAT_ID: "-100500",
    __telegram: async (method, payload) => { sent.push({ method, payload }); return { ok: true }; },
  }, extra || {});
  return { e, sent };
}
const post = (e, messages, origin) => core.handle(new Request("http://bot.local/chat", {
  method: "POST", headers: { "content-type": "application/json", origin: origin || "http://localhost:1" }, body: JSON.stringify({ messages }),
}), e);
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log("уведомление менеджеру");
  await test("handoff → одно sendMessage: chat id из env, замаскированная суть вопроса, время МСК, без ссылок и без контактов клиента", async () => {
    const { e, sent } = env({ __fakeModel: fakeModel(MANAGER) });
    const res = await post(e, [{ role: "user", text: "Я Иванов Иван Иванович, +7 978 111-22-33, ivan@mail.ru: какой тип сертификата у станции?" }]);
    const d = await res.json();
    assert.strictEqual(d.handoff, true);
    await tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].method, "sendMessage");
    assert.strictEqual(sent[0].payload.chat_id, "-100500");
    const text = sent[0].payload.text;
    assert.ok(/\[ФИО\]/.test(text) && /\[ТЕЛЕФОН\]/.test(text) && /\[EMAIL\]/.test(text), text);
    assert.ok(!/Иванов|111-22-33|ivan@mail/.test(text), "в уведомлении данные клиента: " + text);
    assert.ok(/Время: \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(МСК\)/.test(text), text);
    assert.ok(!/https?:\/\/|t\.me|диалог:/i.test(text), "в уведомлении ссылка: " + text);
    assert.ok(!text.includes(TOKEN), "токен в тексте");
  });
  await test("обычный ответ (без передачи менеджеру) → уведомления нет", async () => {
    const { e, sent } = env({ __fakeModel: fakeModel("Здравствуйте! Какие приборы нужно питать?") });
    await post(e, [{ role: "user", text: "Привет" }]);
    await tick();
    assert.strictEqual(sent.length, 0);
  });
  await test("один раз на диалог: второй такой ответ в том же диалоге не даёт повторного уведомления", async () => {
    const { e, sent } = env({ __fakeModel: fakeModel(MANAGER) });
    const d1 = await (await post(e, [{ role: "user", text: "Есть сертификаты?" }])).json();
    assert.strictEqual(d1.handoff, true);
    const history = [{ role: "user", text: "Есть сертификаты?" }, { role: "assistant", text: d1.reply }, { role: "user", text: "А гарантия завода?" }];
    const d2 = await (await post(e, history)).json();
    assert.strictEqual(d2.handoff, false);
    await tick();
    assert.strictEqual(sent.length, 1, "уведомлений: " + sent.length);
  });
  await test("в уведомление попадает и предыдущий вопрос клиента (контекст), тоже замаскированный", async () => {
    const { e, sent } = env({ __fakeModel: fakeModel(MANAGER) });
    await post(e, [{ role: "user", text: "Мой телефон 89787280002, станция для дачи" }, { role: "assistant", text: "Какие приборы?" }, { role: "user", text: "А есть сертификаты?" }]);
    await tick();
    assert.strictEqual(sent.length, 1);
    assert.ok(/Вопрос: «А есть сертификаты\?»/.test(sent[0].payload.text), sent[0].payload.text);
    assert.ok(/Перед этим клиент спрашивал: «Мой телефон \[ТЕЛЕФОН\], станция для дачи»/.test(sent[0].payload.text), sent[0].payload.text);
  });
  await test("сбой Telegram не ломает ответ клиенту и не пишет токен в лог", async () => {
    const logs = [];
    const oldErr = console.error; console.error = (...a) => logs.push(a.join(" "));
    try {
      const { e } = env({ __fakeModel: fakeModel(MANAGER), __telegram: async () => { const x = new Error("boom " + TOKEN); x.status = 502; throw x; } });
      const res = await post(e, [{ role: "user", text: "Есть сертификаты?" }]);
      const d = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(d.handoff, true);
      assert.ok(/менеджер/.test(d.reply));
      await tick(); await tick();
    } finally { console.error = oldErr; }
    const all = logs.join("\n");
    assert.ok(!all.includes(TOKEN), "токен в логе");
    assert.ok(/tg_error: http 502/.test(all), all);
  });
  await test("без TELEGRAM_BOT_TOKEN и chat id уведомление пропускается без ошибки", async () => {
    const r = await tg.notifyManager({}, "вопрос", "");
    assert.deepStrictEqual(r, { sent: false, skipped: true });
    const res = await post({ ALLOW_LOCALHOST: "1", RATE_LIMIT: "100000", DAILY_CAP: "1000000", __fakeModel: fakeModel(MANAGER) }, [{ role: "user", text: "q" }]);
    assert.strictEqual((await res.json()).handoff, true);
  });
  await test("handoff_to_manager (вызов инструмента) тоже даёт ровно одно уведомление", async () => {
    const { e, sent } = env();
    let step = 0;
    e.__fakeModel = async () => (step++ === 0
      ? { content: { role: "model", parts: [{ functionCall: { name: "handoff_to_manager", args: {} } }] }, text: "", calls: [{ name: "handoff_to_manager", args: {} }], finishReason: "STOP" }
      : { content: { role: "model", parts: [{ text: "Передаю вас менеджеру." }] }, text: "Передаю вас менеджеру.", calls: [], finishReason: "STOP" });
    const d = await (await post(e, [{ role: "user", text: "Хочу заказать" }])).json();
    assert.strictEqual(d.handoff, true);
    await tick();
    assert.strictEqual(sent.length, 1);
  });

  console.log("CORS");
  await test("разрешены https://novaya-energy.ru и https://www.novaya-energy.ru; чужие и localhost (без ALLOW_LOCALHOST) отклоняются с 403", async () => {
    const base = { RATE_LIMIT: "100000", DAILY_CAP: "1000000", __fakeModel: fakeModel("ок") };
    for (const o of ["https://novaya-energy.ru", "https://www.novaya-energy.ru"]) {
      const res = await post(Object.assign({}, base), [{ role: "user", text: "q" }], o);
      assert.strictEqual(res.status, 200, o);
      assert.strictEqual(res.headers.get("access-control-allow-origin"), o);
    }
    for (const o of ["https://evil.example", "http://novaya-energy.ru", "https://novaya-energy.ru.evil.example", "http://localhost:1", "http://127.0.0.1:8080"]) {
      const res = await post(Object.assign({}, base), [{ role: "user", text: "q" }], o);
      assert.strictEqual(res.status, 403, o);
    }
    const dev = await post(Object.assign({ ALLOW_LOCALHOST: "1" }, base), [{ role: "user", text: "q" }], "http://localhost:1");
    assert.strictEqual(dev.status, 200);
  });
  await test("ALLOWED_ORIGINS из env заменяет список по умолчанию", async () => {
    const e = { RATE_LIMIT: "100000", DAILY_CAP: "1000000", ALLOWED_ORIGINS: "https://example.org", __fakeModel: fakeModel("ок") };
    assert.strictEqual((await post(e, [{ role: "user", text: "q" }], "https://example.org")).status, 200);
    assert.strictEqual((await post(e, [{ role: "user", text: "q" }], "https://novaya-energy.ru")).status, 403);
  });
  await test("лимитер запросов настраивается через env (RATE_LIMIT)", async () => {
    const e = { ALLOW_LOCALHOST: "1", RATE_LIMIT: "2", RATE_WINDOW_S: "600", DAILY_CAP: "1000000", RATE_SALT: "t" + Math.random(), __fakeModel: fakeModel("ок") };
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await core.handle(new Request("http://bot.local/chat", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:1", "x-client-ip": "9.9.9.9" }, body: JSON.stringify({ messages: [{ role: "user", text: "q" }] }) }), e)).status);
    assert.deepStrictEqual(codes, [200, 200, 429]);
  });
  await test("/health без данных: {\"ok\":true}", async () => {
    const res = await core.handle(new Request("http://bot.local/health"), {});
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
  });

  console.log("PROXY_URL");
  await test("transport: без PROXY_URL прямое соединение, с PROXY_URL (HTTP и SOCKS) агент прокси", () => {
    const direct = transport({});
    assert.strictEqual(direct.dispatcher, undefined);
    assert.strictEqual(direct.fetch, globalThis.fetch);
    assert.ok(transport({ PROXY_URL: "http://127.0.0.1:9" }).dispatcher, "HTTP-прокси");
    assert.ok(transport({ PROXY_URL: "socks5://user:pass@127.0.0.1:9" }).dispatcher, "SOCKS5-прокси");
  });
  await test("запрос к api.telegram.org уходит через PROXY_URL (CONNECT на прокси), а не напрямую", async () => {
    const seen = [];
    const server = net.createServer((sock) => { sock.once("data", (b) => { seen.push(b.toString("latin1").split("\r\n")[0]); sock.destroy(); }); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const r = await tg.notifyManager({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_MANAGER_CHAT_ID: "1", PROXY_URL: "http://127.0.0.1:" + port }, "вопрос", "");
      assert.strictEqual(r.sent, false);
    } finally { await new Promise((r) => server.close(r)); }
    assert.ok(seen.some((l) => /^CONNECT api\.telegram\.org:443 HTTP\/1\.1$/.test(l)), "строки прокси: " + JSON.stringify(seen));
  });
  await test("PROXY_URL используют только provider.js (LLM) и telegram.js; остальной код (kb.js, core.js, tools.js) прокси не использует", () => {
    for (const f of ["kb.js", "core.js", "tools.js", "pii.js"]) {
      const t = fs.readFileSync(path.join(BOT, f), "utf8");
      assert.ok(!/PROXY_URL|require\("undici"\)|transport\(/.test(t), f + " обращается к прокси");
    }
    assert.ok(/transport\(env\)/.test(fs.readFileSync(path.join(BOT, "provider.js"), "utf8")));
    assert.ok(/transport\(env\)/.test(fs.readFileSync(path.join(BOT, "telegram.js"), "utf8")));
  });
  await test("вебхук не используется: в коде бота нет setWebhook, только sendMessage и getUpdates", () => {
    for (const f of ["telegram.js", "core.js", "server.js", "tg_chat_id.js"]) {
      assert.ok(!/setWebhook|webhook/i.test(fs.readFileSync(path.join(BOT, f), "utf8").replace(/Вебхук[^\n]*|вебхук[^\n]*/g, "")), f);
    }
  });

  console.log("\nитого: ok " + passed + ", ошибок " + failed);
  process.exit(failed ? 1 : 0);
})();
