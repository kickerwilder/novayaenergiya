"use strict";
/* Загрузка базы знаний data/kb.json. KB_URL: адрес на сайте (кэш 5 минут: обновление цен не требует передеплоя бота)
   или путь к файлу. Если KB_URL не задан и есть файловая система, читается ../data/kb.json (локальная разработка). */

const TTL_MS = 5 * 60 * 1000;
let cache = { key: null, at: 0, data: null };

async function loadKb(env) {
  const url = env.KB_URL || "";
  const key = url || "local";
  const now = Date.now();
  if (/^https?:\/\//i.test(url)) {
    if (cache.data && cache.key === key && now - cache.at < TTL_MS) return cache.data;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error("kb http " + r.status);
      const data = await r.json();
      cache = { key, at: now, data };
      return data;
    } catch (e) {
      if (cache.data && cache.key === key) return cache.data; /* временный сбой: работаем со старой копией */
      throw e;
    }
  }
  const fs = require("fs"), path = require("path");
  const file = url ? path.resolve(url) : path.join(__dirname, "..", "data", "kb.json");
  const mtime = fs.statSync(file).mtimeMs;
  if (cache.data && cache.key === file && cache.at === mtime) return cache.data;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  cache = { key: file, at: mtime, data };
  return data;
}

module.exports = { loadKb };
