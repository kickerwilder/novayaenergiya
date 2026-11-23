"use strict";
/* Тесты адаптеров провайдера модели (bot/provider.js, bot/provider_openai.js, bot/llm.js) на локальных ПОДДЕЛЬНЫХ серверах, без сети и без ключей:
   node tests/bot_provider.test.js
   Проверяются: обычный ответ; перевод истории и вызовов инструментов туда и обратно (в том числе несколько вызовов за ход); 429 и 5xx с повтором;
   запасная модель; невалидный JSON; таймаут; дополнительные поля и заголовки; настройки и сообщения об ошибках; LLM_USE_PROXY;
   отсутствие ключа, заголовков, текстов диалогов и ответов провайдера в логах; путь Gemini. */
const path = require("path");
const http = require("http");
const assert = require("assert");
const { spawnSync } = require("child_process");

const BOT = path.join(__dirname, "..", "bot");
const core = require(path.join(BOT, "core.js"));
const llm = require(path.join(BOT, "llm.js"));
const prov = require(path.join(BOT, "provider.js"));
const oa = require(path.join(BOT, "provider_openai.js"));
const tools = require(path.join(BOT, "tools.js"));

let passed = 0, failed = 0;
const out = console.log.bind(console);
console.log = console.warn = console.error = () => {};   /* служебные строки бота (llm_usage, chat_error…) в выводе теста не нужны; captureLogs их собирает */
async function test(name, fn) {
  try { await fn(); passed++; out("  ok   " + name); }
  catch (e) { failed++; out("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 3).join("\n       ")); }
}

/* ---------- поддельный сервер провайдера ----------
   script(req, n) -> {status, headers, body (объект или строка), hang}; req: {path, headers, body}. Все запросы записываются в server.requests. */
function fakeServer(script) {
  const srv = { requests: [], script, sockets: new Set() };
  srv.http = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (_) {}
      const rec = { path: req.url, headers: req.headers, body };
      srv.requests.push(rec);
      const r = srv.script(rec, srv.requests.length) || {};
      if (r.hang) return; /* не отвечаем */
      res.writeHead(r.status || 200, Object.assign({ "content-type": "application/json" }, r.headers || {}));
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body === undefined ? {} : r.body));
    });
  });
  srv.http.on("connection", (s) => { srv.sockets.add(s); s.on("close", () => srv.sockets.delete(s)); });
  return new Promise((resolve) => srv.http.listen(0, "127.0.0.1", () => {
    srv.url = "http://127.0.0.1:" + srv.http.address().port;
    srv.close = () => new Promise((r) => { srv.sockets.forEach((s) => s.destroy()); srv.http.close(r); });
    resolve(srv);
  }));
}

const USAGE = { prompt_tokens: 12, completion_tokens: 7 };
const okText = (text, usage) => ({ status: 200, body: { choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: usage || USAGE } });
const okTools = (calls, usage) => ({ status: 200, body: { choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ id: c.id === undefined ? "call_" + (i + 1) : c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: "tool_calls" }], usage: usage || USAGE } });
const KEY = "sk-test-SECRET-KEY-123";

function openaiEnv(srv, extra) {
  return Object.assign({
    PROVIDER: "openai", PROVIDER_BASE_URL: srv.url + "/v1", PROVIDER_API_KEY: KEY, MODEL: "m-main", FALLBACK_MODEL: "m-fb",
    ALLOW_LOCALHOST: "1", RATE_LIMIT: "100000", DAILY_CAP: "1000000", TIMEOUT_MS: "8000", RETRY_PAUSE_MS: "20", TEST_TRACE: "1",
  }, extra || {});
}
const post = (env, messages) => core.handle(new Request("http://bot.local/chat", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:1" }, body: JSON.stringify({ messages }) }), env);
const ask = async (env, text) => { const r = await post(env, [{ role: "user", text: text || "Подберите станцию для холодильника" }]); return { status: r.status, json: await r.json() }; };
const llmArgs = (over) => Object.assign({ system: "СИСТЕМА", contents: [{ role: "user", parts: [{ text: "вопрос" }] }], tools: [], deadline: Date.now() + 8000 }, over || {});

/* запуск node-скрипта без блокировки процесса (поддельный сервер живёт в этом же процессе, spawnSync его бы заморозил) */
function runNode(argv, opts) {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const p = spawn(process.execPath, argv, { env: opts.env, cwd: opts.cwd });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; }); p.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => p.kill(), opts.timeout || 60000);
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function captureLogs(fn) {
  const logs = [], old = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const grab = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  console.log = grab; console.error = grab; console.warn = grab; console.info = grab;
  try { await fn(); } finally { Object.assign(console, old); }
  return logs;
}

