"use strict";
/* Telegram: уведомление менеджеру о передаче обращения (handoff).
   Только sendMessage (отправка) и getUpdates (опрос, см. tg_chat_id.js). Вебхук НЕ используется: сервер в Москве, Telegram напрямую недоступен.
   Все запросы идут через PROXY_URL (SOCKS5 или HTTP), если он задан; без PROXY_URL — напрямую.
   Токен и chat id берутся из env (TELEGRAM_BOT_TOKEN, TELEGRAM_MANAGER_CHAT_ID) и нигде не печатаются; в лог пишется только вид сбоя. */

const { transport } = require("./provider.js");

const API = "https://api.telegram.org";
const MSK = "Europe/Moscow";

/* Один вызов Bot API. Для тестов без сети: env.__telegram(method, payload) подменяет отправку (в process.env функции быть не может). */
async function tgCall(env, method, payload, timeoutMs) {
  if (typeof env.__telegram === "function") return env.__telegram(method, payload);
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("no_token");
  const t = transport(env);
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(timeoutMs || 8000) };
  if (t.dispatcher) init.dispatcher = t.dispatcher;
  const r = await t.fetch(API + "/bot" + token + "/" + method, init);
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.ok !== true) { const e = new Error("tg_http"); e.status = r.status; throw e; }
  return data;
}

function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function mskTime(d) {
  const p = new Intl.DateTimeFormat("ru-RU", { timeZone: MSK, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return p.replace(",", "") + " (МСК)";
}

/* Текст уведомления: краткая суть (уже замаскированные тексты клиента) и время; без ссылки на диалог и без контактов клиента */
function buildNotice(question, context, now) {
  const lines = ["Передача менеджеру (чат на сайте)", "Вопрос: «" + clip(question, 300) + "»"];
  if (context) lines.push("Перед этим клиент спрашивал: «" + clip(context, 200) + "»");
  lines.push("Время: " + mskTime(now || new Date()));
  return lines.join("\n");
}

/* Не бросает исключений: сбой уведомления не должен ломать ответ клиенту. Возвращает {sent, skipped?, error?}. */
async function notifyManager(env, question, context) {
  const chatId = env.TELEGRAM_MANAGER_CHAT_ID;
  const enabled = typeof env.__telegram === "function" || (env.TELEGRAM_BOT_TOKEN && chatId);
  if (!enabled) return { sent: false, skipped: true };
  try {
    await tgCall(env, "sendMessage", { chat_id: chatId, text: buildNotice(question, context), disable_web_page_preview: true });
    return { sent: true };
  } catch (e) {
    const kind = e && e.status ? "http " + e.status : (e && e.name === "TimeoutError" ? "timeout" : "network");
    console.error("tg_error: " + kind);
    return { sent: false, error: kind };
  }
}

module.exports = { tgCall, buildNotice, notifyManager };
