#!/usr/bin/env python3
"""Наименования товара из data/naming.json. Запуск из корня: python scripts/build_naming.py (также из build_all.py).

Идемпотентный, без внешних зависимостей. Что делает:
  1. data/naming.js (const NAMING = {...}) для браузера; подключается в index.html до assets/app.js.
  2. Поле title у 29 комбинаций в data/catalog.js: «Станция 2 800 Вт · 3,8 кВт·ч» (слово берётся из naming.json, числа не меняются).
  3. Маркеры <!--NM:ключ-->…<!--/NM:ключ--> в index.html и privacy.html (заголовок главной, подпись под названием в шапке).

Слова пишутся только в data/naming.json. Другие скрипты (build_seo, build_models, build_bot_kb) читают его через scripts/naming.py.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import catalog_io  # noqa: E402
import naming as nm  # noqa: E402

ROOT = nm.ROOT
JS_PATH = ROOT / "data" / "naming.js"
HTML_FILES = ["index.html", "privacy.html"]


def write_if_changed(path, text):
    old = path.read_text(encoding="utf-8").replace("\r\n", "\n") if path.exists() else None
    if old == text:
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def main():
    naming = nm.load()
    changed = []

    js = ("/* Наименования товара. Генерируется scripts/build_naming.py из data/naming.json, вручную не править. */\n"
          "const NAMING = " + json.dumps(naming, ensure_ascii=False, indent=2) + ";\n")
    changed.append(write_if_changed(JS_PATH, js))

    data = catalog_io.load()
    assert len(data["combos"]) == 29
    retitled = 0
    for c in data["combos"]:
        new = nm.combo_title(naming, c["power"], c["cap"])
        old = c.get("title", "")
        # числа в названии должны совпадать с прежними: меняется только слово
        if old and old.split(" ", 1)[-1] != new.split(" ", 1)[-1]:
            sys.exit("Название %s: числа не совпали (%r -> %r), остановка" % (c["id"], old, new))
        if old != new:
            c["title"] = new
            retitled += 1
    changed.append(catalog_io.save(data))

    markers = 0
    for name in HTML_FILES:
        p = ROOT / name
        text = p.read_text(encoding="utf-8").replace("\r\n", "\n")
        new, n = nm.apply_markers(text, naming)
        markers += n
        changed.append(write_if_changed(p, new))

    print("naming: «%s»; названий в каталоге обновлено: %d из %d; маркеров в HTML: %d; изменено файлов: %d" % (
        naming["formal"], retitled, len(data["combos"]), markers, sum(changed)))


if __name__ == "__main__":
    main()
