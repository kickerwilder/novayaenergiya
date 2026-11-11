"use strict";
/* Проверка связи с Gemini API через SOCKS5-прокси. Секреты берутся из bot/.env и НИКОГДА не печатаются.
   Запуск: node proxy_check.js [имя_модели] */
const fs = require("fs");
const path = require("path");
const tls = require("tls");
const { Agent, fetch } = require("undici");
const { SocksClient } = require("socks");

function loadEnv(file) {
  const env = {};
  for (let line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv(path.join(__dirname, ".env"));
const KEY = env.PROVIDER_API_KEY, PROXY = env.PROXY_URL;
if (!KEY || !PROXY) { console.log("В bot/.env нет PROVIDER_API_KEY или PROXY_URL"); process.exit(2); }
const pu = new URL(PROXY);
const secrets = [KEY, PROXY, pu.hostname, decodeURIComponent(pu.username), decodeURIComponent(pu.password), pu.password, pu.username].filter((s) => s && s.length > 2);
function redact(s) {
  let t = String(s);
  for (const x of secrets) t = t.split(x).join("***");
  return t;
}

const dispatcher = new Agent({
  connect(opts, cb) {
    SocksClient.createConnection({
      proxy: { host: pu.hostname, port: Number(pu.port), type: 5, userId: decodeURIComponent(pu.username), password: decodeURIComponent(pu.password) },
      command: "connect",
      destination: { host: opts.hostname, port: Number(opts.port) || (opts.protocol === "https:" ? 443 : 80) },
      timeout: 15000,
    }).then(({ socket }) => {
      if (opts.protocol !== "https:") return cb(null, socket);
      const t = tls.connect({ socket, servername: opts.servername || opts.hostname, ALPNProtocols: ["http/1.1"] });
      t.once("secureConnect", () => cb(null, t));
      t.once("error", (e) => cb(e));
    }).catch((e) => cb(e));
  },
});

async function call(url, init = {}, timeoutMs = 20000) {
  const t0 = Date.now();
  const res = await fetch(url, { ...init, dispatcher, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, text };
}

(async () => {
  // 1. страна выходного IP прокси (печатаем только код страны)
  try {
    const r = await call("https://ipinfo.io/country");
    console.log("Страна выходного IP прокси:", r.status === 200 ? r.text.trim() : "не определена (HTTP " + r.status + ")");
  } catch (e) { console.log("Страна выходного IP: не определена (" + redact(e.message) + ")"); }

  // 2. список моделей Flash / Flash-Lite для этого ключа
  const H = { "x-goog-api-key": KEY };
  let models = [];
  try {
    const r = await call("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: H });
    console.log("Список моделей: HTTP", r.status, r.ms + " мс");
    if (r.status === 200) {
      models = JSON.parse(r.text).models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
      console.log("Модели flash с generateContent:", models.filter((n) => /flash/i.test(n)).join(", "));
    } else console.log(redact(r.text.slice(0, 300)));
  } catch (e) { console.log("Список моделей: ошибка —", redact(e.message)); }

  // 3. выбор модели: аргумент > MODEL из .env > стабильная flash-lite > стабильная flash
  const stable = (n) => !/preview|exp|image|tts|live|audio|thinking|latest|native|robotics|computer/i.test(n);
  const model = process.argv[2] || env.MODEL ||
    models.filter((n) => /flash-lite/i.test(n) && stable(n)).sort().pop() ||
    models.filter((n) => /flash/i.test(n) && stable(n)).sort().pop() || "gemini-2.5-flash-lite";
  console.log("Модель для теста:", model);

  // 4. десять запросов «Ответь ОК»
  const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Ответь ОК" }] }], generationConfig: { maxOutputTokens: 20, temperature: 0 } });
  let ok = 0, locationErr = 0; const times = [];
  for (let i = 1; i <= 10; i++) {
    try {
      const r = await call("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent",
        { method: "POST", headers: { ...H, "content-type": "application/json" }, body });
      let answer = "";
      if (r.status === 200) { try { answer = JSON.parse(r.text).candidates[0].content.parts.map((p) => p.text).join("").trim(); } catch (_) { answer = "(нет текста)"; } ok++; times.push(r.ms); }
      else { if (/location is not supported/i.test(r.text)) locationErr++; answer = redact(r.text.replace(/\s+/g, " ").slice(0, 200)); }
      console.log(String(i).padStart(2), "HTTP", r.status, String(r.ms).padStart(5) + " мс", "|", answer);
    } catch (e) { console.log(String(i).padStart(2), "ОШИБКА |", redact(e.message)); }
  }
  console.log("Итого: успешно " + ok + " из 10; ошибок региона: " + locationErr +
    (times.length ? "; время ответа, мс: мин " + Math.min(...times) + ", среднее " + Math.round(times.reduce((a, b) => a + b, 0) / times.length) + ", макс " + Math.max(...times) : ""));
  process.exit(ok === 10 ? 0 : 1);
})();
