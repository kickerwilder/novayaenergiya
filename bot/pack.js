"use strict";
/* Собирает папку bot/dist для выгрузки на сервер или в облачную функцию: файлы бота + assets/calc.js. Секреты (.env) не копируются. */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(__dirname, "dist");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
["core.js", "provider.js", "tools.js", "kb.js", "server.js", "cloud.js", "prompt.md", "package.json", "example.env"].forEach((f) => fs.copyFileSync(path.join(__dirname, f), path.join(out, f)));
fs.copyFileSync(path.join(root, "assets", "calc.js"), path.join(out, "calc.js"));
console.log("Готово: " + out + " (без .env). Дальше: npm install --omit=dev в этой папке и свой .env рядом.");
