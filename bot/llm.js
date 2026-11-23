"use strict";
/* Вызов модели для любого провайдера (PROVIDER=gemini или openai): повтор при 429/5xx, запасная модель, учёт токенов.
   Порядок: основная модель -> (при 429 или 5xx) одна повторная попытка после паузы -> запасная модель FALLBACK_MODEL (с такой же одной
   повторной попыткой) -> ошибка, и ядро отвечает клиенту сообщением с контактами менеджера.
   Пауза перед повтором: Retry-After провайдера, иначе RETRY_PAUSE_MS (по умолчанию 1000 мс); пауза длиннее RETRY_MAX_WAIT_MS (по умолчанию 3000 мс)
   или не укладывающаяся в deadline не ждётся: бот сразу переходит к запасной модели. Один диалог ограничен общим бюджетом TIMEOUT_MS.
   В лог пишутся только вид сбоя, статус, название модели, пауза и счётчики токенов; тексты диалогов, заголовки, ключи и тела ответов провайдера не пишутся. */

const { generate, ProviderError, providerName } = require("./provider.js");

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelsFor(env) {
  const main = String(env.MODEL || "").trim() || (providerName(env) === "gemini" ? DEFAULT_GEMINI_MODEL : "");
  if (!main) throw new ProviderError("config");
  const list = [main];
  const fb = String(env.FALLBACK_MODEL || "").trim();
  if (fb && fb !== main) list.push(fb);
  return list;
}

const sameModelRetry = (e) => e instanceof ProviderError && e.kind === "http" && (e.status === 429 || e.status >= 500);
const nextModelAllowed = (e) => e instanceof ProviderError && e.kind !== "config" && (e.kind !== "http" || e.status === 404 || e.status === 429 || e.status >= 500);

function logUsage(env, model, r, ms) {
  const u = r.usage || {};
  const entry = { provider: providerName(env), model, prompt_tokens: u.prompt_tokens == null ? null : u.prompt_tokens, completion_tokens: u.completion_tokens == null ? null : u.completion_tokens, ms };
  console.log("llm_usage " + JSON.stringify(entry));
  if (typeof env.__onUsage === "function") env.__onUsage(entry);
}

function logProblem(env, event, model, e, extra) {
  console.log(event + " " + JSON.stringify(Object.assign({ model, kind: e.kind, status: e.status || undefined }, extra || {})));
  if (typeof env.__onProviderError === "function") env.__onProviderError({ kind: e.kind, status: e.status });
}

/* args: {system, contents, tools, deadline}; возвращает {content, text, calls, finishReason, usage} или бросает ProviderError */
async function call(env, args) {
  const models = modelsFor(env);
  const pause = env.RETRY_PAUSE_MS !== undefined && env.RETRY_PAUSE_MS !== "" && Number.isFinite(Number(env.RETRY_PAUSE_MS)) ? Number(env.RETRY_PAUSE_MS) : 1000;
  const maxWait = Number(env.RETRY_MAX_WAIT_MS) >= 0 && env.RETRY_MAX_WAIT_MS !== undefined && env.RETRY_MAX_WAIT_MS !== "" ? Number(env.RETRY_MAX_WAIT_MS) : 3000;
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    /* при наличии запасной модели первая получает не весь бюджет времени, чтобы запасная успела ответить */
    const deadline = i === 0 && models.length > 1 ? Math.min(args.deadline, Date.now() + 9000) : args.deadline;
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = Date.now();
      try {
        const r = await generate(env, Object.assign({}, args, { model, deadline }));
        logUsage(env, model, r, Date.now() - t0);
        return r;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof ProviderError)) throw e;
        if (attempt === 0 && sameModelRetry(e)) {
          const wait = e.retryAfterMs != null ? e.retryAfterMs : pause;
          if (wait <= maxWait && Date.now() + wait < deadline - 1500) {
            logProblem(env, "llm_retry", model, e, { wait_ms: wait });
            if (wait > 0) await sleep(wait);
            continue;
          }
        }
        logProblem(env, "llm_fail", model, e);
        break;
      }
    }
    if (!nextModelAllowed(lastErr) || Date.now() > args.deadline - 1500) break;
    if (i + 1 < models.length) console.log("llm_fallback " + JSON.stringify({ from: model, to: models[i + 1] }));
  }
  throw lastErr;
}

module.exports = { call, modelsFor };
