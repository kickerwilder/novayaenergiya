"use strict";
/* Адаптер провайдера: Gemini API, нативный формат generateContent (чистый fetch, заголовок x-goog-api-key).
   Чтобы подключить другого провайдера, замените реализацию generate(): ядро (core.js) знает только про
   {system, contents, tools} -> {content, text, calls, finishReason}. Ключ и прокси берутся из env и нигде не печатаются. */

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

class ProviderError extends Error {
  constructor(kind, status) { super(kind + (status ? " " + status : "")); this.kind = kind; this.status = status || 0; }
}

const noThinking = new Set(); /* модели, которые не приняли thinkingConfig */

/* Один вызов модели. Возвращает {content, text, calls, finishReason}; любые сбои — ProviderError без тела ответа. */
async function generate(env, { model, system, contents, tools, deadline }) {
  const key = env.PROVIDER_API_KEY;
  if (!key) throw new ProviderError("no_key");
  const base = (env.PROVIDER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const t = transport(env);
  const level = env.THINKING_LEVEL === undefined ? "minimal" : env.THINKING_LEVEL;

  async function once(withThinking) {
    const generationConfig = { temperature: 0.3, maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS) || 600 };
    if (withThinking && level) generationConfig.thinkingConfig = { thinkingLevel: level };
    const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig };
    if (tools && tools.length) {
      body.tools = [{ functionDeclarations: tools }];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
    const left = Math.max(1000, deadline - Date.now());
    let res;
    try {
      res = await t.fetch(base + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
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
      const err = new ProviderError("http", res.status);
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
  /* content возвращается целиком, как получен (с thoughtSignature): он нужен для следующего шага вызова инструментов */
  return { content: { role: "model", parts }, text, calls, finishReason: cand.finishReason || "" };
}

module.exports = { generate, ProviderError };
