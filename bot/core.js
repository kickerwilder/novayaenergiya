"use strict";
/* Ядро бота: чистая функция handle(Request, env) -> Response на Web-стандарте (Request/Response/fetch).
   Одинаково запускается в Node (server.js), в облачной функции (cloud.js) и в любом окружении с fetch API.
   Эндпоинты: POST /chat, GET /health. Секреты читаются только из env и нигде не печатаются. */

const crypto = require("crypto");
const { loadKb } = require("./kb.js");
const tools = require("./tools.js");
const { generate, ProviderError } = require("./provider.js");

const PHONE = "+7 978 728-00-02", EMAIL = "apv0050@gmail.com";
const HANDOFF_TEXT = "Сейчас не могу ответить, позвоните " + PHONE + " или напишите на " + EMAIL;
const LIMITS = { bodyBytes: 8192, messages: 20, chars: 500, toolIterations: 4 };

/* ---------- лимиты запросов (в памяти процесса; при перезапуске обнуляются) ---------- */
const perClient = new Map();
const daily = { day: "", n: 0 };
const startSalt = crypto.randomBytes(16).toString("hex");

function clientKey(request, env) {
  const ip = request.headers.get("x-client-ip") || "unknown"; /* заголовок выставляет обёртка (server.js), IP нигде не логируется */
  return crypto.createHash("sha256").update((env.RATE_SALT || startSalt) + ip).digest("hex").slice(0, 16);
}
function overLimit(key, env) {
  const now = Date.now(), win = (Number(env.RATE_WINDOW_S) || 600) * 1000, max = Number(env.RATE_LIMIT) || 20;
  const arr = (perClient.get(key) || []).filter((t) => now - t < win);
  if (arr.length >= max) { perClient.set(key, arr); return true; }
  arr.push(now); perClient.set(key, arr);
  if (perClient.size > 5000) for (const [k, v] of perClient) if (!v.length || now - v[v.length - 1] > win) perClient.delete(k);
  return false;
}
function overDailyCap(env) {
  const day = new Date().toISOString().slice(0, 10);
  if (daily.day !== day) { daily.day = day; daily.n = 0; }
  daily.n++;
  return daily.n > (Number(env.DAILY_CAP) || 500);
}

/* ---------- ответы ---------- */
function parseOrigins(s) {
  return String(s === undefined ? "https://kickerwilder.github.io" : s).split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
}
function respond(obj, status, origin, extra) {
  const headers = Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, extra || {});
  if (origin) { headers["access-control-allow-origin"] = origin; headers["vary"] = "Origin"; }
  return new Response(JSON.stringify(obj), { status, headers });
}
const say = (reply, o) => Object.assign({ reply, cards: [], handoff: false }, o || {});

