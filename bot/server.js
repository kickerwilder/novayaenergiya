"use strict";
/* Локальный запуск и запуск на VPS: node server.js
   Читает bot/.env (если файл есть; уже заданные переменные окружения важнее файла). Секреты не печатаются. */
const path = require("path");
const http = require("http");
const { loadDotEnv } = require("./dotenv.js");
loadDotEnv(path.join(__dirname, ".env"));

const { handle } = require("./core.js");
const { checkConfig, providerName } = require("./provider.js");

/* Проверка настроек при старте: понятная ошибка (имена переменных, без значений) вместо падения на первом запросе клиента */
const cfg = checkConfig(process.env);
cfg.warnings.forEach((w) => console.warn("config: " + w));
if (cfg.errors.length) {
  cfg.errors.forEach((e) => console.error("config_error: " + e));
  console.error("Бот не запущен: исправьте bot/.env и запустите снова.");
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 8787;
const trustProxy = String(process.env.TRUST_PROXY) === "1"; /* за nginx/балансировщиком: брать IP из X-Forwarded-For */

const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; let size = 0, tooBig = false;
    for await (const c of req) {
      size += c.length;
      if (size > 1048576) break;                    /* совсем огромное тело: прекращаем читать */
      if (size > 16384) { tooBig = true; continue; } /* лимит ядра: 16 КБ; остаток дочитываем и отбрасываем */
      chunks.push(c);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (k !== "x-client-ip" && k !== "content-length" && k !== "transfer-encoding" && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const fwd = trustProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    headers.set("x-client-ip", fwd || req.socket.remoteAddress || "unknown");
    const method = req.method || "GET";
    const init = { method, headers };
    if (method !== "GET" && method !== "HEAD") init.body = tooBig ? "x".repeat(16385) : Buffer.concat(chunks);
    const response = await handle(new Request("http://" + (req.headers.host || "localhost") + req.url, init), process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (_) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  }
});
const HOST = process.env.HOST || ""; /* HOST=127.0.0.1 — слушать только этот компьютер (локальная разработка) */
const onListen = () => console.log("bot listening on " + (HOST || "0.0.0.0") + ":" + PORT + " provider=" + providerName(process.env) + " model=" + (process.env.MODEL || (providerName(process.env) === "gemini" ? "gemini-3.5-flash-lite" : "")));
if (HOST) server.listen(PORT, HOST, onListen); else server.listen(PORT, onListen);
