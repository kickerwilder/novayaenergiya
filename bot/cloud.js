"use strict";
/* Тонкая обёртка под облачную функцию (Яндекс Облако Cloud Functions, HTTP-вызов). Ядро то же самое: core.handle.
   Экспортирует handler(event, context). Переменные окружения функции задаются в консоли облака (ключ — как секрет). */
const { handle } = require("./core.js");

exports.handler = async function (event) {
  const headers = new Headers();
  Object.entries(event.headers || {}).forEach(([k, v]) => { if (k.toLowerCase() !== "x-client-ip") headers.set(k, String(v)); });
  const ip = (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) || "unknown";
  headers.set("x-client-ip", ip);
  const method = (event.httpMethod || "GET").toUpperCase();
  const qs = event.queryStringParameters ? "?" + new URLSearchParams(event.queryStringParameters).toString() : "";
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body) : undefined;
  const response = await handle(
    new Request("https://function.local" + (event.path || "/") + qs, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body }),
    process.env
  );
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), isBase64Encoded: false };
};
