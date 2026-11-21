"""Чтение и запись data/catalog.js одним и тем же форматом (как в update_data_v2.py): минимальные диффы.

Правила проекта: data/catalog.js правят только скриптами. Скрипты берут load() и save() отсюда.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "catalog.js"
HEADER = "/* Каталог: 29 комбинаций, 42 версии. Править только скриптом. */\nconst DATA = {\n"


def load():
    text = PATH.read_text(encoding="utf-8")
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def dumps(data):
    lines = []
    for k, val in data.items():
        if k == "combos":
            body = ",\n".join("    " + json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in val)
            lines.append('  "combos": [\n' + body + "\n  ]")
        else:
            lines.append("  " + json.dumps(k) + ": " + json.dumps(val, ensure_ascii=False, separators=(",", ":")))
    out = HEADER + ",\n".join(lines) + "\n};\n"
    assert json.loads(out[out.index("{"): out.rindex("}") + 1]) == data
    return out


def save(data):
    """Пишет файл, только если содержимое изменилось. Возвращает True, если файл обновлён."""
    out = dumps(data)
    old = PATH.read_text(encoding="utf-8").replace("\r\n", "\n") if PATH.exists() else None
    if old == out:
        return False
    with open(PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    return True
