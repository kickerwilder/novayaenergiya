"""Единый источник наименований товара: data/naming.json (слова вручную пишутся только там).

Модуль подключают build_naming.py, build_seo.py, build_models.py, build_bot_kb.py и add_articles.py.
Чтобы поменять слово (например, «портативная зарядная станция» на «аккумуляторная станция»), правят data/naming.json
и запускают python scripts/build_all.py: всё остальное пересобирается из него.

Подстановки в тексте:
  - «{formal}», «{search_phrase}» и т. д. в scripts/faq.json: fill_tokens();
  - маркеры <!--NM:ключ-->…<!--/NM:ключ--> в index.html и privacy.html: apply_markers().
    Ключ — любой ключ из naming.json (подставляется текст) или вычисляемый (h1_home — заголовок главной).
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAMING_PATH = ROOT / "data" / "naming.json"
REQUIRED = ["formal", "formal_plural", "short", "neutral", "tagline", "catalog_crumb", "search_phrase", "search_phrase_2"]


def load():
    n = json.loads(NAMING_PATH.read_text(encoding="utf-8"))
    missing = [k for k in REQUIRED if not str(n.get(k, "")).strip()]
    if missing:
        raise SystemExit("В data/naming.json нет значений: " + ", ".join(missing))
    return n


def cap_first(s):
    """Первая буква заглавная, остальное без изменений («станция» -> «Станция»)."""
    return s[:1].upper() + s[1:]


def num(n):
    return f"{n:,}".replace(",", " ")


def dec(x):
    s = ("%.1f" % x).replace(".", ",")
    return s[:-2] if s.endswith(",0") else s


def power_cap(power, cap):
    """«2 800 Вт · 3,8 кВт·ч»."""
    return "%s Вт · %s кВт·ч" % (num(power), dec(cap / 1000))


def combo_title(naming, power, cap):
    """Название карточки каталога: «Станция 2 800 Вт · 3,8 кВт·ч»."""
    return "%s %s" % (cap_first(naming["neutral"]), power_cap(power, cap))


def article_groups(combo):
    """[(артикул, [ключи версий])] в порядке D, L; версии с одинаковым артикулом объединяются.

    Артикул берётся из поля article версии как есть (data/catalog.js, scripts/add_articles.py).
    """
    groups = []
    for k in ("D", "L"):
        v = combo["vers"].get(k)
        if not v:
            continue
        art = v.get("article")
        if not art:
            raise SystemExit("У версии %s нет артикула: запустите python scripts/add_articles.py" % v["code"])
        for g in groups:
            if g[0] == art:
                g[1].append(k)
                break
        else:
            groups.append((art, [k]))
    return groups


def product_name(naming, brand, article):
    """name для JSON-LD Product: «Внешний аккумулятор (портативная зарядная станция) НОВАЯ ЭНЕРДЖИ ZF28-2003.8»."""
    return "%s %s %s" % (naming["formal"], brand, article)


def alternate_name(naming, power, cap):
    """alternateName для JSON-LD Product: поисковая формулировка search_phrase из naming.json + «2 800 Вт · 3,8 кВт·ч»."""
    return "%s %s" % (cap_first(naming["search_phrase"]), power_cap(power, cap))


def fill_tokens(text, naming=None):
    """Подставляет {ключ} из naming.json (для scripts/faq.json); {ключ:lower} — с маленькой первой буквой (внутри предложения)."""
    naming = naming or load()

    def repl(m):
        key, mod = m.group(1), m.group(2)
        if key not in naming:
            return m.group(0)
        v = naming[key]
        return v[:1].lower() + v[1:] if mod else v

    return re.sub(r"\{(\w+)(?::(lower))?\}", repl, text)


def computed(key, naming):
    """Вычисляемые фрагменты разметки (HTML). None — ключа нет."""
    if key == "h1_home":
        return "%s на <em>литий-железо-фосфатных</em> батареях" % html.escape(naming["formal_plural"], quote=False)
    return None


_MARK = re.compile(r"(<!--NM:(\w+)-->)(.*?)(<!--/NM:\2-->)", re.S)


def apply_markers(text, naming):
    """Обновляет содержимое между <!--NM:ключ--> и <!--/NM:ключ-->. Возвращает (текст, число маркеров)."""
    count = [0]

    def repl(m):
        key = m.group(2)
        val = computed(key, naming)
        if val is None:
            if key not in naming:
                raise SystemExit("Маркер NM:%s: такого ключа нет в data/naming.json" % key)
            val = html.escape(naming[key], quote=False)
        count[0] += 1
        return m.group(1) + val + m.group(4)

    return _MARK.sub(repl, text), count[0]