(async () => {
  out("OpenAI-совместимый адаптер: запрос и ответ");
  await test("обычный ответ: адрес, заголовки, тело запроса, разбор ответа и токены", async () => {
    const srv = await fakeServer(() => okText("Здравствуйте!"));
    try {
      const r = await llm.call(openaiEnv(srv), llmArgs({ contents: [{ role: "user", parts: [{ text: "привет" }] }, { role: "model", parts: [{ text: "Добрый день" }] }, { role: "user", parts: [{ text: "подберите" }] }] }));
      assert.strictEqual(r.text, "Здравствуйте!");
      assert.deepStrictEqual(r.calls, []);
      assert.strictEqual(r.finishReason, "STOP");
      assert.deepStrictEqual(r.content, { role: "model", parts: [{ text: "Здравствуйте!" }] });
      assert.deepStrictEqual(r.usage, USAGE);
      const q = srv.requests[0];
      assert.strictEqual(q.path, "/v1/chat/completions");
      assert.strictEqual(q.headers.authorization, "Bearer " + KEY);
      assert.strictEqual(q.body.model, "m-main");
      assert.deepStrictEqual(q.body.messages, [
        { role: "system", content: "СИСТЕМА" }, { role: "user", content: "привет" }, { role: "assistant", content: "Добрый день" }, { role: "user", content: "подберите" },
      ]);
      assert.ok(!("tools" in q.body), "без инструментов поле tools не отправляется");
    } finally { await srv.close(); }
  });
  await test("адрес можно задать полностью (…/chat/completions): хвост не дублируется", async () => {
    const srv = await fakeServer(() => okText("ок"));
    try {
      await llm.call(openaiEnv(srv, { PROVIDER_BASE_URL: srv.url + "/api/chat/completions/" }), llmArgs());
      assert.strictEqual(srv.requests[0].path, "/api/chat/completions");
    } finally { await srv.close(); }
  });
  await test("ответ с частями content и встроенными рассуждениями <think>: в текст попадает только ответ", () => {
    const r = oa.fromResponse({ choices: [{ message: { content: [{ type: "text", text: "<think>рассуждаю</think>Ответ " }, { type: "text", text: "клиенту" }] }, finish_reason: "length" }] });
    assert.strictEqual(r.text, "Ответ клиенту");
    assert.strictEqual(r.finishReason, "MAX_TOKENS");
    assert.deepStrictEqual(r.usage, { prompt_tokens: null, completion_tokens: null });
  });
  await test("пустой ответ (нет текста и вызовов) — ошибка empty", () => {
    assert.throws(() => oa.fromResponse({ choices: [{ message: { content: "" } }] }), (e) => e.kind === "empty");
    assert.throws(() => oa.fromResponse({ choices: [] }), (e) => e.kind === "empty");
  });

  out("вызовы инструментов туда и обратно");
  await test("несколько вызовов за ход: id сохраняются, ответы инструментов идут сообщениями tool в том же порядке", async () => {
    const srv = await fakeServer((req, n) => n === 1
      ? okTools([{ name: "get_station", args: { code: "ZF16-2005" }, id: "call_AAA" }, { name: "list_stations", args: { sort_by: "power", limit: 2 }, id: "call_BBB" }])
      : okText("Готово"));
    try {
      const env = openaiEnv(srv);
      const contents = [{ role: "user", parts: [{ text: "что за станции" }] }];
      const r1 = await llm.call(env, llmArgs({ contents, tools: tools.declarations }));
      assert.strictEqual(r1.calls.length, 2);
      assert.deepStrictEqual(r1.calls.map((c) => [c.name, c.args, c.id]), [["get_station", { code: "ZF16-2005" }, "call_AAA"], ["list_stations", { sort_by: "power", limit: 2 }, "call_BBB"]]);
      assert.strictEqual(r1.text, "");
      /* то же, что делает core.js: ответ модели целиком в историю, затем результаты инструментов одной репликой */
      contents.push(r1.content);
      contents.push({ role: "user", parts: r1.calls.map((c) => ({ functionResponse: { name: c.name, response: tools.execute(c.name, c.args, require(path.join(__dirname, "..", "data", "kb.json"))) } })) });
      const r2 = await llm.call(env, llmArgs({ contents, tools: tools.declarations }));
      assert.strictEqual(r2.text, "Готово");
      const q1 = srv.requests[0].body, q2 = srv.requests[1].body;
      assert.ok(Array.isArray(q1.tools) && q1.tools.length === tools.declarations.length && q1.tools[0].type === "function" && q1.tools[0].function.name === "select_stations" && q1.tools[0].function.parameters.type === "object", "инструменты в формате chat/completions");
      assert.strictEqual(q1.tool_choice, "auto");
      const m = q2.messages;
      assert.deepStrictEqual(m.map((x) => x.role), ["system", "user", "assistant", "tool", "tool"]);
      assert.deepStrictEqual(m[2].tool_calls.map((c) => [c.id, c.type, c.function.name, JSON.parse(c.function.arguments)]), [["call_AAA", "function", "get_station", { code: "ZF16-2005" }], ["call_BBB", "function", "list_stations", { sort_by: "power", limit: 2 }]]);
      assert.strictEqual(m[2].content, null);
      assert.deepStrictEqual(m.slice(3).map((x) => x.tool_call_id), ["call_AAA", "call_BBB"]);
      assert.ok(typeof m[3].content === "string" && JSON.parse(m[3].content).stations, "результат get_station как JSON-строка");
      assert.ok(JSON.parse(m[4].content).stations || JSON.parse(m[4].content).list || JSON.parse(m[4].content).ok !== undefined, "результат list_stations как JSON-строка");
    } finally { await srv.close(); }
  });
  await test("провайдер не прислал id вызовов: адаптер создаёт свои и связывает ответы по порядку", async () => {
    const srv = await fakeServer((req, n) => n === 1 ? okTools([{ name: "get_station", args: { code: "ZF16-2005" }, id: "" }, { name: "get_station", args: { code: "ZF28-2003.8" }, id: "" }]) : okText("ок"));
    try {
      const env = openaiEnv(srv);
      const contents = [{ role: "user", parts: [{ text: "?" }] }];
      const r1 = await llm.call(env, llmArgs({ contents, tools: tools.declarations }));
      const ids = r1.calls.map((c) => c.id);
      assert.strictEqual(new Set(ids).size, 2, "id разные: " + ids);
      contents.push(r1.content, { role: "user", parts: r1.calls.map((c) => ({ functionResponse: { name: c.name, response: { ok: true, code: c.args.code } } })) });
      await llm.call(env, llmArgs({ contents, tools: tools.declarations }));
      const m = srv.requests[1].body.messages;
      assert.deepStrictEqual(m.filter((x) => x.role === "tool").map((x) => x.tool_call_id), ids);
      assert.deepStrictEqual(m.filter((x) => x.role === "tool").map((x) => JSON.parse(x.content).code), ["ZF16-2005", "ZF28-2003.8"]);
    } finally { await srv.close(); }
  });
  await test("аргументы вызова не JSON: вызов не теряется, args = {}", () => {
    const r = oa.fromResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "get_station", arguments: "{oops" } }] } }] });
    assert.deepStrictEqual(r.calls, [{ name: "get_station", args: {}, id: "x" }]);
  });
  await test("через ядро (core.js) целиком: инструмент вызывается, карточки собираются, клиент видит итоговый текст", async () => {
    const srv = await fakeServer((req, n) => n === 1
      ? okTools([{ name: "get_station", args: { code: "ZF16-2005" } }, { name: "list_stations", args: { sort_by: "power", limit: 2 } }])
      : okText("Станция ZF16-2005 подходит для вашей задачи."));
    try {
      const out = await ask(openaiEnv(srv));
      assert.strictEqual(out.status, 200);
      assert.ok(/подходит/.test(out.json.reply), out.json.reply);
      assert.deepStrictEqual(out.json.trace.tools.map((t) => t.name), ["get_station", "list_stations"]);
      assert.ok(Array.isArray(out.json.cards) && out.json.cards.length >= 1, "карточки есть");
      assert.strictEqual(srv.requests.length, 2);
    } finally { await srv.close(); }
  });

  out("надёжность: 429, 5xx, запасная модель, невалидный ответ, таймаут");
  await test("429 и затем успех: одна повторная попытка на той же модели", async () => {
    const srv = await fakeServer((req, n) => n === 1 ? { status: 429, headers: { "retry-after": "0" }, body: { error: "slow down" } } : okText("после паузы"));
    try {
      const r = await llm.call(openaiEnv(srv), llmArgs());
      assert.strictEqual(r.text, "после паузы");
      assert.deepStrictEqual(srv.requests.map((q) => q.body.model), ["m-main", "m-main"]);
    } finally { await srv.close(); }
  });
  await test("5xx и затем успех: одна повторная попытка", async () => {
    const srv = await fakeServer((req, n) => n === 1 ? { status: 503, body: "<html>unavailable</html>" } : okText("ок"));
    try {
      const r = await llm.call(openaiEnv(srv), llmArgs());
      assert.strictEqual(r.text, "ок");
      assert.deepStrictEqual(srv.requests.map((q) => q.body.model), ["m-main", "m-main"]);
    } finally { await srv.close(); }
  });
  await test("пауза берётся из Retry-After (в пределах лимита) и не короче его", async () => {
    const srv = await fakeServer((req, n) => n === 1 ? { status: 429, headers: { "retry-after": "1" }, body: {} } : okText("ок"));
    try {
      const t0 = Date.now();
      await llm.call(openaiEnv(srv, { RETRY_MAX_WAIT_MS: "3000" }), llmArgs());
      const dt = Date.now() - t0;
      assert.ok(dt >= 950 && dt < 2500, "пауза " + dt + " мс");
    } finally { await srv.close(); }
  });
  await test("429 дважды, затем запасная модель отвечает: порядок m-main, m-main, m-fb", async () => {
    const srv = await fakeServer((req) => req.body.model === "m-fb" ? okText("ответ запасной") : { status: 429, body: {} });
    try {
      const out = await ask(openaiEnv(srv));
      assert.strictEqual(out.json.reply, "ответ запасной");
      assert.deepStrictEqual(srv.requests.map((q) => q.body.model), ["m-main", "m-main", "m-fb"]);
    } finally { await srv.close(); }
  });
  await test("слишком длинный Retry-After не ждём: сразу запасная модель (диалог не уходит в долгие повторы)", async () => {
    const srv = await fakeServer((req) => req.body.model === "m-fb" ? okText("быстро") : { status: 429, headers: { "retry-after": "120" }, body: {} });
    try {
      const t0 = Date.now();
      const out = await ask(openaiEnv(srv));
      assert.strictEqual(out.json.reply, "быстро");
      assert.deepStrictEqual(srv.requests.map((q) => q.body.model), ["m-main", "m-fb"]);
      assert.ok(Date.now() - t0 < 1500, "заняло " + (Date.now() - t0) + " мс");
    } finally { await srv.close(); }
  });
  await test("429, затем сбой запасной модели: клиент получает сообщение с контактами, попыток не больше четырёх, без зависания", async () => {
    const srv = await fakeServer((req) => req.body.model === "m-fb" ? { status: 500, body: {} } : { status: 429, body: {} });
    try {
      const t0 = Date.now();
      const logs = await captureLogs(async () => {
        const out = await ask(openaiEnv(srv));
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
        assert.strictEqual(out.json.handoff, true);
        assert.ok(/978/.test(out.json.reply) && /apv0050/.test(out.json.reply));
      });
      assert.deepStrictEqual(srv.requests.map((q) => q.body.model), ["m-main", "m-main", "m-fb", "m-fb"]);
      assert.ok(Date.now() - t0 < 3000, "заняло " + (Date.now() - t0) + " мс");
      assert.ok(logs.some((l) => /^chat_error: http 500$/.test(l)), logs.join(" | "));
    } finally { await srv.close(); }
  });
  await test("без запасной модели: основная повторяется один раз и всё", async () => {
    const srv = await fakeServer(() => ({ status: 502, body: {} }));
    try {
      const out = await ask(openaiEnv(srv, { FALLBACK_MODEL: "" }));
      assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
      assert.strictEqual(srv.requests.length, 2);
    } finally { await srv.close(); }
  });
  await test("4xx (кроме 404 и 429), например 401 неверный ключ: ни повтора, ни запасной модели", async () => {
    const srv = await fakeServer(() => ({ status: 401, body: {} }));
    try {
      const out = await ask(openaiEnv(srv));
      assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
      assert.strictEqual(srv.requests.length, 1);
    } finally { await srv.close(); }
  });
  await test("невалидный JSON в ответе: переход к запасной модели, без повтора на той же", async () => {
    const srv = await fakeServer((req) => req.body.model === "m-fb" ? okText("из запасной") : { status: 200, body: "это не json {" });
    try {
      const out = await ask(openaiEnv(srv));
      assert.strictEqual(out.json.reply, "из запасной");
      assert.deepStrictEqual(srv.requests.map((q) => q.body.model), ["m-main", "m-fb"]);
    } finally { await srv.close(); }
  });
  await test("невалидный JSON у всех моделей: сообщение с контактами", async () => {
    const srv = await fakeServer(() => ({ status: 200, body: "<<<" }));
    try {
      const out = await ask(openaiEnv(srv));
      assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
    } finally { await srv.close(); }
  });
  await test("таймаут: провайдер молчит, клиент получает контакты в пределах бюджета TIMEOUT_MS", async () => {
    const srv = await fakeServer(() => ({ hang: true }));
    try {
      const t0 = Date.now();
      const logs = await captureLogs(async () => {
        const out = await ask(openaiEnv(srv, { FALLBACK_MODEL: "", TIMEOUT_MS: "1500" }));
        assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
      });
      const dt = Date.now() - t0;
      assert.ok(dt >= 1400 && dt < 4500, "заняло " + dt + " мс");
      assert.ok(logs.some((l) => /^chat_error: timeout$/.test(l)), logs.join(" | "));
    } finally { await srv.close(); }
  });
  await test("сервер недоступен (отказ соединения): контакты менеджера", async () => {
    const srv = await fakeServer(() => okText("x")); const url = srv.url; await srv.close();
    const out = await ask(openaiEnv({ url }, { FALLBACK_MODEL: "" }));
    assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
  });

  out("настройки: дополнительные поля, заголовки, прокси");
  await test("PROVIDER_EXTRA_BODY: поля добавляются, объекты сливаются, null удаляет поле", async () => {
    const srv = await fakeServer(() => okText("ок"));
    try {
      await llm.call(openaiEnv(srv, { PROVIDER_EXTRA_BODY: JSON.stringify({ reasoning_effort: "none", max_tokens: null, max_completion_tokens: 300, chat_template_kwargs: { enable_thinking: false } }) }), llmArgs());
      const b = srv.requests[0].body;
      assert.strictEqual(b.reasoning_effort, "none");
      assert.ok(!("max_tokens" in b));
      assert.strictEqual(b.max_completion_tokens, 300);
      assert.deepStrictEqual(b.chat_template_kwargs, { enable_thinking: false });
      assert.strictEqual(b.model, "m-main");
    } finally { await srv.close(); }
  });
  await test("PROVIDER_EXTRA_HEADERS: заголовки добавляются, null убирает основной (Authorization)", async () => {
    const srv = await fakeServer(() => okText("ок"));
    try {
      await llm.call(openaiEnv(srv, { PROVIDER_EXTRA_HEADERS: JSON.stringify({ "X-Extra": "v1", "api-key": KEY, Authorization: null }) }), llmArgs());
      const h = srv.requests[0].headers;
      assert.strictEqual(h["x-extra"], "v1");
      assert.strictEqual(h["api-key"], KEY);
      assert.ok(!("authorization" in h));
    } finally { await srv.close(); }
  });
  await test("некорректные JSON в настройках: понятные сообщения при проверке, значения (секреты) в них не повторяются", () => {
    const secret = "{не-json СЕКРЕТНОЕЗНАЧЕНИЕ";
    const r = prov.checkConfig({ PROVIDER_EXTRA_BODY: secret, PROVIDER_EXTRA_HEADERS: "[1,2]", PROVIDER_API_KEY: "k" });
    assert.strictEqual(r.errors.length, 2, JSON.stringify(r));
    assert.ok(/PROVIDER_EXTRA_BODY/.test(r.errors[0]) && /PROVIDER_EXTRA_HEADERS/.test(r.errors[1]));
    assert.ok(!JSON.stringify(r).includes("СЕКРЕТНОЕЗНАЧЕНИЕ"));
    assert.ok(prov.checkConfig({ PROVIDER_EXTRA_BODY: '{"model":"x"}', PROVIDER: "openai", PROVIDER_BASE_URL: "https://x", MODEL: "m" }).errors.some((e) => /нельзя переопределять/.test(e)));
    assert.ok(prov.checkConfig({ LLM_USE_PROXY: "2" }).errors.some((e) => /LLM_USE_PROXY/.test(e)));
    assert.ok(prov.checkConfig({ PROVIDER: "foo" }).errors.some((e) => /PROVIDER:/.test(e)));
    const o = prov.checkConfig({ PROVIDER: "openai", PROVIDER_API_KEY: "k" }).errors.join(" ");
    assert.ok(/PROVIDER_BASE_URL/.test(o) && /MODEL/.test(o), "для openai адрес и модель обязательны: " + o);
    assert.strictEqual(prov.checkConfig({ PROVIDER_API_KEY: "k", PROVIDER_EXTRA_BODY: '{"generationConfig":{"temperature":0.1}}', PROVIDER_EXTRA_HEADERS: '{"X":"y"}', LLM_USE_PROXY: "0" }).errors.length, 0);
    assert.strictEqual(prov.checkConfig({}).errors.length, 0, "настройки по умолчанию (Gemini) допустимы");
  });
  await test("некорректный JSON в настройках не роняет бота: запрос получает контакты менеджера, в логе только имя ошибки", async () => {
    const srv = await fakeServer(() => okText("не должно дойти"));
    try {
      const logs = await captureLogs(async () => {
        const out = await ask(openaiEnv(srv, { PROVIDER_EXTRA_BODY: "{сломано СЕКРЕТ" }));
        assert.strictEqual(out.status, 200);
        assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
      });
      assert.strictEqual(srv.requests.length, 0, "запрос к провайдеру не отправлялся");
      assert.ok(logs.some((l) => /chat_error: config/.test(l)));
      assert.ok(!logs.join("\n").includes("СЕКРЕТ"));
    } finally { await srv.close(); }
  });
  await test("старт server.js с некорректным JSON: код 1, сообщение называет переменную и не печатает значение", () => {
    const r = spawnSync(process.execPath, [path.join(BOT, "server.js")], {
      env: { PATH: process.env.PATH, SKIP_DOTENV: "1", PORT: "0", PROVIDER_EXTRA_BODY: "{oops-СЕКРЕТ", PROVIDER_API_KEY: "k" }, encoding: "utf8", timeout: 15000,
    });
    assert.strictEqual(r.status, 1, "код " + r.status + " " + r.stderr);
    assert.ok(/config_error: PROVIDER_EXTRA_BODY/.test(r.stderr), r.stderr);
    assert.ok(!/oops|СЕКРЕТ/.test(r.stdout + r.stderr), "значение переменной напечатано");
    assert.ok(!/at .*\.js:\d+/.test(r.stderr), "должна быть понятная ошибка, а не трассировка");
  });
  await test("PROVIDER=openai без MODEL или адреса: ядро не падает, клиент получает контакты", async () => {
    const out = await ask(openaiEnv({ url: "http://127.0.0.1:9" }, { MODEL: "", FALLBACK_MODEL: "" }));
    assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
  });
  await test("неизвестный PROVIDER: контакты менеджера, ошибка config", async () => {
    const logs = await captureLogs(async () => {
      const out = await ask({ PROVIDER: "foo", PROVIDER_API_KEY: "k", ALLOW_LOCALHOST: "1", RATE_LIMIT: "100000", DAILY_CAP: "1000000" });
      assert.strictEqual(out.json.reply, core.HANDOFF_TEXT);
    });
    assert.ok(logs.some((l) => /chat_error: config/.test(l)));
  });
  await test("LLM_USE_PROXY=0: запросы к модели идут напрямую, PROXY_URL остаётся для Telegram; по умолчанию (1) модель идёт через прокси", async () => {
    let proxyHits = 0;
    const proxy = http.createServer((req, res) => { proxyHits++; res.writeHead(502); res.end(); });
    proxy.on("connect", (req, sock) => { proxyHits++; sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    const srv = await fakeServer(() => okText("напрямую"));
    const PROXY_URL = "http://127.0.0.1:" + proxy.address().port;
    try {
      const direct = await llm.call(openaiEnv(srv, { PROXY_URL, LLM_USE_PROXY: "0", FALLBACK_MODEL: "" }), llmArgs());
      assert.strictEqual(direct.text, "напрямую");
      assert.strictEqual(proxyHits, 0, "прокси не должен был получить запросы к модели");
      assert.strictEqual(prov.llmTransport({ PROXY_URL, LLM_USE_PROXY: "0" }).dispatcher, undefined);
      assert.ok(prov.transport({ PROXY_URL, LLM_USE_PROXY: "0" }).dispatcher, "для Telegram прокси по-прежнему используется");
      assert.ok(prov.llmTransport({ PROXY_URL }).dispatcher, "по умолчанию LLM_USE_PROXY=1: через прокси");
      await assert.rejects(llm.call(openaiEnv(srv, { PROXY_URL, FALLBACK_MODEL: "" }), llmArgs()), (e) => e.kind === "network" || e.kind === "http");
      assert.ok(proxyHits > 0, "при LLM_USE_PROXY по умолчанию запрос к модели пошёл на прокси");
    } finally { await srv.close(); await new Promise((r) => proxy.close(r)); }
  });

  out("учёт токенов и логи");
  await test("после вызова пишутся только счётчики: провайдер, модель, prompt_tokens, completion_tokens, мс", async () => {
    const srv = await fakeServer(() => okText("ответ", { prompt_tokens: 321, completion_tokens: 45 }));
    try {
      const seen = [];
      const logs = await captureLogs(async () => { await llm.call(openaiEnv(srv, { __onUsage: (u) => seen.push(u) }), llmArgs()); });
      const line = logs.find((l) => l.startsWith("llm_usage "));
      assert.ok(line, logs.join(" | "));
      const j = JSON.parse(line.slice("llm_usage ".length));
      assert.deepStrictEqual(Object.keys(j).sort(), ["completion_tokens", "model", "ms", "prompt_tokens", "provider"]);
      assert.strictEqual(j.prompt_tokens, 321); assert.strictEqual(j.completion_tokens, 45); assert.strictEqual(j.model, "m-main"); assert.strictEqual(j.provider, "openai");
      assert.ok(Number.isInteger(j.ms) && j.ms >= 0);
      assert.strictEqual(seen.length, 1);
    } finally { await srv.close(); }
  });
  await test("в логах нет ключа, заголовков, текста клиента и текста ответа провайдера (успех, повтор, сбой)", async () => {
    const CLIENT = "СекретныйВопросПроКотёлЗХК77", PROVIDER_TEXT = "ТекстОтветаПровайдераХХХ", HDR = "HDRVALUE999zzz";
    let mode = "ok";
    const srv = await fakeServer((req, n) => mode === "ok" ? okText(PROVIDER_TEXT) : mode === "retry" ? (n % 2 === 1 ? { status: 429, body: { error: { message: PROVIDER_TEXT + CLIENT } } } : okText(PROVIDER_TEXT)) : { status: 500, body: PROVIDER_TEXT + CLIENT });
    try {
      const env = openaiEnv(srv, { PROVIDER_EXTRA_HEADERS: JSON.stringify({ "x-secret-header": HDR }) });
      const logs = await captureLogs(async () => {
        await ask(env, CLIENT);
        mode = "retry"; await ask(env, CLIENT);
        mode = "fail"; await ask(env, CLIENT);
      });
      const all = logs.join("\n");
      assert.ok(logs.some((l) => l.startsWith("llm_usage ")) && logs.some((l) => l.startsWith("llm_retry ")) && logs.some((l) => /^chat_error/.test(l)), all);
      for (const s of [KEY, HDR, "x-secret-header", "authorization", "Authorization", "Bearer", CLIENT, PROVIDER_TEXT]) assert.ok(!all.includes(s), "в логах найдено: " + s);
    } finally { await srv.close(); }
  });

  out("путь Gemini остаётся рабочим");
  const gemOk = (parts, usage) => ({ status: 200, body: { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], usageMetadata: usage || { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3 } } });
  const gemEnv = (srv, extra) => Object.assign({ PROVIDER_BASE_URL: srv.url, PROVIDER_API_KEY: KEY, MODEL: "g-main", FALLBACK_MODEL: "g-fb", RETRY_PAUSE_MS: "20", ALLOW_LOCALHOST: "1", RATE_LIMIT: "100000", DAILY_CAP: "1000000", TIMEOUT_MS: "8000", TEST_TRACE: "1" }, extra || {});
  await test("Gemini (PROVIDER по умолчанию): запрос generateContent, вызов инструмента и токены (мысли входят в выходные)", async () => {
    const srv = await fakeServer((req, n) => n === 1 ? gemOk([{ functionCall: { name: "get_station", args: { code: "ZF16-2005" } } }]) : gemOk([{ text: "Станция подходит." }]));
    try {
      const seen = [];
      const logs = await captureLogs(async () => {
        const out = await ask(gemEnv(srv, { __onUsage: (u) => seen.push(u) }));
        assert.strictEqual(out.json.reply, "Станция подходит.");
        assert.deepStrictEqual(out.json.trace.tools.map((t) => t.name), ["get_station"]);
      });
      const q = srv.requests[0];
      assert.strictEqual(q.path, "/v1beta/models/g-main:generateContent");
      assert.strictEqual(q.headers["x-goog-api-key"], KEY);
      assert.ok(q.body.systemInstruction && Array.isArray(q.body.contents) && q.body.tools[0].functionDeclarations.length === tools.declarations.length);
      assert.deepStrictEqual(srv.requests[1].body.contents.map((c) => c.role), ["user", "model", "user"], "в историю ушли вызов и результат инструмента");
      assert.deepStrictEqual(seen[0], { provider: "gemini", model: "g-main", prompt_tokens: 20, completion_tokens: 8, ms: seen[0].ms });
      assert.ok(!logs.join("\n").includes(KEY));
    } finally { await srv.close(); }
  });
  await test("Gemini: 429 и 5xx с повтором и запасной моделью работают так же, как у OpenAI-адаптера", async () => {
    const srv = await fakeServer((req) => /g-fb/.test(req.path) ? gemOk([{ text: "запасная" }]) : { status: 429, body: {} });
    try {
      const out = await ask(gemEnv(srv));
      assert.strictEqual(out.json.reply, "запасная");
      assert.deepStrictEqual(srv.requests.map((q) => q.path.split("/").pop().split(":")[0]), ["g-main", "g-main", "g-fb"]);
    } finally { await srv.close(); }
    const srv2 = await fakeServer((req, n) => n === 1 ? { status: 500, body: {} } : gemOk([{ text: "после повтора" }]));
    try {
      const out = await ask(gemEnv(srv2));
      assert.strictEqual(out.json.reply, "после повтора");
      assert.strictEqual(srv2.requests.length, 2);
    } finally { await srv2.close(); }
  });
  await test("Gemini: PROVIDER_EXTRA_BODY и PROVIDER_EXTRA_HEADERS применяются, LLM_USE_PROXY=0 тоже допустим", async () => {
    const srv = await fakeServer(() => gemOk([{ text: "ок" }]));
    try {
      await llm.call(gemEnv(srv, { PROVIDER_EXTRA_BODY: '{"generationConfig":{"temperature":0.1}}', PROVIDER_EXTRA_HEADERS: '{"x-extra":"1"}', LLM_USE_PROXY: "0" }), llmArgs());
      assert.strictEqual(srv.requests[0].body.generationConfig.temperature, 0.1);
      assert.ok(srv.requests[0].body.generationConfig.maxOutputTokens, "остальные поля сохранены (слияние вглубь)");
      assert.strictEqual(srv.requests[0].headers["x-extra"], "1");
    } finally { await srv.close(); }
  });
  await test("ядро и инструменты не знают о провайдере: в core.js и tools.js нет упоминаний openai, gemini и chat/completions", () => {
    const fs = require("fs");
    for (const f of ["core.js", "tools.js"]) {
      const t = fs.readFileSync(path.join(BOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      assert.ok(!/openai|chat\/completions|generateContent|x-goog/i.test(t), f);
    }
  });

  out("скрипт оценки моделей bot/tools/eval_cases.js");
  await test("eval_cases.js на поддельном провайдере: таблица, PASS/FAIL, повтор при 429, «не проверен», токены и стоимость, без секретов", async () => {
    const fs = require("fs"), os = require("os");
    let first429 = 2;   /* первые два запроса (одна попытка кейса: основная модель и её повтор) получают 429 */
    const srv = await fakeServer((req) => {
      const last = (req.body.messages || []).filter((m) => m.role === "user").pop();
      if (last && /ВЕЧНЫЙ429/.test(last.content)) return { status: 429, body: {} };
      if (last && /ПЕРВЫЙ429/.test(last.content) && first429-- > 0) return { status: 429, body: {} };
      return okText("Здравствуйте! Чем помочь?");
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ne_eval_"));
    const casesFile = path.join(dir, "cases.json"), jsonOut = path.join(dir, "out.json");
    const msg = (t) => [{ role: "user", text: t }];
    fs.writeFileSync(casesFile, JSON.stringify([
      { id: "ok_case", name: "n", target: "main", numbers: false, messages: msg("Привет"), checks: [{ t: "status", v: 200 }, { t: "has", re: ["здравств\\w+"] }, { t: "cyrillic" }, { t: "none", re: ["секрет"] }] },
      { id: "bad_case", name: "n", target: "main", numbers: false, messages: msg("Привет"), checks: [{ t: "has", re: ["такого слова нет"] }] },
      { id: "retry_case", name: "n", target: "main", numbers: false, messages: msg("ПЕРВЫЙ429 привет"), checks: [{ t: "has", re: ["чем помочь"] }] },
      { id: "stuck_case", name: "n", target: "main", numbers: false, messages: msg("ВЕЧНЫЙ429 привет"), checks: [{ t: "has", re: ["чем помочь"] }] },
      { id: "health", name: "n", target: "main", kind: "health", checks: [{ t: "status", v: 200 }] },
      { id: "needs_other_server", name: "n", target: "rate", kind: "rate", messages: msg("Привет"), checks: [] },
    ]));
    try {
      const r = await runNode([path.join(BOT, "tools", "eval_cases.js"), "--cases", casesFile, "--json", jsonOut, "--delay-ms", "10", "--retries", "2", "--retry-wait-ms", "30", "--price-in", "1", "--price-out", "2", "--no-fallback", "--no-env-file"], {
        env: { PATH: process.env.PATH, SKIP_DOTENV: "1", PROVIDER: "openai", PROVIDER_BASE_URL: srv.url + "/v1", PROVIDER_API_KEY: KEY, MODEL: "m-eval", PROVIDER_EXTRA_HEADERS: JSON.stringify({ "x-secret-header": "HDRVALUE999zzz" }), RETRY_PAUSE_MS: "5" },
        encoding: "utf8", timeout: 60000, cwd: BOT,
      });
      const o = r.stdout + r.stderr;
      assert.strictEqual(r.status, 1, "код выхода 1 (есть FAIL): " + r.status + "\n" + o);
      const row = (id) => (o.split("\n").find((l) => l.startsWith(id + " ")) || "");
      assert.ok(/PASS/.test(row("ok_case")), o);
      assert.ok(/FAIL/.test(row("bad_case")) && /такого слова нет/.test(row("bad_case")), row("bad_case"));
      assert.ok(/PASS\s+2\b/.test(row("retry_case")), "после 429 кейс повторён и прошёл со 2-й попытки: " + row("retry_case"));
      assert.ok(/НЕ ПРОВЕРЕН\s+3\b/.test(row("stuck_case")), "кейс, которому провайдер всё время отвечает 429, не засчитан как FAIL: " + row("stuck_case"));
      assert.ok(/ПРОПУСК/.test(row("needs_other_server")) && /PASS/.test(row("health")));
      assert.ok(/ok_case\s+PASS\s+1\s+\S+\s+12\s+7\s+0\.00003/.test(row("ok_case")), "токены 12/7 и стоимость (12*1+7*2)/1e6: " + row("ok_case"));
      assert.ok(/Итого: прошло 3 из 5, не прошло 1, не проверено из-за 429 или сбоя провайдера 1, пропущено 1/.test(o), o);
      assert.ok(/Стоимость всех кейсов: /.test(o) && /provider=openai model=m-eval/.test(o));
      for (const s of [KEY, "HDRVALUE999zzz", "x-secret-header", "Bearer", srv.url, "127.0.0.1"]) assert.ok(!o.includes(s), "в выводе найдено: " + s);
      const j = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
      assert.ok(!JSON.stringify(j).includes(KEY) && j.totals.pass === 3 && j.totals.not_checked === 1 && j.totals.fail === 1);
      /* без цен стоимость не выдумывается */
      const r2 = await runNode([path.join(BOT, "tools", "eval_cases.js"), "--cases", casesFile, "--only", "ok_case", "--delay-ms", "10", "--no-fallback", "--no-env-file"], {
        env: { PATH: process.env.PATH, SKIP_DOTENV: "1", PROVIDER: "openai", PROVIDER_BASE_URL: srv.url + "/v1", PROVIDER_API_KEY: KEY, MODEL: "m-eval" }, encoding: "utf8", timeout: 30000, cwd: BOT,
      });
      assert.ok(/Стоимость: не считалась/.test(r2.stdout), r2.stdout);
      const r3 = await runNode([path.join(BOT, "tools", "eval_cases.js"), "--no-env-file"], { env: { PATH: process.env.PATH, SKIP_DOTENV: "1", PROVIDER: "openai", PROVIDER_EXTRA_BODY: "{плохо" }, encoding: "utf8", timeout: 30000, cwd: BOT });
      assert.strictEqual(r3.status, 2); assert.ok(/config_error: PROVIDER_EXTRA_BODY/.test(r3.stderr) && !/плохо/.test(r3.stdout + r3.stderr), r3.stderr);
    } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  out("\nитого: ok " + passed + ", ошибок " + failed);
  process.exit(failed ? 1 : 0);
})();
