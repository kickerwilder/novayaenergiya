"use strict";
/* Адаптер OpenAI-совместимого API (chat/completions). Подключается из provider.js при PROVIDER=openai.
   Тот же вход и выход, что у адаптера Gemini: generate(env, {model, system, contents, tools, deadline}) -> {content, text, calls, finishReason, usage}.
   Нейтральный формат ядра (contents: {role: "user"|"model", parts: [{text} | {functionCall} | {functionResponse}]}) переводится в messages
   (system, user, assistant с tool_calls и id, tool с tool_call_id) и обратно, в том числе при нескольких вызовах инструментов за один ход.
   Адрес (PROVIDER_BASE_URL), ключ и название модели берутся из личного кабинета провайдера и в коде не зашиты.
   Тела ответов провайдера и заголовки в лог не попадают. */

const { ProviderError, llmTransport, extraFrom, mergeExtra, mergeHeaders, parseRetryAfter } = require("./provider.js");

function textOf(parts) {
  return (parts || []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
}

/* история ядра -> messages. id вызова берётся из functionCall.id (его проставляет сам адаптер при разборе ответа), иначе создаётся call_N;
   ответ инструмента связывается с вызовом по id, а если его нет, то по имени и порядку. */
function toMessages(system, contents) {
  const messages = [{ role: "system", content: String(system || "") }];
  let seq = 0, open = []; /* open: вызовы последнего сообщения ассистента, ответа на которые ещё нет: [{id, name}] */
  for (const c of contents || []) {
    const parts = c.parts || [];
    if (c.role === "model") {
      const calls = parts.filter((p) => p.functionCall);
      const text = textOf(parts);
      const m = { role: "assistant", content: text || (calls.length ? null : "") };
      open = [];
      if (calls.length) {
        m.tool_calls = calls.map((p) => {
          const id = p.functionCall.id || "call_" + ++seq;
          open.push({ id, name: p.functionCall.name });
          return { id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } };
        });
      }
      messages.push(m);
    } else {
      for (const p of parts.filter((x) => x.functionResponse)) {
        const fr = p.functionResponse;
        let i = fr.id ? open.findIndex((o) => o.id === fr.id) : open.findIndex((o) => o.name === fr.name);
        if (i < 0 && open.length) i = 0;
        const id = fr.id || (i >= 0 ? open[i].id : "call_" + ++seq);
        if (i >= 0) open.splice(i, 1);
        messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(fr.response === undefined ? {} : fr.response) });
      }
      const text = textOf(parts);
      if (text) messages.push({ role: "user", content: text });
    }
  }
  return messages;
}

/* нейтральные описания инструментов (JSON Schema) -> tools для chat/completions */
function toTools(tools) {
  return (tools || []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} } } }));
}

/* arguments вызова инструмента: строка JSON, пустая строка или null (как {}), уже готовый объект. Невалидный JSON или не объект — сбой bad_args:
   адаптер не угадывает аргументы, ядро получает ProviderError и llm.js переходит к запасной модели (бот не падает). */
function parseArgs(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") {
    if (Array.isArray(raw)) throw new ProviderError("bad_args");
    return raw;
  }
  const s = String(raw).trim();
  if (!s) return {};
  let v;
  try { v = JSON.parse(s); } catch (_) { throw new ProviderError("bad_args"); }
  if (v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ProviderError("bad_args");
  return v;
}

/* Текст ответа: строка или массив частей. Рассуждения модели в клиентский текст не попадают: блоки <think>…</think> (и <thinking>) вырезаются,
   в том числе оборванный блок без закрывающего тега (ответ обрезан по длине) и «хвост рассуждений» перед одиноким </think>.
   Поля reasoning_content и reasoning сообщения не читаются вообще: ни в историю, ни в лог они не попадают. */
function messageText(content) {
  let t = "";
  if (typeof content === "string") t = content;
  else if (Array.isArray(content)) t = content.map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : "")).join("");
  t = t.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "");
  t = t.replace(/<(think|thinking)>[\s\S]*$/i, "");
  const close = /<\/(think|thinking)>/gi;
  let last = null, m;
  while ((m = close.exec(t))) last = m;
  if (last) t = t.slice(last.index + last[0].length);
  return t.trim();
}

const FINISH = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };
const count = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/* ответ провайдера -> {content, text, calls, finishReason, usage}.
   Вызов инструмента определяется по наличию tool_calls, а не по finish_reason (провайдеры ставят там stop, tool_calls или что угодно).
   Пустой текст без вызовов: при finish_reason=length это сбой length (ответ съело рассуждение или лимит MAX_OUTPUT_TOKENS), иначе empty. */
function fromResponse(data) {
  const ch = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = ch && ch.message;
  if (!msg || typeof msg !== "object") throw new ProviderError("empty", 0);
  let seq = 0;
  const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
    .filter((c) => c && c.function && c.function.name)
    .map((c) => ({ name: c.function.name, args: parseArgs(c.function.arguments), id: c.id || "call_" + ++seq }));
  const text = messageText(msg.content);
  const fin = String(ch.finish_reason || "");
  if (!calls.length && !text) throw new ProviderError(fin === "length" ? "length" : "empty", 0);
  const parts = [];
  if (text) parts.push({ text });
  calls.forEach((c) => parts.push({ functionCall: { name: c.name, args: c.args, id: c.id } }));
  const u = data && data.usage && typeof data.usage === "object" ? data.usage : {};
  return {
    content: { role: "model", parts },
    text: calls.length ? "" : text,
    calls,
    finishReason: FINISH[fin] || fin.toUpperCase(),
    usage: { prompt_tokens: count(u.prompt_tokens), completion_tokens: count(u.completion_tokens) },
  };
}

async function generate(env, { model, system, contents, tools, deadline }) {
  const key = env.PROVIDER_API_KEY;
  if (!key) throw new ProviderError("no_key");
  const base = String(env.PROVIDER_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!base || !model) throw new ProviderError("config");
  const url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
  const extraBody = extraFrom(env, "PROVIDER_EXTRA_BODY"), extraHeaders = extraFrom(env, "PROVIDER_EXTRA_HEADERS");
  const t = llmTransport(env);

  const body = { model, messages: toMessages(system, contents), temperature: 0.3, max_tokens: Number(env.MAX_OUTPUT_TOKENS) || 600 };
  if (tools && tools.length) { body.tools = toTools(tools); body.tool_choice = "auto"; }
  if (extraBody) mergeExtra(body, extraBody);

  const left = Math.max(1000, deadline - Date.now());
  let res;
  try {
    res = await t.fetch(url, {
      method: "POST",
      headers: mergeHeaders({ "content-type": "application/json", authorization: "Bearer " + key }, extraHeaders),
      body: JSON.stringify(body),
      dispatcher: t.dispatcher,
      signal: AbortSignal.timeout(left),
    });
  } catch (e) {
    throw new ProviderError(e && e.name === "TimeoutError" ? "timeout" : "network");
  }
  let raw;
  try { raw = await res.text(); } catch (e) { throw new ProviderError(e && e.name === "TimeoutError" ? "timeout" : "network"); }
  if (!res.ok) throw new ProviderError("http", res.status, parseRetryAfter(res.headers.get("retry-after")));
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new ProviderError("bad_json"); }
  return fromResponse(data);
}

module.exports = { generate, toMessages, toTools, fromResponse };
