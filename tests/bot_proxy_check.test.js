"use strict";
/* Тесты bot/proxy_check.js на локальных поддельных прокси, без сети: node tests/bot_proxy_check.test.js
   Скрипт печатает только схему прокси (http или socks5) и итог по каждому адресу; логина, пароля, хоста и порта прокси в выводе нет. */
const path = require("path");
const http = require("http");
const net = require("net");
const assert = require("assert");
const { spawn } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "bot", "proxy_check.js");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e.message).split("\n")[0]); }
}

function run(env, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT].concat(args || []), { env: Object.assign({ PATH: process.env.PATH, SKIP_DOTENV: "1" }, env) });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), 60000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, all: out + err }); });
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

/* настоящий HTTP-прокси: CONNECT и обычные запросы пробрасываются на целевой сервер; запоминает заголовок авторизации */
function forwardProxy(seen) {
  const srv = http.createServer((req, res) => {
    seen.auth = req.headers["proxy-authorization"];
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: { host: u.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    req.pipe(up);
  });
  srv.on("connect", (req, sock, head) => {
    seen.auth = req.headers["proxy-authorization"];
    const [h, p] = req.url.split(":");
    const up = net.connect(Number(p), h, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  });
  return srv;
}

(async () => {
  const target = http.createServer((req, res) => { res.writeHead(302, { location: "/x" }); res.end(); });
  const targetPort = await listen(target);
  const T = "http://127.0.0.1:" + targetPort + "/";

  await test("HTTP-прокси с логином и паролем (со спецсимволами): печатает схему http и итог по адресу, секретов и адреса прокси нет", async () => {
    const seen = {}; const proxy = forwardProxy(seen); const pp = await listen(proxy);
    try {
      const r = await run({ PROXY_URL: "http://us%40er:pa%3Ass%2Fw@127.0.0.1:" + pp, PROXY_CHECK_TARGETS: T });
      assert.strictEqual(r.code, 0, r.all);
      const lines = r.out.trim().split("\n");
      assert.deepStrictEqual(lines.slice(0, 2), ["Прокси: схема http", "127.0.0.1:" + targetPort + ": ответ HTTP 302, " + lines[1].match(/(\d+) мс/)[1] + " мс"]);
      assert.strictEqual(lines[2], "Итог: все адреса отвечают через прокси");
      assert.strictEqual(lines.length, 3, "лишний вывод: " + r.out);
      for (const s of ["us@er", "us%40er", "pa:ss/w", "pa%3Ass%2Fw", String(pp)]) assert.ok(!r.all.includes(s), "в выводе: " + s);
      assert.ok(seen.auth && Buffer.from(seen.auth.replace(/^Basic /, ""), "base64").toString() === "us@er:pa:ss/w", "прокси должен получить логин и пароль в раскодированном виде: " + seen.auth);
    } finally { proxy.close(); }
  });

  await test("прокси отвечает отказом на CONNECT: «нет ответа», код 1, без секретов и адреса прокси", async () => {
    const proxy = http.createServer(); proxy.on("connect", (req, sock) => { sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); });
    const pp = await listen(proxy);
    try {
      const r = await run({ PROXY_URL: "http://secretlogin:secretpass@127.0.0.1:" + pp, PROXY_CHECK_TARGETS: "https://api.telegram.org/,https://generativelanguage.googleapis.com/" });
      assert.strictEqual(r.code, 1, r.all);
      assert.ok(/^Прокси: схема http$/m.test(r.out) && /^api\.telegram\.org: нет ответа, /m.test(r.out) && /^generativelanguage\.googleapis\.com: нет ответа, /m.test(r.out), r.out);
      assert.ok(/Итог: 2 из 2 адресов не отвечают через прокси/.test(r.out), r.out);
      for (const s of ["secretlogin", "secretpass", "127.0.0.1", String(pp)]) assert.ok(!r.all.includes(s), "в выводе: " + s);
    } finally { proxy.close(); }
  });

  await test("SOCKS5-прокси (недоступный): схема socks5, итог по каждому адресу, без секретов и адреса", async () => {
    const socks = net.createServer((s) => s.destroy()); const sp = await listen(socks);
    try {
      const r = await run({ PROXY_URL: "socks5://sl:sp@127.0.0.1:" + sp, PROXY_CHECK_TARGETS: "https://api.telegram.org/,https://generativelanguage.googleapis.com/" });
      assert.strictEqual(r.code, 1, r.all);
      assert.ok(/^Прокси: схема socks5$/m.test(r.out) && /^api\.telegram\.org: нет ответа, /m.test(r.out) && /^generativelanguage\.googleapis\.com: нет ответа, /m.test(r.out), r.out);
      for (const s of ["sl:sp", "127.0.0.1", String(sp)]) assert.ok(!r.all.includes(s), "в выводе: " + s);
    } finally { socks.close(); }
  });

  await test("порт прокси закрыт: нет ответа, код 1; адреса по умолчанию Telegram и Gemini названы, адрес прокси нет", async () => {
    const free = net.createServer(); const fp = await listen(free); await new Promise((r) => free.close(r));
    const r = await run({ PROXY_URL: "http://login:pass@127.0.0.1:" + fp });
    assert.strictEqual(r.code, 1, r.all);
    assert.ok(/^api\.telegram\.org: нет ответа, /m.test(r.out) && /^generativelanguage\.googleapis\.com: нет ответа, /m.test(r.out), r.out);
    for (const s of ["login", "pass", "127.0.0.1", String(fp)]) assert.ok(!r.all.includes(s), "в выводе: " + s);
  });

  await test("некорректный адрес прокси и пустой PROXY_URL: понятное сообщение, код 2, значение не печатается", async () => {
    const r1 = await run({ PROXY_URL: "не адрес с паролем p@ss" });
    assert.strictEqual(r1.code, 2); assert.ok(/некорректный адрес/.test(r1.out) && !r1.all.includes("p@ss"), r1.all);
    const r2 = await run({});
    assert.strictEqual(r2.code, 2); assert.ok(/нет PROXY_URL/.test(r2.out), r2.all);
  });

  await test("--gemini без ключа: сообщение без значений, адрес и схема по-прежнему только схема", async () => {
    const seen = {}; const proxy = forwardProxy(seen); const pp = await listen(proxy);
    try {
      const r = await run({ PROXY_URL: "http://l:p@127.0.0.1:" + pp, PROXY_CHECK_TARGETS: T }, ["--gemini"]);
      assert.ok(/Gemini: в bot\/\.env нет PROVIDER_API_KEY/.test(r.out) && !r.all.includes(String(pp)), r.all);
    } finally { proxy.close(); }
  });

  target.close();
  console.log("\nитого: ok " + passed + ", ошибок " + failed);
  process.exit(failed ? 1 : 0);
})();
