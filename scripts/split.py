#!/usr/bin/env python3
"""Разносит монолитный index.html по файлам, ничего не меняя в поведении сайта.

Было:  index.html с <style>, двумя <script> (данные и логика).
Стало: index.html (разметка), assets/styles.css, assets/app.js,
       data/catalog.js (const DATA = ...;), data/prices.js (const PRICES = ...;).

Запуск из корня репозитория:  python scripts/split.py
Скрипт одноразовый: если index.html уже разнесён, он остановится и ничего не изменит.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"


def read(path):
    return path.read_text(encoding="utf-8")


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def cut(text, start_pat, end_pat):
    """Возвращает (до, внутри, после) для первого блока start_pat...end_pat."""
    m1 = re.search(start_pat, text)
    if not m1:
        sys.exit("Не найден маркер начала: " + start_pat)
    m2 = re.compile(end_pat).search(text, m1.end())
    if not m2:
        sys.exit("Не найден маркер конца: " + end_pat)
    return text[: m1.start()], text[m1.end() : m2.start()], text[m2.end() :]


def main():
    html = read(INDEX).replace("\r\n", "\n")
    if 'src="assets/app.js"' in html or "<script src=" in html:
        sys.exit("index.html уже разнесён: ничего не делаю.")

    # 1. CSS
    head, css, tail = cut(html, r"<style>\n", r"</style>\n?")
    html = head + '<link rel="stylesheet" href="assets/styles.css">\n' + tail
    # CSS теперь лежит в assets/, пути к шрифтам считаются от него
    css = css.replace("url(fonts/", "url(../fonts/")
    write(ROOT / "assets" / "styles.css", css.rstrip("\n") + "\n")

    # 2. Первый <script>: SETTINGS, PRICES, DATA
    head, data_js, tail = cut(html, r"<script>\n", r"</script>\n?")
    html = head + "@@SCRIPTS@@\n" + tail

    m = re.search(r"(/\* =+ SETTINGS =+ \*/.*?)(/\* =+ PRICES =+)", data_js, re.S)
    settings = m.group(1).rstrip("\n") + "\n"
    m = re.search(r"(/\* =+ PRICES =+.*?\nconst PRICES = \{.*?\n\};)", data_js, re.S)
    prices = m.group(1)
    m = re.search(r"/\* =+ DATA =+ \*/\s*const DATA = (\{.*\});\s*$", data_js, re.S)
    data_raw = m.group(1)

    # DATA: тот же JSON, но по одной комбинации на строку, кириллица без \uXXXX
    data = json.loads(data_raw)
    assert len(data["combos"]) == 29, "ожидалось 29 комбинаций"
    assert sum(len(c["vers"]) for c in data["combos"]) == 42, "ожидалось 42 версии"
    lines = []
    keys = list(data.keys())
    for k in keys:
        if k == "combos":
            body = ",\n".join(
                "    " + json.dumps(c, ensure_ascii=False, separators=(",", ":"))
                for c in data["combos"]
            )
            lines.append('  "combos": [\n' + body + "\n  ]")
        else:
            lines.append(
                "  " + json.dumps(k) + ": " + json.dumps(data[k], ensure_ascii=False, separators=(",", ":"))
            )
    catalog = "/* Каталог: 29 комбинаций, 42 версии. Править только скриптом. */\nconst DATA = {\n" + ",\n".join(lines) + "\n};\n"
    # проверка: данные не изменились
    check = json.loads(catalog[catalog.index("{") : catalog.rindex("}") + 1])
    assert check == data, "DATA изменился при переупаковке"
    write(ROOT / "data" / "catalog.js", catalog)

    prices_js = (
        "/* Цены. Меняются скриптом: python scripts/import_prices.py <файл.csv|файл.xlsx>\n"
        "   \"КОД\": число рублей. 0 = «Цена по запросу».\n"
        "   -D = тёмный корпус, -L = светлый корпус на колёсах. */\n"
        + prices[prices.index("const PRICES") :]
        + "\n"
    )
    write(ROOT / "data" / "prices.js", prices_js)

    # 3. Второй <script>: логика приложения; SETTINGS идёт первым в app.js
    head, logic, tail = cut(html, r"<script>\n", r"</script>\n?")
    html = head + tail
    app = settings + "\n" + logic.strip("\n") + "\n"
    write(ROOT / "assets" / "app.js", app)

    scripts = (
        '<script src="data/catalog.js"></script>\n'
        '<script src="data/prices.js"></script>\n'
        '<script src="assets/app.js"></script>'
    )
    html = html.replace("@@SCRIPTS@@", scripts)
    # подсказка про цены в начале файла устарела
    html = re.sub(r"<!--\s*КАК ПОМЕНЯТЬ ЦЕНУ.*?-->\n", "", html, flags=re.S)
    write(INDEX, html)
    print("Готово: assets/styles.css, assets/app.js, data/catalog.js, data/prices.js, index.html")


if __name__ == "__main__":
    main()
