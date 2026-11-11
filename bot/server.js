"use strict";
/* Локальный запуск и запуск на VPS: node server.js
   Читает bot/.env (если файл есть; уже заданные переменные окружения важнее файла). Секреты не печатаются. */
const fs = require("fs");
const path = require("path");
const http = require("http");

function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8").replace(/^﻿/, ""); } catch (_) { return; }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line[0] === "#" || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) v = v.slice(1, -1);
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv(path.join(__dirname, ".env"));

const { handle } = require("./core.js");
const PORT = Number(process.env.PORT) || 8787;
const trustProxy = String(process.env.TRUST_PROXY) === "1"; /* за nginx/балансировщиком: брать IP из X-Forwarded-For */

const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; let size = 0, tooBig = false;
    for await (const c of req) { size += c.length; if (size > 16384) { tooBig = true; break; } chunks.push(c); }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (k !== "x-client-ip" && v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
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
server.listen(PORT, () => console.log("bot listening on :" + PORT + " model=" + (process.env.MODEL || "gemini-3.5-flash-lite")));
