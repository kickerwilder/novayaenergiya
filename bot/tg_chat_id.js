"use strict";
/* Узнать chat id менеджера для TELEGRAM_MANAGER_CHAT_ID. Запуск: node tg_chat_id.js
   1. Менеджер открывает бота в Telegram и пишет ему любое сообщение (например, /start).
   2. Запустите скрипт: он опрашивает getUpdates (long polling, вебхук не нужен и не должен быть включён) через PROXY_URL
      и печатает id, тип и название чатов, из которых были сообщения. Тексты сообщений не выводятся.
   Токен и прокси читаются из bot/.env и нигде не печатаются. */
const fs = require("fs");
const path = require("path");
const { tgCall } = require("./telegram.js");

function loadEnv(file) {
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
loadEnv(path.join(__dirname, ".env"));

(async () => {
  if (!process.env.TELEGRAM_BOT_TOKEN) { console.log("В bot/.env нет TELEGRAM_BOT_TOKEN"); process.exit(2); }
  try {
    const r = await tgCall(process.env, "getUpdates", { timeout: 15, allowed_updates: ["message", "channel_post"] }, 25000);
    const chats = new Map();
    for (const u of r.result || []) {
      const m = u.message || u.channel_post;
      if (m && m.chat) chats.set(m.chat.id, m.chat.type + " " + (m.chat.title || m.chat.username || m.chat.first_name || ""));
    }
    if (!chats.size) { console.log("Сообщений нет: напишите боту в Telegram и запустите скрипт снова."); return; }
    for (const [id, name] of chats) console.log("chat id " + id + "  (" + name.trim() + ")");
  } catch (e) {
    console.log("Не удалось выполнить getUpdates: " + (e && e.status ? "http " + e.status : (e && e.name === "TimeoutError" ? "таймаут" : "нет связи")) + ". Проверьте токен, PROXY_URL и что вебхук не включён.");
    process.exit(1);
  }
})();
