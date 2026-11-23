"use strict";
/* Чтение bot/.env (если файл есть). Уже заданные переменные окружения важнее файла. Значения не печатаются.
   SKIP_DOTENV=1 — файл не читать (тесты и проверки, которым нужно чистое окружение). */
const fs = require("fs");

function loadDotEnv(file) {
  if (String(process.env.SKIP_DOTENV) === "1") return;
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

module.exports = { loadDotEnv };
