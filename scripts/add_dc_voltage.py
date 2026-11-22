#!/usr/bin/env python3
"""Напряжение постоянного тока версий (поле dcV, В) в data/catalog.js. Запуск из корня: python scripts/add_dc_voltage.py (также из build_all.py).

Идемпотентный. Источник один: data/source/station_specs.json (specs.dc_voltage_v каждой версии, руками не править). Карточка каталога
(assets/app.js) по dcV решает, что писать про зарядку от автомобиля: 12 В — через разъём XT90, 24 и 48 В — подскажет менеджер.
Если версия из каталога не найдена в таблице или наоборот, скрипт останавливается и ничего не пишет.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog_io  # noqa: E402

SRC = Path(__file__).resolve().parent.parent / "data" / "source" / "station_specs.json"


def main():
    src = json.loads(SRC.read_text(encoding="utf-8"))["stations"]
    data = catalog_io.load()
    codes = {v["code"] for c in data["combos"] for v in c["vers"].values()}
    if codes != set(src):
        sys.exit("station_specs.json и каталог расходятся: нет в таблице %s; лишние в таблице %s" % (sorted(codes - set(src)), sorted(set(src) - codes)))
    for c in data["combos"]:
        for k, v in list(c["vers"].items()):
            volt = src[v["code"]]["dc_voltage_v"]
            if not isinstance(volt, int):
                sys.exit("%s: dc_voltage_v не целое число: %r" % (v["code"], volt))
            if "dcV" in v:
                v["dcV"] = volt
            else:  # поле ставим сразу после article (или code), остальные поля не трогаем
                after = "article" if "article" in v else "code"
                new = {}
                for kk, vv in v.items():
                    new[kk] = vv
                    if kk == after:
                        new["dcV"] = volt
                c["vers"][k] = new
    changed = catalog_io.save(data)
    from collections import Counter
    cnt = Counter(v["dcV"] for c in data["combos"] for v in c["vers"].values())
    print("dcV: %s; %s" % (", ".join("%d В: %d" % (a, b) for a, b in sorted(cnt.items())), "каталог обновлён" if changed else "без изменений"))


if __name__ == "__main__":
    main()
