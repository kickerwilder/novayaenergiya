"use strict";
/* Проверка прокси из bot/.env (PROXY_URL): HTTP (http://логин:пароль@хост:порт) или SOCKS5 (socks5://…).
   Печатает ТОЛЬКО схему прокси (http или socks5) и итог по каждому адресу: логин, пароль, хост и порт прокси, ключи и тексты ошибок не выводятся.
   Запуск: node proxy_check.js            проверка адресов Telegram и Gemini через прокси (хватает любого HTTP-ответа: это значит, что туннель работает)
           node proxy_check.js --gemini [модель]   дополнительно 10 запросов «Ответь ОК» к Gemini API (нужен PROVIDER_API_KEY; для проверки региона и квоты)
   Код выхода: 0 все адреса ответили, 1 есть адрес без ответа, 2 нет PROXY_URL.
   PROXY_CHECK_TARGETS (адреса через запятую) заменяет проверяемые адреса: нужна только тестам. */
const fs = require("fs");
const path = require("path");
const { transport } = require("./provider.js");

function loadEnv(file) {
  const env = {};
  try {
    for (let line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
  return env;
}

/* .env, затем окружение (уже заданные переменные важнее файла, как в server.js); SKIP_DOTENV=1 — файл не читать */
const env = Object.assign(String(process.env.SKIP_DOTENV) === "1" ? {} : loadEnv(path.join(__dirname, ".env")), process.env);
const PROXY = env.PROXY_URL;
if (!PROXY) { console.log("В bot/.env нет PROXY_URL"); process.exit(2); }

let scheme;
try { scheme = /^socks/i.test(new URL(PROXY).protocol) ? "socks5" : "http"; } catch (_) { console.log("PROXY_URL: некорректный адрес (ожидается http://логин:пароль@хост:порт или socks5://…)"); process.exit(2); }
console.log("Прокси: схема " + scheme);

const t = transport({ PROXY_URL: PROXY });
/* вид сбоя без текста ошибки (в нём могут быть адрес и логин прокси) */
function kind(e) {
  if (e && e.name === "TimeoutError") return "таймаут";
  const code = e && (e.code || (e.cause && e.cause.code));
  if (/407/.test(String((e && e.message) || "") + String((e && e.cause && e.cause.message) || ""))) return "прокси требует логин и пароль (407)";
  return "нет соединения" + (code ? " (" + code + ")" : "");
}
async function call(url, init, timeoutMs) {
  const t0 = Date.now();
  const res = await t.fetch(url, Object.assign({ dispatcher: t.dispatcher, signal: AbortSignal.timeout(timeoutMs || 15000), redirect: "manual" }, init || {}));
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, text };
}

const TARGETS = String(env.PROXY_CHECK_TARGETS || "https://api.telegram.org/,https://generativelanguage.googleapis.com/").split(",").map((s) => s.trim()).filter(Boolean);

(async () => {
  let bad = 0;
  for (const url of TARGETS) {
    const name = new URL(url).host;
    try { const r = await call(url); console.log(name + ": ответ HTTP " + r.status + ", " + r.ms + " мс"); }
    catch (e) { bad++; console.log(name + ": нет ответа, " + kind(e)); }
  }
  console.log(bad ? "Итог: " + bad + " из " + TARGETS.length + " адресов не отвечают через прокси" : "Итог: все адреса отвечают через прокси");

  const gi = process.argv.indexOf("--gemini");
  if (gi >= 0) {
    const KEY = env.PROVIDER_API_KEY;
    if (!KEY) { console.log("Gemini: в bot/.env нет PROVIDER_API_KEY"); process.exit(bad ? 1 : 2); }
    const model = process.argv[gi + 1] && !process.argv[gi + 1].startsWith("--") ? process.argv[gi + 1] : (env.MODEL || "gemini-3.5-flash-lite");
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Ответь ОК" }] }], generationConfig: { maxOutputTokens: 20, temperature: 0 } });
    let ok = 0, region = 0; const times = [];
    for (let i = 1; i <= 10; i++) {
      try {
        const r = await call("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", { method: "POST", headers: { "x-goog-api-key": KEY, "content-type": "application/json" }, body }, 20000);
        if (r.status === 200) { ok++; times.push(r.ms); } else if (/location is not supported/i.test(r.text)) region++;
        console.log("Gemini " + String(i).padStart(2) + ": HTTP " + r.status + ", " + r.ms + " мс");
      } catch (e) { console.log("Gemini " + String(i).padStart(2) + ": нет ответа, " + kind(e)); }
    }
    console.log("Gemini итог: успешно " + ok + " из 10" + (region ? "; ошибок региона: " + region : "") + (times.length ? "; среднее " + Math.round(times.reduce((a, b) => a + b, 0) / times.length) + " мс" : ""));
    process.exit(bad || ok < 10 ? 1 : 0);
  }
  process.exit(bad ? 1 : 0);
})();
