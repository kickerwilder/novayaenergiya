#!/usr/bin/env python3
"""Ориентировочное время зарядки для версий без точных данных: data/charge.js. Запуск из корня: python scripts/update_charge_estimates.py

Временные данные до ответа производителя. Идемпотентный: повторный запуск ничего не меняет.
  - записи basis "passport" (подтверждены) и "estimate" (отдельный расчёт при 3500 Вт) НЕ трогаются;
  - для всех остальных версий пишется basis "range" с диапазоном часов:
      мощность зарядки от сети P = k·E (E — ёмкость, Вт·ч), k от 0,14 до 0,23 (разброс по трём паспортам), P не выше 3500 Вт;
      t80 = 0,8·E/(P·0,9), t100 = 1,2·E/(P·0,9);
      диапазон: lo — от большой P (минимум времени), hi — от малой P (максимум); округление до 0,5 ч.
Когда владелец получит точные данные, он заменяет запись версии на {"acW": ..., "basis": "passport"}, и время считается как для подтверждённых.
"""
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHARGE = ROOT / "data" / "charge.js"
K_LO, K_HI, P_MAX = 0.14, 0.23, 3500


def read(p):
    return Path(p).read_text(encoding="utf-8")


def parse_charge(text):
    i = text.index("const CHARGE = ")
    return json.loads(text[text.index("{", i): text.rindex("}") + 1])


def r05(x):
    return math.floor(x * 2 + 0.5) / 2


def estimate(cap):
    p_hi = min(K_HI * cap, P_MAX)  # большая мощность зарядки -> меньше времени
    p_lo = min(K_LO * cap, P_MAX)
    t = lambda coef, p: coef * cap / (p * 0.9)
    return {
        "basis": "range",
        "t80": {"lo": r05(t(0.8, p_hi)), "hi": r05(t(0.8, p_lo))},
        "t100": {"lo": r05(t(1.2, p_hi)), "hi": r05(t(1.2, p_lo))},
    }


def main():
    s = read(ROOT / "data" / "catalog.js")
    data = json.loads(s[s.index("{"): s.rindex("}") + 1])
    old_text = read(CHARGE)
    old = parse_charge(old_text)
    out, kept, added = {}, 0, 0
    for c in data["combos"]:
        for k in ("D", "L"):
            v = c["vers"].get(k)
            if not v:
                continue
            code = v["code"]
            cur = old.get(code)
            if cur and cur.get("basis") in ("passport", "estimate"):
                out[code] = cur
                kept += 1
            else:
                out[code] = estimate(c["cap"])
                added += 1
    lines = ",\n".join("  %s: %s" % (json.dumps(k), json.dumps(v, ensure_ascii=False, separators=(", ", ": "))) for k, v in out.items())
    text = (
        "/* Зарядка от розетки 220 В (комплектное зарядное). Ключ: код версии. Править только скриптом scripts/update_charge_estimates.py\n"
        "   basis \"passport\": подтверждено, acW — мощность зарядного устройства, Вт; время считается по формуле.\n"
        "   basis \"estimate\": отдельный ориентировочный расчёт по acW.\n"
        "   basis \"range\": ориентировочный диапазон по аналогичным моделям (временные данные до ответа производителя):\n"
        "   t80 и t100 — диапазоны часов {lo, hi}. Когда придут точные данные, замените запись на {\"acW\": ..., \"basis\": \"passport\"}. */\n"
        "const CHARGE = {\n" + lines + "\n};\n"
    )
    changed = old_text.replace("\r\n", "\n") != text
    if changed:
        with open(CHARGE, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    parse_charge(text)
    print("charge.js: версий %d (подтверждено и расчётов сохранено %d, диапазонов %d); %s" % (len(out), kept, added, "обновлён" if changed else "без изменений"))


if __name__ == "__main__":
    main()
