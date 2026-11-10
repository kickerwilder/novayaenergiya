#!/usr/bin/env python3
"""Привязка фото и схем к данным каталога (data/catalog.js). Запуск из корня: python scripts/update_media.py

Запускать после scripts/process_media.py. Повторный запуск безопасен.
  - DATA.scenes заменяется на DATA.photos {D, L}: фото для плиток выбора корпуса;
  - версия L -> img/photo-white.jpg; D-ящик -> img/photo-black.jpg; D-шкаф -> img/photo-cabinet.jpg;
  - схемы портов: D-ящик -> diagram-black-box, D-шкаф -> diagram-black-cabinet,
    L с розетками «2 × 10 А + 2 × 16 А» -> diagram-white-4, L с «3 × 10 А + 2 × 16 А» -> diagram-white-5;
  - dh (высота схемы при ширине 900 px) берётся по пропорции файла;
  - легенда версий L: пункты 6 и 7 заменены, остальные не меняются.
Версия считается «шкафом», если её картинка уже photo-cabinet.jpg или прежняя cut_d_cab.jpg.
"""
import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Не найден Pillow: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "catalog.js"
IMG = ROOT / "img"

L6 = "Порты USB-C (быстрая зарядка PD до 65 Вт)"
L7 = "4 порта USB-A (5 В / 2,4 А)"
BOX = "diagram-black-box.jpg"
CAB = "diagram-black-cabinet.jpg"
W4 = "diagram-white-4.jpg"
W5 = "diagram-white-5.jpg"


def height_for(name, width=900):
    p = IMG / name
    if not p.is_file():
        sys.exit("Нет файла %s: сначала запустите scripts/process_media.py" % p)
    with Image.open(p) as im:
        return round(im.height * width / im.width)


def main():
    text = PATH.read_text(encoding="utf-8")
    data = json.loads(text[text.index("{") : text.rindex("}") + 1])
    assert len(data["combos"]) == 29 and sum(len(c["vers"]) for c in data["combos"]) == 42
    dh = {n: height_for(n) for n in (BOX, CAB, W4, W5)}
    counts = {"box": 0, "cab": 0, "w4": 0, "w5": 0}
    for c in data["combos"]:
        for k, v in c["vers"].items():
            if k == "L":
                v["img"] = "img/photo-white.jpg"
                socks = " + ".join(v["sockets"])
                d = W5 if socks.lstrip().startswith("3 ×") else W4
                counts["w5" if d == W5 else "w4"] += 1
                for g in v["legend"]:
                    if g["n"] == 6:
                        g["ru"] = L6
                    elif g["n"] == 7:
                        g["ru"] = L7
            else:
                cab = v["img"] in ("img/photo-cabinet.jpg", "img/cut_d_cab.jpg")
                v["img"] = "img/photo-cabinet.jpg" if cab else "img/photo-black.jpg"
                d = CAB if cab else BOX
                counts["cab" if cab else "box"] += 1
            v["diagram"] = "img/" + d
            v["dh"] = dh[d]
    assert counts == {"box": 13, "cab": 9, "w4": 9, "w5": 11}, counts
    new = {}
    for key, val in data.items():
        if key == "scenes":
            new["photos"] = {"D": "img/photo-black.jpg", "L": "img/photo-white.jpg"}
        else:
            new[key] = val
    data = new
    for g in data["glossary"]:  # чайник в примере: 2000 Вт, как в списке приборов
        g[1] = g[1].replace("Чайник 1500 Вт + ноутбук 60 Вт = 1560 Вт", "Чайник 2000 Вт + ноутбук 60 Вт = 2060 Вт")

    lines = []
    for k, val in data.items():
        if k == "combos":
            body = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in val)
            lines.append('  "combos": [\n' + body + "\n  ]")
        else:
            lines.append("  " + json.dumps(k) + ": " + json.dumps(val, ensure_ascii=False, separators=(",", ":")))
    out = "/* Каталог: 29 комбинаций, 42 версии. Править только скриптом. */\nconst DATA = {\n" + ",\n".join(lines) + "\n};\n"
    check = json.loads(out[out.index("{") : out.rindex("}") + 1])
    assert check == data
    with open(PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    print("Готово:", counts, "dh:", dh)


if __name__ == "__main__":
    main()
