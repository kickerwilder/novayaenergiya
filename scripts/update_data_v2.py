#!/usr/bin/env python3
"""Обновление data/catalog.js (этап data-v2). Запуск из корня: python scripts/update_data_v2.py

Что делает (повторный запуск безопасен, результат тот же):
  1. «Ресурс батареи» во всех 42 версиях: 2000+ циклов, по паспорту изделия; то же в словаре.
  2. После «Номинальная мощность» добавляет «Пиковая мощность (кратковременно)» (2 × номинала).
  3. Считает maxSocket (предел одной розетки) для каждой версии.
  4. Для светлых версий (L): «Температура при работе» = разряд −20…+60 °C; зарядка 0…+45 °C.
  5. Для 24 В и 48 В: пояснение про гнездо прикуривателя в строке «Выход постоянного тока».
  6. Новый список приборов DATA.loads (watts, avg, start), блок DATA.safety, термины в словаре.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "catalog.js"
NB = "\u00a0"

CYCLES_ROW = "2000+ циклов заряда (после них ёмкость не менее 80 %), по паспорту изделия"
LIM = {10: 2200, 16: 3500}  # предел одной розетки по току, Вт
DC_NOTE = "только для техники на 24/48 В; обычные 12-вольтовые автоприборы не подключать"

# key, название, watts, avg, start (None = нет)
LOADS = [
    ("phone", "Смартфон (полных зарядок)", None, None, None),
    ("router", "Wi-Fi роутер", 12, None, None),
    ("led", "Освещение: 5 LED-ламп", 50, None, None),
    ("laptop", "Ноутбук", 60, None, None),
    ("tv", "Телевизор", 100, None, None),
    ("fridge", "Холодильник", 150, 60, 600),
    ("freezer", "Морозильная камера", 150, 70, 600),
    ("boiler", "Газовый котёл (настенный, двухконтурный)", 150, 100, None),
    ("pump", "Насос (колодец, скважина)", 800, 800, 2400),
    ("split_inv", "Сплит-система инверторная", 900, 450, 1100),
    ("split_std", "Сплит-система обычная (не инверторная)", 1000, 700, 3500),
    ("tool", "Электроинструмент (дрель, перфоратор)", 1000, None, None),
    ("micro", "Микроволновка или кофемашина", 1300, None, None),
    ("kettle", "Электрочайник", 2000, None, None),
    ("heater", "Электрообогреватель", 2000, None, None),
    ("stove", "Электроплита (2 конфорки)", 3000, None, None),
    ("washer", "Стиральная машина", 2000, 800, None),
    ("waterheater", "Бойлер (водонагреватель)", 2000, None, None),
]

SAFETY = ["Станции не защищены от дождя и брызг: используйте в помещении или под навесом."]


def nint(s):
    return int(re.sub(r"\D", "", s))


def fmt_w(n):
    return f"{n:,}".replace(",", " ")


def max_socket(power, sockets):
    best = 0
    for s in sockets:
        m = re.match(r"\s*\d+\s*×\s*(\d+)\s*А\s*\(до\s*([\d\s\u00a0]+)Вт\)", s)
        if not m:
            sys.exit("Не разобрана строка розеток: " + s)
        amp, n = int(m.group(1)), nint(m.group(2))
        best = max(best, min(n, power, LIM[amp]))
    return best


def setrow(rows, label, value, new_label=None):
    for r in rows:
        if r[0] == label or (new_label and r[0] == new_label):
            r[0] = new_label or label
            r[1] = value
            return
    sys.exit("Нет строки: " + label)


def main():
    text = PATH.read_text(encoding="utf-8")
    data = json.loads(text[text.index("{") : text.rindex("}") + 1])
    assert len(data["combos"]) == 29 and sum(len(c["vers"]) for c in data["combos"]) == 42

    for c in data["combos"]:
        for k, v in c["vers"].items():
            rows = v["rows"]
            setrow(rows, "Ресурс батареи", CYCLES_ROW)
            peak = "до " + fmt_w(2 * c["power"]) + " Вт (2× номинала, до 0,3 с, по паспорту изделия)"
            if any(r[0] == "Пиковая мощность (кратковременно)" for r in rows):
                setrow(rows, "Пиковая мощность (кратковременно)", peak)
            else:
                i = next(i for i, r in enumerate(rows) if r[0] == "Номинальная мощность")
                rows.insert(i + 1, ["Пиковая мощность (кратковременно)", peak])
            v["maxSocket"] = max_socket(c["power"], v["sockets"])
            if k == "L":
                setrow(rows, "Температура при работе (разряд)", "разряд −20…+60 °C; зарядка 0…+45 °C",
                       new_label="Температура при работе")
            dc = next(r for r in rows if r[0] == "Выход постоянного тока")
            if re.match(r"(24|48) В", dc[1]) and DC_NOTE not in dc[1]:
                dc[1] = dc[1] + "; " + DC_NOTE

    loads = []
    for key, name, w, avg, start in LOADS:
        d = {"key": key, "name": name, "watts": w}
        if avg is not None:
            d["avg"] = avg
        if start is not None:
            d["start"] = start
        loads.append(d)
    data["loads"] = loads
    data["safety"] = SAFETY

    gl = [g for g in data["glossary"] if not g[0].startswith(("Пиковая", "Пусковая"))]
    for g in gl:
        if g[0] == "Цикл заряда":
            g[1] = "Одна полная зарядка и разрядка. «2000+ циклов» означает, что после 2000 циклов у батареи останется не менее 80 % ёмкости (по паспорту изделия)."
    for g in gl:
        if g[0] == "Прикуриватель" and DC_NOTE not in g[1]:
            g[1] = g[1] + " У моделей 24 и 48 В: " + DC_NOTE + "."
        if g[0] == "Розетки 10 А и 16 А":
            g[1] = g[1].replace("16 А ≈ до 3,7 кВт", "16 А ≈ до 3,5 кВт")
    i = next(i for i, g in enumerate(gl) if g[0] == "Номинальная мощность") + 1
    gl.insert(i, ["Пиковая и пусковая мощность",
                  "Пик — это мощность, которую станция отдаёт кратковременно (до 0,3 с): у этих станций она вдвое больше номинальной (по паспорту изделия). Пусковая — это краткий скачок потребления при включении двигателя (холодильник, насос, кондиционер). Пусковая нагрузка прибора не должна быть больше пика станции."])
    data["glossary"] = gl

    lines = []
    for k, val in data.items():
        if k == "combos":
            body = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in val)
            lines.append('  "combos": [\n' + body + "\n  ]")
        else:
            lines.append("  " + json.dumps(k) + ": " + json.dumps(val, ensure_ascii=False, separators=(",", ":")))
    out = "/* Каталог: 29 комбинаций, 42 версии. Править только скриптом. */\nconst DATA = {\n" + ",\n".join(lines) + "\n};\n"
    check = json.loads(out[out.index("{") : out.rindex("}") + 1])
    assert check == data and len(check["loads"]) == 18
    with open(PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    ms = sorted({v["maxSocket"] for c in data["combos"] for v in c["vers"].values()})
    print("Готово: 42 версии, нагрузок:", len(loads), "значения maxSocket:", ms)


if __name__ == "__main__":
    main()
