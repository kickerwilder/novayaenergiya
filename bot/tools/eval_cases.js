#!/usr/bin/env node
"use strict";
/* Оценка моделей для выбора провайдера: прогоняет tests/bot_cases.json на выбранных PROVIDER и MODEL и печатает таблицу:
   кейс, прошёл или нет, число попыток, время, токены (вход и выход) и стоимость по ценам, переданным аргументами.
   Нужен для выбора модели при смене провайдера; в боевом запуске не используется.

   Запуск (из папки bot/):
     node tools/eval_cases.js --provider openai --model НАЗВАНИЕ_ИЗ_КАБИНЕТА --delay-ms 2000 --price-in 0.15 --price-out 0.60
   Настройки берутся из bot/.env и окружения (PROVIDER, PROVIDER_API_KEY, PROVIDER_BASE_URL, MODEL, FALLBACK_MODEL, PROVIDER_EXTRA_BODY, PROVIDER_EXTRA_HEADERS,
   LLM_USE_PROXY, PROXY_URL); флаги --provider, --model, --fallback и --no-fallback переопределяют их только на время прогона.

   Аргументы:
     --provider gemini|openai   --model М   --fallback М | --no-fallback   (по умолчанию как в .env)
     --delay-ms N               пауза между кейсами (по умолчанию 1500); --turn-delay-ms N пауза между репликами диалога (400)
     --retries N                сколько раз повторять кейс, если ответ модели не получен из-за 429 или сбоя провайдера (по умолчанию 3);
                                --retry-wait-ms N базовая пауза перед повтором (по умолчанию 20000, растёт с номером попытки)
     --price-in X --price-out Y цена за МИЛЛИОН входных и выходных токенов (в любой валюте; стоимость выводится в ней же)
     --only id1,id2             только эти кейсы;   --cases путь   другой файл кейсов;   --json файл   сохранить результаты (без секретов и ключей)
     --no-env-file              не читать bot/.env (только окружение)
     --usage-lines              после каждого кейса печатать строки llm_usage по вызовам модели (только счётчики и причина остановки, без текстов)
   Проверяются кейсы с target main (проверки те же, что в scripts/test_bot.py); кейсы, которым нужны отдельные серверы (недоступный провайдер, лимитер,
   нулевая цена), пропускаются: они от модели не зависят и запускаются через scripts/test_bot.py.
   Уведомления в Telegram на время прогона выключены. Ключи, заголовки и адрес провайдера не печатаются; в таблице только названия кейсов, провайдер и модель. */

const fs = require("fs");
const path = require("path");
const BOT = path.join(__dirname, "..");
const ROOT = path.join(BOT, "..");

/* ---------- аргументы ---------- */
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { console.error("Неизвестный аргумент: " + argv[i]); process.exit(2); }
    const k = argv[i].slice(2);
    if (["no-fallback", "no-env-file", "usage-lines", "help"].includes(k)) a[k] = true;
    else { a[k] = argv[++i]; if (a[k] === undefined) { console.error("Для --" + k + " нужно значение"); process.exit(2); } }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#!.*\n/, "").replace(/^"use strict";\n/, "")); process.exit(0); }
if (args["no-env-file"]) process.env.SKIP_DOTENV = "1";
require(path.join(BOT, "dotenv.js")).loadDotEnv(path.join(BOT, ".env"));

const core = require(path.join(BOT, "core.js"));
const { checkConfig, providerName } = require(path.join(BOT, "provider.js"));
const { loadKb } = require(path.join(BOT, "kb.js"));

const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
const delayMs = num(args["delay-ms"], 1500), turnDelayMs = num(args["turn-delay-ms"], 400);
const retries = num(args.retries, 3), retryWaitMs = num(args["retry-wait-ms"], 20000);
const priceIn = args["price-in"] === undefined ? null : Number(args["price-in"]), priceOut = args["price-out"] === undefined ? null : Number(args["price-out"]);
if ((priceIn !== null && !Number.isFinite(priceIn)) || (priceOut !== null && !Number.isFinite(priceOut))) { console.error("--price-in и --price-out: число (цена за миллион токенов)"); process.exit(2); }

