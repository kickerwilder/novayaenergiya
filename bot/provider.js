"use strict";
/* Адаптеры провайдеров модели. Ядро (core.js, llm.js, tools.js) знает только про
     generate(env, {model, system, contents, tools, deadline}) -> {content, text, calls, finishReason, usage}
   где contents и tools в нейтральном виде (как в Gemini: {role: "user"|"model", parts: [{text} | {functionCall} | {functionResponse}]}).
   PROVIDER=gemini (по умолчанию): нативный generateContent, этот файл.
   PROVIDER=openai: любой OpenAI-совместимый chat/completions, bot/provider_openai.js (перевод истории и вызовов инструментов туда и обратно).
   Ключ, заголовки и прокси берутся из env и нигде не печатаются; тела ответов провайдера не читаются в лог. */

const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

let proxyCache = { url: null, dispatcher: null, fetch: null };

/* Прокси из PROXY_URL: socks5:// (SOCKS-агент) или http(s):// (ProxyAgent). Нет PROXY_URL — прямое соединение. */
function transport(env) {
  const url = env.PROXY_URL || "";
  if (!url) return { dispatcher: undefined, fetch: globalThis.fetch };
  if (proxyCache.url === url) return proxyCache;
  const undici = require("undici");
  const u = new URL(url);
  let dispatcher;
  if (/^socks/i.test(u.protocol)) {
    const { SocksClient } = require("socks");
    const tls = require("tls");
    dispatcher = new undici.Agent({
      connect(opts, cb) {
        SocksClient.createConnection({
          proxy: { host: u.hostname, port: Number(u.port), type: 5, userId: decodeURIComponent(u.username), password: decodeURIComponent(u.password) },
          command: "connect",
          destination: { host: opts.hostname, port: Number(opts.port) || 443 },
          timeout: 10000,
        }).then(({ socket }) => {
          if (opts.protocol !== "https:") return cb(null, socket);
          const t = tls.connect({ socket, servername: opts.servername || opts.hostname, ALPNProtocols: ["http/1.1"] });
          t.once("secureConnect", () => cb(null, t));
          t.once("error", (e) => cb(e));
        }).catch((e) => cb(e));
      },
    });
  } else {
    dispatcher = new undici.ProxyAgent(url);
  }
  proxyCache = { url, dispatcher, fetch: undici.fetch };
  return proxyCache;
}

/* Транспорт для запросов к МОДЕЛИ. LLM_USE_PROXY=0 — напрямую (PROXY_URL остаётся только для Telegram); по умолчанию 1 (как раньше). */
function llmTransport(env) {
  if (String(env.LLM_USE_PROXY) === "0") return { dispatcher: undefined, fetch: globalThis.fetch };
  return transport(env);
}

/* kind: no_key, config, timeout, network, http (status), bad_json, empty. Тела ответов провайдера в ошибке не хранятся.
   retryAfterMs — пауза из заголовка Retry-After, если провайдер её прислал. */
class ProviderError extends Error {
  constructor(kind, status, retryAfterMs) {
    super(kind + (status ? " " + status : ""));
    this.kind = kind; this.status = status || 0; this.retryAfterMs = retryAfterMs == null ? null : retryAfterMs;
  }
}

/* ---------- настройки: PROVIDER, PROVIDER_EXTRA_BODY, PROVIDER_EXTRA_HEADERS ---------- */
const PROVIDERS = ["gemini", "openai"];
const RESERVED_BODY = { gemini: ["contents", "systemInstruction", "tools", "toolConfig"], openai: ["model", "messages", "tools", "tool_choice", "stream"] };

function providerName(env) { return String(env.PROVIDER || "gemini").trim().toLowerCase(); }

function parseJsonVar(raw) {
  if (raw === undefined || String(raw).trim() === "") return { ok: true, value: null };
  try {
    const v = JSON.parse(String(raw));
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false };
    return { ok: true, value: v };
  } catch (_) { return { ok: false }; }
}