/* ---------- системная инструкция: prompt.md + данные из базы знаний (правила, НЕ ПОДТВЕРЖДЕНО, FAQ, контакты, приборы) ---------- */
let promptText = null;
function readPrompt(env) {
  if (promptText) return promptText;
  if (env.PROMPT_TEXT) return (promptText = env.PROMPT_TEXT);
  const fs = require("fs"), path = require("path");
  return (promptText = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8"));
}
const systemCache = new WeakMap();
function buildSystem(kb, env) {
  if (systemCache.has(kb)) return systemCache.get(kb);
  const s = readPrompt(env) +
    "\n## Правила\n" + kb.rules.map((r) => "- " + r).join("\n") +
    "\n\n## НЕ ПОДТВЕРЖДЕНО (цифр не называть, отвечать «уточним у менеджера» и давать контакты)\n" + kb.unconfirmed.map((r) => "- " + r).join("\n") +
    "\n\n## Частые вопросы (ответы можно пересказывать)\n" + kb.faq.map((f) => "Вопрос: " + f.q + "\nОтвет: " + f.a).join("\n\n") +
    "\n\n## Контакты\nТелефон " + kb.contacts.phone + ", почта " + kb.contacts.email + ".\n" +
    "\n## Приборы в списке (id — название; мощности смотри в list_loads)\n" + kb.loads.map((l) => l.id + " — " + l.name).join("\n") + "\n";
  systemCache.set(kb, s);
  return s;
}

/* ---------- карточки собирает код из результатов инструментов ---------- */
function cardsFrom(toolLog) {
  const sel = toolLog.filter((t) => t.name === "select_stations" && t.result && t.result.options).pop();
  if (sel) {
    return sel.result.options.filter((o) => o.fits_power && o.fits_peak).slice(0, 3).map((o) => ({
      code: o.code, title: o.title, power: o.power_w, cap: o.cap_wh, price: o.price_rub, hours: o.hours_text,
      note: o.kind + (o.notes && o.notes[0] && !o.fits_power ? ": " + o.notes[0] : ""),
    }));
  }
  const out = [];
  toolLog.filter((t) => t.name === "get_station" && t.result && t.result.stations).forEach((t) => {
    t.result.stations.forEach((s) => { if (out.length < 3 && !out.some((c) => c.code === s.code)) out.push({ code: s.code, title: s.title, power: s.power_w, cap: s.cap_wh, price: s.price_rub, hours: null, note: s.body }); });
  });
  return out;
}

function clean(text) {
  return String(text).replace(/\*\*/g, "").replace(/`/g, "").replace(/^\s*[*-]\s+/gm, "• ").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------- запрос к модели с запасной моделью ---------- */
async function callModel(env, args) {
  const models = [env.MODEL || "gemini-3.5-flash-lite"];
  if (env.FALLBACK_MODEL && env.FALLBACK_MODEL !== models[0]) models.push(env.FALLBACK_MODEL);
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    /* при наличии запасной модели первая получает не весь бюджет времени, чтобы запасная успела ответить */
    const deadline = i === 0 && models.length > 1 ? Math.min(args.deadline, Date.now() + 9000) : args.deadline;
    try { return await generate(env, Object.assign({}, args, { model, deadline })); }
    catch (e) {
      lastErr = e;
      const retry = e instanceof ProviderError && (e.kind !== "http" || e.status === 404 || e.status === 429 || e.status >= 500);
      if (!retry || Date.now() > args.deadline - 1500) break;
    }
  }
  throw lastErr;
}

async function chat(request, env, origin) {
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > LIMITS.bodyBytes) return respond(say("Сообщение слишком большое. Сократите его и отправьте снова."), 413, origin);
  let body;
  try { body = JSON.parse(raw); } catch (_) { return respond(say("Не удалось прочитать сообщение."), 400, origin); }
  let msgs = body && body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return respond(say("Напишите, пожалуйста, ваш вопрос."), 400, origin);
  if (msgs.length > LIMITS.messages) return respond(say("Диалог получился слишком длинным. Начните новый или позвоните " + PHONE + "."), 400, origin);
  const clean_ = [];
  for (const m of msgs) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return respond(say("Не удалось прочитать сообщение."), 400, origin);
    const text = m.text.trim();
    if (text.length > LIMITS.chars) return respond(say("Сообщение длиннее " + LIMITS.chars + " символов. Сократите его, пожалуйста."), 400, origin);
    if (!text) continue;
    const last = clean_[clean_.length - 1];
    if (last && last.role === m.role) last.text += "\n" + text; else clean_.push({ role: m.role, text });
  }
  while (clean_.length && clean_[0].role !== "user") clean_.shift();
  if (!clean_.length || clean_[clean_.length - 1].role !== "user") return respond(say("Напишите, пожалуйста, ваш вопрос."), 200, origin);

  const key = clientKey(request, env);
  if (overLimit(key, env) || overDailyCap(env)) return respond(say(HANDOFF_TEXT, { handoff: true }), 429, origin);
  if (String(env.LOG_QUESTIONS) === "1") console.log("question: " + clean_[clean_.length - 1].text); /* только текст вопроса, без IP и метаданных */

  const trace = String(env.TEST_TRACE) === "1";
  const deadline = Date.now() + (Number(env.TIMEOUT_MS) || 20000);
  try {
    const kb = await loadKb(env);
    const system = buildSystem(kb, env);
    const contents = clean_.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
    const toolLog = [];
    let handoff = false, final = null;
    for (let step = 0; step <= LIMITS.toolIterations; step++) {
      const useTools = step < LIMITS.toolIterations;
      const r = await callModel(env, { system, contents, tools: useTools ? tools.declarations : [], deadline });
      if (!r.calls.length) { final = r; break; }
      if (!useTools) break;
      contents.push(r.content); /* ответ модели целиком, вместе с thoughtSignature */
      const parts = r.calls.map((c) => {
        const result = tools.execute(c.name, c.args, kb);
        if (c.name === "handoff_to_manager") handoff = true;
        toolLog.push({ name: c.name, args: c.args, result });
        return { functionResponse: { name: c.name, response: result } };
      });
      contents.push({ role: "user", parts });
    }
    const reply = final && final.text ? clean(final.text) : "";
    if (!reply) return respond(say(HANDOFF_TEXT, { handoff: true }), 200, origin);
    const out = say(reply, { cards: cardsFrom(toolLog), handoff });
    if (trace) out.trace = { tools: toolLog };
    return respond(out, 200, origin);
  } catch (e) {
    /* сырые ошибки провайдера и сервера клиенту не отдаются; в лог — только вид сбоя без текста ответа */
    console.error("chat_error: " + (e instanceof ProviderError ? e.kind + (e.status ? " " + e.status : "") : "internal"));
    return respond(say(HANDOFF_TEXT, { handoff: true }), 200, origin);
  }
}

async function handle(request, env) {
  env = env || process.env;
  const url = new URL(request.url);
  const origin = (request.headers.get("origin") || "").replace(/\/+$/, "");
  const originOk = !!origin && parseOrigins(env.ALLOWED_ORIGINS).includes(origin);
  const method = request.method.toUpperCase();

  if (url.pathname === "/health" && (method === "GET" || method === "HEAD")) return respond({ ok: true }, 200, originOk ? origin : "");
  if (url.pathname === "/chat") {
    if (method === "OPTIONS") {
      if (!originOk) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "Origin" } });
    }
    if (method !== "POST") return respond({ error: "method_not_allowed" }, 405, "");
    if (!originOk) return respond({ error: "forbidden" }, 403, "");
    return chat(request, env, origin);
  }
  return respond({ error: "not_found" }, 404, "");
}

module.exports = { handle, LIMITS, HANDOFF_TEXT };