/* ---------- окружение прогона ---------- */
let usageLines = [];   /* записи по вызовам модели текущего кейса (для --usage-lines) */
const usage = { prompt: 0, completion: 0, calls: 0, missing: 0 };   /* missing: вызовы, по которым провайдер не прислал usage */
let errors = [];
const env = Object.assign({}, process.env, {
  ALLOW_LOCALHOST: "1", RATE_LIMIT: "1000000", DAILY_CAP: "1000000", TEST_TRACE: "1",
  TELEGRAM_BOT_TOKEN: "", TELEGRAM_MANAGER_CHAT_ID: "",
  __onUsage: (u) => { usageLines.push(u); usage.calls++; if (u.prompt_tokens === null && u.completion_tokens === null) usage.missing++; usage.prompt += u.prompt_tokens || 0; usage.completion += u.completion_tokens || 0; },
  __onProviderError: (e) => errors.push(e),
});
if (args.provider) env.PROVIDER = args.provider;
if (args.model) env.MODEL = args.model;
if (args.fallback) env.FALLBACK_MODEL = args.fallback;
if (args["no-fallback"]) env.FALLBACK_MODEL = "";
const cfg = checkConfig(env);
if (cfg.errors.length) { cfg.errors.forEach((e) => console.error("config_error: " + e)); process.exit(2); }
if (!String(env.PROVIDER_API_KEY || "").trim()) { console.error("config_error: PROVIDER_API_KEY не задан (bot/.env или окружение)"); process.exit(2); }

const out = console.log.bind(console);
const quiet = () => { console.log = console.warn = console.error = () => {}; };   /* служебные строки бота (llm_usage…) в таблицу не попадают */
const loud = () => { console.log = out; console.warn = console.error = out; };

/* ---------- проверки (то же, что в scripts/test_bot.py) ---------- */
const WORD = "[\\p{L}\\p{N}_]";
/* регулярные выражения кейсов написаны для Python: \w и \b должны понимать кириллицу */
function rx(p) {
  const src = String(p).replace(/\\w/g, WORD).replace(/\\b/g, "(?:(?<=" + WORD + ")(?!" + WORD + ")|(?<!" + WORD + ")(?=" + WORD + "))");
  return new RegExp(src, "iu");
}
function nums(text) {
  let t = String(text);
  for (;;) { const t2 = t.replace(/(?<=\d)[   ](?=\d{3}(?!\d))/g, ""); if (t2 === t) break; t = t2; }
  return new Set((t.replace(/,/g, ".").match(/\d+(?:\.\d+)?/g) || []).map(Number));
}
const union = (a, b) => { b.forEach((x) => a.add(x)); return a; };

const HISTORY_MAX = 12, ASSISTANT_MAX = 800;
const clientPayload = (h) => h.slice(-HISTORY_MAX).map((m) => ({ role: m.role, text: m.role === "assistant" ? m.text.slice(0, ASSISTANT_MAX) : m.text }));