/* Проверка настроек. Тексты сообщений называют только имена переменных, значения (в них могут быть секреты) не повторяются. */
function checkConfig(env) {
  const errors = [], warnings = [];
  const p = providerName(env);
  if (!PROVIDERS.includes(p)) errors.push("PROVIDER: допустимы gemini или openai");
  const eb = parseJsonVar(env.PROVIDER_EXTRA_BODY);
  if (!eb.ok) errors.push('PROVIDER_EXTRA_BODY: некорректный JSON, ожидается объект вида {"поле": значение}');
  else if (eb.value && PROVIDERS.includes(p)) {
    const bad = RESERVED_BODY[p].filter((k) => k in eb.value);
    if (bad.length) errors.push("PROVIDER_EXTRA_BODY: нельзя переопределять поля " + bad.join(", "));
  }
  const eh = parseJsonVar(env.PROVIDER_EXTRA_HEADERS);
  if (!eh.ok) errors.push('PROVIDER_EXTRA_HEADERS: некорректный JSON, ожидается объект вида {"Имя": "значение"}');
  else if (eh.value && !Object.values(eh.value).every((v) => v === null || typeof v === "string" || typeof v === "number")) errors.push("PROVIDER_EXTRA_HEADERS: значения должны быть строками");
  if (env.LLM_USE_PROXY !== undefined && env.LLM_USE_PROXY !== "" && !/^[01]$/.test(String(env.LLM_USE_PROXY))) errors.push("LLM_USE_PROXY: допустимы 1 или 0");
  if (p === "openai") {
    if (!String(env.PROVIDER_BASE_URL || "").trim()) errors.push("PROVIDER=openai: задайте PROVIDER_BASE_URL (адрес из личного кабинета провайдера)");
    else if (!/^https?:\/\//i.test(String(env.PROVIDER_BASE_URL).trim())) errors.push("PROVIDER_BASE_URL: адрес должен начинаться с https://");
    if (!String(env.MODEL || "").trim()) errors.push("PROVIDER=openai: задайте MODEL (точное название модели из личного кабинета провайдера)");
  }
  if (!String(env.PROVIDER_API_KEY || "").trim()) warnings.push("PROVIDER_API_KEY не задан: бот будет отвечать контактами менеджера");
  return { errors, warnings };
}

/* Разобранные дополнительные поля (результат кешируется по строке: разбор на каждый запрос не нужен) */
const extraCache = new Map();
function extraFrom(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return null;
  const k = name + "\u0000" + raw;
  if (!extraCache.has(k)) {
    const r = parseJsonVar(raw);
    if (!r.ok) throw new ProviderError("config");
    if (extraCache.size > 20) extraCache.clear();
    extraCache.set(k, r.value);
  }
  return extraCache.get(k);
}

/* Слияние дополнительных полей запроса: объекты сливаются вглубь, значение null удаляет поле, остальное заменяет. */
function mergeExtra(target, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === null) delete target[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) mergeExtra(target[k], v);
    else target[k] = v;
  }
  return target;
}

/* Заголовки: дополнительные добавляются к основным (имена без учёта регистра); значение null или пустая строка убирает заголовок. */
function mergeHeaders(base, extra) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(extra || {})) {
    for (const have of Object.keys(out)) if (have.toLowerCase() === k.toLowerCase()) delete out[have];
    if (v !== null && String(v) !== "") out[k] = String(v);
  }
  return out;
}

/* Retry-After: секунды или дата HTTP; нет заголовка или непонятное значение — null */
function parseRetryAfter(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

/* ---------- Gemini ---------- */
const noThinking = new Set(); /* модели, которые не приняли thinkingConfig */

async function generateGemini(env, { model, system, contents, tools, deadline }) {
  const key = env.PROVIDER_API_KEY;
  if (!key) throw new ProviderError("no_key");
  const base = (env.PROVIDER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const t = llmTransport(env);
  const level = env.THINKING_LEVEL === undefined ? "minimal" : env.THINKING_LEVEL;
  const extraBody = extraFrom(env, "PROVIDER_EXTRA_BODY"), extraHeaders = extraFrom(env, "PROVIDER_EXTRA_HEADERS");

  async function once(withThinking) {
    const generationConfig = { temperature: 0.3, maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS) || 600 };
    if (withThinking && level) generationConfig.thinkingConfig = { thinkingLevel: level };
    const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig };
    if (tools && tools.length) {
      body.tools = [{ functionDeclarations: tools }];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
    if (extraBody) mergeExtra(body, extraBody);
    const left = Math.max(1000, deadline - Date.now());
    let res;
    try {
      res = await t.fetch(base + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: mergeHeaders({ "content-type": "application/json", "x-goog-api-key": key }, extraHeaders),
        body: JSON.stringify(body),
        dispatcher: t.dispatcher,
        signal: AbortSignal.timeout(left),
      });
    } catch (e) {
      throw new ProviderError(e && e.name === "TimeoutError" ? "timeout" : "network");
    }
    const text = await res.text();
    if (!res.ok) {
      const thinkingProblem = res.status === 400 && /thinking/i.test(text);
      const err = new ProviderError("http", res.status, parseRetryAfter(res.headers.get("retry-after")));
      err.thinkingProblem = thinkingProblem;
      throw err;
    }
    try { return JSON.parse(text); } catch (_) { throw new ProviderError("bad_json"); }
  }

  let data;
  try {
    data = await once(!noThinking.has(model));
  } catch (e) {
    if (e.thinkingProblem && !noThinking.has(model)) { noThinking.add(model); data = await once(false); }
    else throw e;
  }
  const cand = data.candidates && data.candidates[0];
  if (!cand || !cand.content || !Array.isArray(cand.content.parts)) throw new ProviderError("empty", 0);
  const parts = cand.content.parts;
  const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
  const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
  const um = data.usageMetadata || {};
  /* расход токенов: только числа (мысли модели оплачиваются как выходные токены) */
  const usage = {
    prompt_tokens: Number.isFinite(um.promptTokenCount) ? um.promptTokenCount : null,
    completion_tokens: Number.isFinite(um.candidatesTokenCount) || Number.isFinite(um.thoughtsTokenCount) ? (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0) : null,
  };
  /* content возвращается целиком, как получен (с thoughtSignature): он нужен для следующего шага вызова инструментов */
  return { content: { role: "model", parts }, text, calls, finishReason: cand.finishReason || "", usage };
}

/* ---------- выбор адаптера ---------- */
async function generate(env, args) {
  const p = providerName(env);
  if (p === "openai") return require("./provider_openai.js").generate(env, args);
  if (p !== "gemini") throw new ProviderError("config");
  return generateGemini(env, args);
}

module.exports = { generate, ProviderError, transport, llmTransport, checkConfig, providerName, extraFrom, mergeExtra, mergeHeaders, parseRetryAfter };