let seq = 0;
async function http(method, pathname, body, origin) {
  const headers = { "x-client-ip": "eval-" + ++seq };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  const res = await core.handle(new Request("http://bot.local" + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, raw: await res.text() };
}

async function main() {
  const kb = await loadKb(env);
  const stBy = Object.fromEntries(kb.stations.map((s) => [s.code, s]));
  const ldBy = Object.fromEntries(kb.loads.map((l) => [l.id, l]));
  let staticNums = new Set();
  for (const txt of [].concat(kb.rules, kb.clarify, kb.faq.map((f) => f.q + " " + f.a), [kb.contacts.phone, kb.contacts.email])) union(staticNums, nums(txt));

  let cases = JSON.parse(fs.readFileSync(args.cases || path.join(ROOT, "tests", "bot_cases.json"), "utf8"));
  if (args.only) { const ids = args.only.split(","); cases = cases.filter((c) => ids.includes(c.id)); }

  function evaluate(checks, numbersOn, status, resp, ctx, tag) {
    const fails = [];
    const reply = resp.reply || "", cards = resp.cards || [], tl = (resp.trace && resp.trace.tools) || [];
    const need = (cond, msg) => { if (!cond) fails.push(tag + msg); };
    for (const ch of checks) {
      const t = ch.t;
      if (t === "status") need(status === ch.v, "HTTP " + status + ", ожидался " + ch.v);
      else if (t === "handoff") need(!!resp.handoff === ch.v, "handoff=" + resp.handoff + ", ожидался " + ch.v);
      else if (t === "no_cards") need(!cards.length, "есть карточки: " + cards.map((c) => c.code));
      else if (t === "tool_min") {
        const sels = tl.filter((x) => x.name === "select_stations" && x.result.summary);
        const sm = sels.length ? sels[sels.length - 1].result.summary : {};
        need((sm.total_watts || 0) >= ch.watts && (sm.avg_watts || 0) >= ch.avg, "в select_stations переданы не все приборы: сумма " + sm.total_watts + "/" + sm.avg_watts + " Вт, ожидалось не меньше " + ch.watts + "/" + ch.avg);
      }
      else if (t === "cards_min") need(cards.length >= ch.n, "карточек " + cards.length + ", нужно не меньше " + ch.n);
      else if (t === "cards_body") need(cards.length > 0 && cards.every((c) => c.code.endsWith("-" + ch.v)), "не все карточки с корпусом " + ch.v + ": " + cards.map((c) => c.code));
      else if (t === "tool_called") need(tl.some((x) => x.name === ch.name), "не вызван инструмент " + ch.name);
      else if (t === "has") need(ch.re.some((p) => rx(p).test(reply)), "в ответе нет ни одного из: " + JSON.stringify(ch.re));
      else if (t === "has_all") need(ch.re.every((p) => rx(p).test(reply)), "в ответе нет всех из: " + JSON.stringify(ch.re));
      else if (t === "none") { for (const p of ch.re) { const m = rx(p).exec(reply); need(!m, "в ответе запрещённое «" + (m ? m[0] : p) + "»"); } }
      else if (t === "contacts") need(reply.includes("978") && reply.includes("apv0050"), "в ответе нет телефона и почты");
      else if (t === "cyrillic") need(/[А-Яа-яЁё]/.test(reply), "ответ не на русском");
      else if (t === "price") {
        const want = stBy[ch.code].price_rub;
        need(nums(reply).has(Number(want)), "в ответе нет цены " + want);
        need(cards.some((c) => c.code === ch.code && c.price === want) || ch.card === false, "нет карточки " + ch.code + " с ценой " + want);
      }
      else if (t === "cards_fit") {
        const loads = ch.loads.map((i) => ldBy[i]);
        const watts = loads.reduce((s, l) => s + (l.watts === null ? 20 : l.watts), 0);
        const avg = loads.reduce((s, l) => s + (l.avg === null ? (l.watts === null ? 20 : l.watts) : l.avg), 0);
        const start = Math.max(0, ...loads.map((l) => l.start || 0));
        for (const c of cards) {
          const s = stBy[c.code];
          if (!s) { fails.push(tag + "карточка с неизвестным кодом " + c.code); continue; }
          const hours = s.cap_wh * kb.eff / avg;
          need(s.power_w >= watts, c.code + ": мощность " + s.power_w + " < нагрузки " + watts);
          need(s.peak_w >= start, c.code + ": пик " + s.peak_w + " < пусковой " + start);
          need(hours >= ch.hours, c.code + ": часов " + hours.toFixed(1) + " < " + ch.hours);
          need(c.price === s.price_rub, c.code + ": цена в карточке " + c.price + ", в каталоге " + s.price_rub);
        }
      }
      else if (t === "charge_numbers") {
        const s = stBy[ch.code].charge, want = new Set();
        for (const key of ["t80_h", "t100_h"]) { const v = s[key]; if (v && typeof v === "object") { want.add(Number(v.lo)); want.add(Number(v.hi)); } else if (v !== null && v !== undefined) want.add(Number(v)); }
        const got = nums(reply);
        need([...want].some((x) => got.has(x)), "в ответе нет чисел зарядки из базы знаний " + JSON.stringify([...want].sort((a, b) => a - b)));
      }
    }
    for (const x of tl) union(ctx.toolNums, nums(JSON.stringify(x.result)));
    if (numbersOn && reply) {
      const allowed = union(union(new Set(staticNums), ctx.toolNums), ctx.userNums);
      for (const v of [...allowed]) if (v >= 100 && v % 100 === 0) allowed.add(v / 1000);
      const odd = [...nums(reply)].filter((v) => !allowed.has(v) && ![1, 2, 3].includes(v)).sort((a, b) => a - b);
      if (odd.length) fails.push(tag + "числа в ответе, которых нет в инструментах/базе: " + JSON.stringify(odd));
    }
    return fails;
  }

  const parse = (raw) => { try { return JSON.parse(raw); } catch (_) { return null; } };

  /* один прогон кейса; возвращает {ok, fails} */
  async function runOnce(c) {
    const fails = [];
    const origin = c.origin || "http://localhost:8765";
    const ctx = { toolNums: new Set(), userNums: new Set() };
    if (c.kind === "health") {
      const r = await http("GET", "/health", undefined, origin); const resp = parse(r.raw) || {};
      if (!resp.ok) fails.push("ответ /health без ok=true");
      return { ok: !fails.length, fails: fails.concat(evaluate(c.checks, false, r.status, resp, ctx, "")) };
    }
    if (c.turns) {
      let history = [];
      if (c.history_fill) {
        for (let i = 0; i < c.history_fill.pairs; i++) {
          history.push({ role: "user", text: "Расскажи про зарядку, вопрос " + (i + 1) });
          history.push({ role: "assistant", text: "Станция заряжается от розетки 220 В. ".repeat(60).slice(0, c.history_fill.assistant_chars) });
        }
      }
      for (let n = 1; n <= c.turns.length; n++) {
        const turn = c.turns[n - 1];
        history.push({ role: "user", text: turn.say }); union(ctx.userNums, nums(turn.say));
        const r = await http("POST", "/chat", { messages: c.no_client_trim ? history : clientPayload(history) }, origin);
        const resp = parse(r.raw);
        if (!resp) { fails.push("ход " + n + ": ответ не JSON"); history.push({ role: "assistant", text: "" }); continue; }
        fails.push(...evaluate((turn.checks || []).concat([{ t: "none", re: ["длиннее \\d+ символов", "слишком длинн"] }]), turn.numbers !== undefined ? turn.numbers : c.numbers !== false, r.status, resp, ctx, "ход " + n + ": "));
        history.push({ role: "assistant", text: resp.reply || "" });
        if (n < c.turns.length) await sleep(turnDelayMs);
      }
      return { ok: !fails.length, fails };
    }
    let msgs = c.messages || [{ role: "user", text: "x".repeat(c.long || 1) }];
    if (c.long) msgs = [{ role: "user", text: (("Подберите станцию " + "для холодильника ".repeat(40)).repeat(2)).slice(0, c.long + 50) }];
    for (const m of msgs) union(ctx.userNums, nums(m.text));
    const r = await http("POST", "/chat", { messages: msgs }, origin);
    const resp = parse(r.raw);
    if (!resp) return { ok: false, fails: ["ответ не JSON"] };
    const fl = evaluate(c.checks, c.numbers !== false, r.status, resp, ctx, "");
    return { ok: !fl.length, fails: fl };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const providerTrouble = () => errors.some((e) => e.kind === "timeout" || e.kind === "network" || e.status === 429 || e.status >= 500);

  out("Оценка моделей: provider=" + providerName(env) + " model=" + (env.MODEL || "(по умолчанию)") + " fallback=" + (env.FALLBACK_MODEL || "нет") + "; кейсов: " + cases.length + ", пауза " + delayMs + " мс, повторов при 429: " + retries);
  const rows = [];
  for (const c of cases) {
    if (c.target !== "main" || c.kind === "rate") { rows.push({ id: c.id, status: "ПРОПУСК", attempts: 0, ms: 0, pin: 0, pout: 0, calls: 0, missing: 0, note: "нужен отдельный сервер (" + c.target + "), см. scripts/test_bot.py" }); continue; }
    const t0 = usage.prompt, o0 = usage.completion, c0 = usage.calls, m0 = usage.missing; usageLines = [];
    let res = null, attempts = 0, ms = 0, stuck = false;
    for (let k = 0; k <= retries; k++) {
      attempts++; errors = [];
      const s = Date.now(); quiet();
      try { res = await runOnce(c); } catch (e) { res = { ok: false, fails: ["исключение: " + (e && e.name)] }; } finally { loud(); }
      ms = Date.now() - s;
      if (res.ok) break;
      if (providerTrouble() && k < retries) { await sleep(retryWaitMs * (k + 1)); continue; }
      stuck = providerTrouble();
      break;
    }
    rows.push({ id: c.id, status: res.ok ? "PASS" : (stuck ? "НЕ ПРОВЕРЕН" : "FAIL"), attempts, ms, pin: usage.prompt - t0, pout: usage.completion - o0, calls: usage.calls - c0, missing: usage.missing - m0, note: res.ok ? "" : (stuck ? "ответ модели не получен: " + [...new Set(errors.map((e) => e.kind + (e.status ? " " + e.status : "")))].join(", ") : res.fails.join("; ").slice(0, 160)) });
    out("  [" + rows.length + "/" + cases.length + "] " + c.id + ": " + rows[rows.length - 1].status + (attempts > 1 ? " (попыток " + attempts + ")" : ""));   /* прогресс: длинный прогон не молчит до конца */
    if (args["usage-lines"]) {
      const nd = (v) => (v === null || v === undefined ? "нет данных" : v);
      for (const u of usageLines) out("      llm_usage " + JSON.stringify({ provider: u.provider, model: u.model, prompt_tokens: nd(u.prompt_tokens), completion_tokens: nd(u.completion_tokens), finish: nd(u.finish), ms: u.ms }));
    }
    await sleep(delayMs);
  }

  /* ---------- таблица ---------- */
  /* токены и стоимость: «нет данных», если провайдер не прислал usage ни по одному вызову кейса; «≥N», если не по всем */
  const noData = (r) => r.calls > 0 && r.missing === r.calls, partial = (r) => r.missing > 0 && r.missing < r.calls;
  const cost = (r) => (priceIn === null || priceOut === null ? null : (r.pin * priceIn + r.pout * priceOut) / 1e6);
  const fmt = (x) => (x === null ? "-" : x.toFixed(x < 0.01 ? 5 : 4));
  const tok = (r, n) => (noData(r) ? "нет данных" : (partial(r) ? "≥" : "") + n);
  const money = (r) => (noData(r) ? "нет данных" : (partial(r) ? "≥" : "") + fmt(cost(r)));
  const w = Math.max(5, ...rows.map((r) => r.id.length));
  out("\n" + "кейс".padEnd(w) + "  " + "итог".padEnd(11) + " " + "попыт".padStart(5) + " " + "время,с".padStart(8) + " " + "ток.вх".padStart(10) + " " + "ток.вых".padStart(10) + " " + "стоимость".padStart(11) + "  примечание");
  for (const r of rows) out(r.id.padEnd(w) + "  " + r.status.padEnd(11) + " " + String(r.attempts).padStart(5) + " " + (r.ms / 1000).toFixed(1).padStart(8) + " " + String(tok(r, r.pin)).padStart(10) + " " + String(tok(r, r.pout)).padStart(10) + " " + String(money(r)).padStart(11) + "  " + r.note);
  const ran = rows.filter((r) => r.status !== "ПРОПУСК");
  const pass = rows.filter((r) => r.status === "PASS").length, fail = rows.filter((r) => r.status === "FAIL").length, stuck = rows.filter((r) => r.status === "НЕ ПРОВЕРЕН").length;
  const tin = ran.reduce((s, r) => s + r.pin, 0), tout = ran.reduce((s, r) => s + r.pout, 0);
  const noDataCases = ran.filter((r) => r.missing > 0).length;
  const total = priceIn === null || priceOut === null ? null : (tin * priceIn + tout * priceOut) / 1e6;
  out("\nИтого: прошло " + pass + " из " + ran.length + ", не прошло " + fail + ", не проверено из-за 429 или сбоя провайдера " + stuck + ", пропущено " + (rows.length - ran.length));
  const calls = ran.reduce((s, r) => s + r.calls, 0), missing = ran.reduce((s, r) => s + r.missing, 0);
  if (calls > 0 && missing === calls) out("Токены: нет данных (провайдер не присылает usage)");
  else {
    out("Токены: вход " + tin + ", выход " + tout + " (в среднем на кейс: " + (ran.length ? Math.round(tin / ran.length) : 0) + " и " + (ran.length ? Math.round(tout / ran.length) : 0) + ")" + (noDataCases ? "; по " + noDataCases + " кейсам данные неполные или отсутствуют, суммы занижены" : ""));
  }
  if (total === null) out("Стоимость: не считалась (задайте --price-in и --price-out: цена за миллион токенов)");
  else if (calls > 0 && missing === calls) out("Стоимость: нет данных (нет счётчиков токенов)");
  else out("Стоимость всех кейсов: " + (noDataCases ? "≥" : "") + fmt(total) + " (вход " + priceIn + " + выход " + priceOut + " за млн токенов); в среднем на кейс: " + fmt(ran.length ? total / ran.length : 0));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ provider: providerName(env), model: env.MODEL || null, fallback: env.FALLBACK_MODEL || null, price_in: priceIn, price_out: priceOut, rows, totals: { pass, fail, not_checked: stuck, tokens_in: tin, tokens_out: tout, cost: total, calls, calls_without_usage: missing } }, null, 1), "utf8");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { loud(); console.error("Ошибка прогона: " + (e && e.name) + ": " + (e && e.message ? String(e.message).slice(0, 200) : "")); process.exit(2); });
