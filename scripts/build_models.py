#!/usr/bin/env python3
"""Генератор 29 детальных SEO-страниц моделей в models/z{power}-{cap}.html.
Запуск из корня: python scripts/build_models.py (также вызывается из build_all.py).
"""
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analytics  # noqa: E402
import site_shell as SH  # noqa: E402
import product_types as PT  # noqa: E402
import naming as nm  # noqa: E402

NAMING = nm.load()  # единственный источник наименований товара: data/naming.json
SEO = analytics.load()  # коды верификации и счётчик Метрики (scripts/seo.json): на страницах моделей только счётчик, если он задан

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)

SITE_URL = "https://novaya-energy.ru/"
SITE_NAME, PHONE, PHONE_TEXT, EMAIL = SH.SITE_NAME, SH.PHONE, SH.PHONE_TEXT, SH.EMAIL   # общая оболочка страниц: scripts/site_shell.py
FOOT_NOTE = "    <p>Время работы — расчётная оценка: ёмкость × 0,85 ÷ средняя мощность приборов. Доставка в Россию: около 25 дней.</p>\n"


def read(p):
    return Path(p).read_text(encoding="utf-8")


def esc(s):
    return html.escape(str(s), quote=True)


def num(n):
    return f"{n:,}".replace(",", " ")


def dec(x):
    s = ("%.1f" % x).replace(".", ",")
    return s[:-2] if s.endswith(",0") else s


def load_data():
    s = read(ROOT / "data" / "catalog.js")
    data = json.loads(s[s.index("{"): s.rindex("}") + 1])
    p = read(ROOT / "data" / "prices.js")
    prices = {k: int(v) for k, v in re.findall(r'"(Z[\w-]+)"\s*:\s*(\d+)', p)}
    t = read(ROOT / "data" / "charge.js")
    i = t.index("const CHARGE = ")
    charge = json.loads(t[t.index("{", i): t.rindex("}") + 1])
    return data, prices, charge


def load_specs():
    """Характеристики версий из data/source/station_specs.json (по каталогу завода); ключ: код версии (Z...-D|L)."""
    return json.loads(read(ROOT / "data" / "source" / "station_specs.json"))["stations"]


SPECS = load_specs()
# какие поля specs считаются спорными, если у версии есть запись unconfirmed с этим именем (спорное в новые тексты не попадает)
FLAG_FIELDS = {
    "weight": ("weight_kg", "weight_packed_kg"),
    "size": ("size_cm", "package_cm"),
    "socket16": ("ac_16a_limit",),
    "socket_vs_power": ("ac_10a_limit",),
    "usb": ("usb",),
    "dc_connectors": ("dc_connectors",),
    "dc_voltage": ("dc_voltage_v",),
}


def spec_ok(code, field):
    """Поле версии подтверждено каталогом: нет записи unconfirmed, которая его затрагивает."""
    sp = SPECS.get(code)
    if not sp or sp.get(field.split("_limit")[0] if False else field, True) is None:
        return False
    flagged = {u["field"] for u in sp.get("unconfirmed", [])}
    return not any(field in FLAG_FIELDS.get(f, ()) for f in flagged)


def fnum(x):
    """Число для текста: 25.5 -> «25,5», 31.0 -> «31»."""
    if isinstance(x, float) and x == int(x):
        x = int(x)
    return str(x).replace(".", ",")


def dims_text(d):
    return f"{fnum(d['l'])} × {fnum(d['w'])} × {fnum(d['h'])} см"


def sockets_text(code):
    """Розетки 220 В версии: число и тип; предел мощности только если он подтверждён."""
    sp = SPECS.get(code)
    if not sp:
        return ""
    parts = []
    for key, amp in (("ac_10a", 10), ("ac_16a", 16)):
        v = (sp.get("sockets_ac") or {}).get(key)
        if not v:
            continue
        lim = f" (до {num(v['max_w'])} Вт)" if spec_ok(code, key + "_limit") else ""
        parts.append(f"{v['count']} × {amp} А{lim}")
    return "; ".join(parts)


def format_range_val(v):
    s = ("%.1f" % v).replace(".", ",")
    return s[:-2] if s.endswith(",0") else s


def format_range(rng):
    return f"{format_range_val(rng['lo'])}–{format_range_val(rng['hi'])}"


def charge_text_for(cap, ch):
    if not ch or ch.get("basis") == "none":
        return "Время зарядки от сети 220 В уточняется"
    basis = ch.get("basis")
    if basis == "range":
        t80 = ch.get("t80", {})
        t100 = ch.get("t100", {})
        return (f"Время зарядки от сети 220 В: до 80 % — ≈ {format_range(t80)} ч, "
                f"до 100 % — ≈ {format_range(t100)} ч (ориентировочно)")
    elif basis in ("passport", "estimate"):
        acW = ch.get("acW")
        if acW:
            p = acW * 0.9
            t80 = dec(0.8 * cap / p)
            t100 = dec(1.2 * cap / p)
            est = " (ориентировочно)" if basis == "estimate" else ""
            return f"Время зарядки от сети 220 В: до 80 % — {t80} ч, до 100 % — {t100} ч{est}"
    return "Время зарядки от сети 220 В уточняется"


# Бытовые и строительные нагрузки для инженерной таблицы
APPLIANCES = [
    {"name": "Газовый котёл (настенный, двухконтурный)", "watts": 150, "avg": 100, "start": 0, "type": "time"},
    {"name": "Тёплый пол (водяной, насос)", "watts": 60, "avg": 60, "start": 120, "type": "time"},
    {"name": "Холодильник с морозильной камерой", "watts": 150, "avg": 60, "start": 600, "type": "time"},
    {"name": "Wi-Fi роутер", "watts": 12, "avg": 12, "start": 0, "type": "time"},
    {"name": "Освещение (5 LED-ламп)", "watts": 50, "avg": 50, "start": 0, "type": "time"},
    {"name": "Телевизор (Smart TV)", "watts": 100, "avg": 100, "start": 0, "type": "time"},
    {"name": "Ноутбук (работа и зарядка)", "watts": 60, "avg": 60, "start": 0, "type": "time"},
    {"name": "Смартфон (полных зарядок)", "watts": 15, "avg": 15, "start": 0, "type": "charges"},
    {"name": "Скважинный / колодезный насос", "watts": 800, "avg": 800, "start": 2400, "type": "time"},
    {"name": "Сплит-система инверторная", "watts": 900, "avg": 450, "start": 1100, "type": "time"},
    {"name": "Электроинструмент (перфоратор, дрель)", "watts": 1000, "avg": 1000, "start": 1800, "type": "time"},
    {"name": "Болгарка (УШМ 125 мм)", "watts": 1200, "avg": 1200, "start": 2200, "type": "time"},
    {"name": "Микроволновка или кофемашина", "watts": 1300, "avg": 1300, "start": 1600, "type": "time"},
    {"name": "Электрочайник", "watts": 2000, "avg": 2000, "start": 2000, "type": "time"},
    {"name": "Электрообогреватель (конвектор)", "watts": 2000, "avg": 2000, "start": 2000, "type": "time"},
    {"name": "Электроплита (2 конфорки)", "watts": 3000, "avg": 3000, "start": 3000, "type": "time"},
]


def eval_appliance(app, cap, power, eff=0.85):
    watts = app["watts"]
    avg = app["avg"]
    start = app.get("start", 0)
    peak = 2 * power

    # Проверка совместимости
    if power < watts:
        return {
            "status": "no",
            "badge": '<span class="rt-badge no">❌ Превышает номинал</span>',
            "time": f"Нужна станция от {num(watts)} Вт (у этой {num(power)} Вт)",
        }
    if start > peak:
        return {
            "status": "no",
            "badge": '<span class="rt-badge no">❌ Пусковой ток выше пика</span>',
            "time": f"Пусковой ток {num(start)} Вт превышает пик {num(peak)} Вт",
        }

    # Если работает:
    badge = '<span class="rt-badge ok">✅ Тянет</span>'
    if start > power and start <= peak:
        badge = '<span class="rt-badge warn">⚠️ Пуск на пике (до 0,3 с)</span>'

    if app["type"] == "charges":
        count = round(cap * eff / 15)
        time_str = f"≈ {count} полных зарядок"
    else:
        h = (cap * eff) / avg
        if h < 1:
            time_str = f"≈ {round(h * 60)} мин"
        elif h < 24:
            time_str = f"≈ {dec(h)} ч"
        else:
            days = dec(h / 24)
            time_str = f"до {days} суток *"

    return {"status": "ok", "badge": badge, "time": time_str}


# Группы приборов для текста «что и сколько часов» (индексы в APPLIANCES)
RT_GROUPS = [
    ("Постоянные нагрузки", [0, 1, 2, 3, 4, 5, 6, 7]),
    ("Насос и кондиционер", [8, 9]),
    ("Инструмент и кухонная техника", [10, 11, 12]),
    ("Нагреватели", [13, 14, 15]),
]


def runtime_html(cap, power):
    """Время работы приборов предложениями: те же формулы и пороги, что в таблице (eval_appliance), числа этой модели."""
    paras = []
    refuse = []
    for head, idxs in RT_GROUPS:
        items = []
        for i in idxs:
            app = APPLIANCES[i]
            res = eval_appliance(app, cap, power)
            name = app["name"] if app["name"].startswith("Wi-Fi") else app["name"][0].lower() + app["name"][1:]
            if res["status"] == "no":
                refuse.append(f"{name} ({num(app['watts'])} Вт) — {res['time'][0].lower() + res['time'][1:]}")
                continue
            peak = ", пуск на пике до 0,3 с" if "warn" in res["badge"] else ""
            items.append(f"{name} ({num(app['watts'])} Вт{peak}) — {res['time']}")
        if items:
            paras.append(f"<p><strong>{head}:</strong> " + "; ".join(items) + ".</p>")
    if refuse:
        paras.append("<p><strong>Не по силам этой станции:</strong> " + "; ".join(refuse) + ".</p>")
    return (
        f'<section class="model-sec">'
        f'<h2>Что и сколько часов будет работать от этой станции</h2>'
        f'<p class="lead">Ёмкость {num(cap)} Вт·ч с учётом КПД инвертора 85 % и номинальная мощность {num(power)} Вт:</p>'
        + "".join(paras) +
        f'<p class="fn">* Время расчётное. При включённом инверторе станция потребляет до 50 Вт (по паспорту изделия): у приборов до 100 Вт фактическое время работы может быть меньше. Мелкие гаджеты рекомендуется заряжать через штатные USB-порты. В скобках указана номинальная мощность прибора; время рассчитано по средней мощности с учётом циклов работы (у холодильника, котла и сплит-системы она ниже номинала).</p>'
        f'</section>'
    )


def diff_html(combo, data, prices):
    """«Чем отличается корпус»: только подтверждённые различия версий D и L этой модели (если различий нет, блока нет)."""
    if len(combo["vers"]) != 2:
        return ""
    cD, cL = combo["vers"]["D"]["code"], combo["vers"]["L"]["code"]
    sD, sL = SPECS.get(cD), SPECS.get(cL)
    if not sD or not sL:
        return ""
    nD, nL = data["versions"]["D"]["name"], data["versions"]["L"]["name"]
    nD, nL = nD[0].lower() + nD[1:], nL[0].lower() + nL[1:]
    items = []

    def both(title, vD, vL):
        items.append(f"<li><b>{title}.</b> {nD[0].upper() + nD[1:]} — {vD}. {nL[0].upper() + nL[1:]} — {vL}.</li>")
    if spec_ok(cD, "size_cm") and spec_ok(cL, "size_cm") and sD["size_cm"] != sL["size_cm"]:
        both("Размеры (Д × Ш × В)", dims_text(sD["size_cm"]), dims_text(sL["size_cm"]))
    if spec_ok(cD, "package_cm") and spec_ok(cL, "package_cm") and sD["package_cm"] != sL["package_cm"]:
        both("Размер упаковки", dims_text(sD["package_cm"]), dims_text(sL["package_cm"]))
    if spec_ok(cD, "weight_kg") and spec_ok(cL, "weight_kg") and sD["weight_kg"] != sL["weight_kg"]:
        both("Вес без упаковки", f"{fnum(sD['weight_kg'])} кг", f"{fnum(sL['weight_kg'])} кг")
    if spec_ok(cD, "weight_packed_kg") and spec_ok(cL, "weight_packed_kg") and sD["weight_packed_kg"] != sL["weight_packed_kg"]:
        both("Вес в упаковке", f"{fnum(sD['weight_packed_kg'])} кг", f"{fnum(sL['weight_packed_kg'])} кг")
    tD, tL = sockets_text(cD), sockets_text(cL)
    if tD and tL and tD != tL:
        both("Розетки 220 В", tD, tL)
    if spec_ok(cD, "usb") and spec_ok(cL, "usb") and sD["usb"] != sL["usb"]:
        both("Порты USB", sD["usb"], sL["usb"])
    if spec_ok(cD, "dc_connectors") and spec_ok(cL, "dc_connectors") and sD["dc_connectors"] != sL["dc_connectors"]:
        both("Выход постоянного тока", sD["dc_connectors"], sL["dc_connectors"])
    pD, pL = prices.get(cD, 0), prices.get(cL, 0)
    if pD and pL and pD != pL:
        more, less, diff = (nL, nD, pL - pD) if pL > pD else (nD, nL, pD - pL)
        items.append(f"<li><b>Цена.</b> {more[0].upper() + more[1:]} дороже, чем {less}, на {num(diff)} ₽ ({num(max(pD, pL))} ₽ и {num(min(pD, pL))} ₽ с доставкой).</li>")
    if not items:
        return ""
    return (
        f'<section class="model-sec">'
        f'<h2>Чем отличаются два корпуса этой модели</h2>'
        f'<p class="lead">Мощность {num(combo["power"])} Вт и ёмкость {num(combo["cap"])} Вт·ч у обоих корпусов одинаковые, различаются:</p>'
        f'<ul class="diff-list">{"".join(items)}</ul>'
        f'</section>'
    )


def charge_html(combo, data, prices, charge):
    """Стоимость 1 Вт·ч (цена с доставкой ÷ ёмкость, prices.js) и, только для версий с basis passport или estimate в charge.js, время зарядки (estimate с пометкой «ориентировочно»).
    Диапазоны basis "range" сюда не попадают: они остаются в прежних местах страницы."""
    cap = combo["cap"]
    keys = [k for k in ("D", "L") if k in combo["vers"]]
    # время зарядки в новом блоке только там, где оно подтверждено паспортом или расчётом (basis passport и estimate);
    # диапазоны basis "range" остаются только в уже существующих местах страницы
    texts = {k: charge_text_for(cap, charge.get(combo["vers"][k]["code"]))
             for k in keys if (charge.get(combo["vers"][k]["code"]) or {}).get("basis") in ("passport", "estimate")}
    known = {k: t for k, t in texts.items() if "уточняется" not in t}
    paras = []
    if known:
        if len(set(known.values())) == 1 and len(known) == len(keys):
            paras.append(f"<p>{next(iter(known.values()))}.</p>")
        else:
            for k, t in known.items():
                paras.append(f"<p><strong>{esc(data['versions'][k]['name'])}.</strong> {t}.</p>")
    per_wh = []
    for k in keys:
        pr = prices.get(combo["vers"][k]["code"], 0)
        if pr:
            body = data["versions"][k]["name"]
            per_wh.append(f"<li><b>{esc(body)}:</b> {num(pr)} ₽ за {num(cap)} Вт·ч, то есть ≈ {fnum(round(pr / cap, 1))} ₽ за 1 Вт·ч ёмкости (цена с доставкой ÷ ёмкость).</li>")
    if not paras and not per_wh:
        return ""
    return (
        f'<section class="model-sec">'
        f'<h2>{"Зарядка и стоимость 1 Вт·ч" if paras else "Стоимость 1 Вт·ч"}</h2>'
        + "".join(paras)
        + (f'<ul class="diff-list">{"".join(per_wh)}</ul>' if per_wh else "")
        + f'</section>'
    )


def faq_model_html(combo, data, prices, all_combos):
    """Короткий FAQ модели: вес и габариты, розетки, постоянный ток, время работы сразу нескольких приборов. Только подтверждённые поля."""
    cap, power = combo["cap"], combo["power"]
    keys = [k for k in ("D", "L") if k in combo["vers"]]
    codes = {k: combo["vers"][k]["code"] for k in keys}
    body = lambda k: data["versions"][k]["name"]
    qa = []

    def per_version(fn, label_each=True):
        parts = []
        for k in keys:
            t = fn(codes[k])
            if t:
                nb = body(k)
                parts.append((f"{nb[0].upper() + nb[1:]} — " if len(keys) > 1 else "") + t)
        return parts if len(parts) == len(keys) else []

    # вес и габариты входят в ответ только если подтверждены у всех версий модели, а вопрос называется по тому, что реально в ответе
    def has_weight(code): return spec_ok(code, "weight_kg") or spec_ok(code, "weight_packed_kg")
    def has_dims(code): return spec_ok(code, "size_cm") or spec_ok(code, "package_cm")
    with_weight = all(has_weight(codes[k]) for k in keys)
    with_dims = all(has_dims(codes[k]) for k in keys)

    def size_ans(code):
        sp = SPECS.get(code); out = []
        if with_weight and spec_ok(code, "weight_kg"): out.append(f"вес {fnum(sp['weight_kg'])} кг")
        if with_weight and spec_ok(code, "weight_packed_kg"): out.append(f"{fnum(sp['weight_packed_kg'])} кг в упаковке")
        if with_dims and spec_ok(code, "size_cm"): out.append(f"размеры {dims_text(sp['size_cm'])} (Д × Ш × В)")
        if with_dims and spec_ok(code, "package_cm"): out.append(f"упаковка {dims_text(sp['package_cm'])}")
        return ", ".join(out)
    sz_title = {(True, True): "Сколько весит станция {m} и какие у неё габариты?", (False, True): "Какие у станции {m} габариты?",
                (True, False): "Сколько весит станция {m}?"}.get((with_weight, with_dims))
    a = per_version(size_ans) if sz_title else []
    if a:
        qa.append((sz_title.format(m=nm.power_cap(power, cap)), ". ".join(a) + "."))
    a = per_version(sockets_text)
    if a:
        qa.append((f"Сколько розеток 220 В у станции на {num(power)} Вт?", ". ".join(a) + "."))

    def dc_ans(code):
        sp = SPECS.get(code)
        if spec_ok(code, "dc_voltage_v") and spec_ok(code, "dc_connectors"):
            return f"выход постоянного тока {sp['dc_voltage_v']} В: {sp['dc_connectors']}"
        return ""
    a = per_version(dc_ans)
    if a:
        qa.append((f"Какое напряжение и какие разъёмы постоянного тока у ёмкости {num(cap)} Вт·ч?", ". ".join(a) + "."))
    # время работы нескольких приборов сразу: средняя мощность (avg) из того же списка приборов, формула та же (ёмкость × 0,85 ÷ средняя мощность)
    trio = [APPLIANCES[0], APPLIANCES[2], APPLIANCES[3]]
    avg = sum(x["avg"] for x in trio)
    if power >= sum(x["watts"] for x in trio):
        res = eval_appliance({"name": "", "watts": avg, "avg": avg, "start": 0, "type": "time"}, cap, power)
        qa.append((f"На сколько хватит ёмкости {num(cap)} Вт·ч для газового котла, холодильника и роутера одновременно?",
                   f"В среднем они потребляют {num(avg)} Вт (котёл {trio[0]['avg']} Вт, холодильник {trio[1]['avg']} Вт, роутер {trio[2]['avg']} Вт). Расчётное время работы: {res['time']} (ёмкость × 0,85 ÷ средняя мощность)."))
    # модели каталога с той же ёмкостью и с той же мощностью (из data/catalog.js и data/prices.js; ссылки на их страницы)
    def lowest(c):
        pr = [prices.get(v["code"], 0) for v in c["vers"].values() if prices.get(v["code"], 0) > 0]
        return min(pr) if pr else 0

    def link(c):
        return f'<a href="z{c["power"]}-{c["cap"]}.html">{esc(c["title"])}</a>' + (f" — от {num(lowest(c))} ₽" if lowest(c) else "")
    same_cap = [c for c in all_combos if c["cap"] == cap and c["id"] != combo["id"]]
    same_pow = [c for c in all_combos if c["power"] == power]
    html_qa = [(esc(q), esc(a_[0].upper() + a_[1:])) for q, a_ in qa]
    if same_cap:
        html_qa.append((esc(f"Какие ещё станции в каталоге имеют ёмкость {num(cap)} Вт·ч?"),
                        "Такая же ёмкость у моделей: " + "; ".join(link(c) for c in same_cap) + f". У этой модели мощность {num(power)} Вт."))
    if len(same_pow) > 1:
        html_qa.append((esc(f"Какие варианты ёмкости есть у станций на {num(power)} Вт?"),
                        "Станции на " + num(power) + " Вт выпускаются с ёмкостью " + "; ".join(
                            (f"{dec(c['cap'] / 1000)} кВт·ч" + (f" — от {num(lowest(c))} ₽" if lowest(c) else "")) if c["id"] != combo["id"]
                            else f"{dec(c['cap'] / 1000)} кВт·ч (эта модель" + (f", от {num(lowest(c))} ₽" if lowest(c) else "") + ")" for c in same_pow) + "."))
    if not html_qa:
        return ""
    return (
        f'<section class="model-sec faq">'
        f'<h2>Частые вопросы об этой модели</h2>'
        + "".join(f"<details><summary>{q}</summary><p>{a_}</p></details>" for q, a_ in html_qa)
        + f'</section>'
    )


def build_page(combo, data, prices, charge, all_combos):
    cid = combo["id"]
    slug = cid.lower()
    power = combo["power"]
    cap = combo["cap"]
    kwh = dec(cap / 1000)
    title = combo["title"]  # «Станция 2 800 Вт · 3,8 кВт·ч» (задаётся scripts/build_naming.py)
    pc = nm.power_cap(power, cap)
    groups = nm.article_groups(combo)  # [(артикул, [ключи версий])]; больше одного, если у D и L артикулы разные
    uniform_art = groups[0][0] if len(groups) == 1 else None
    # артикул в title — только если он одинаков у всех версий страницы
    page_title = "%s %s%s — цена | %s" % (NAMING["formal"], (uniform_art + " ") if uniform_art else "", pc, SITE_NAME)
    desc_first = f"{NAMING['formal']} {num(power)} Вт, {num(cap)} Вт·ч ({kwh} кВт·ч) на LiFePO4 с чистой синусоидой."
    meta_desc = (
        desc_first + " "
        f"Работает как {NAMING['search_phrase']} и {NAMING['search_phrase_2']}: время работы приборов, характеристики, цена с доставкой в Россию."
    )
    canonical = f"{SITE_URL}models/{slug}.html"

    vers_keys = [k for k in ("D", "L") if k in combo["vers"]]
    has_two = len(vers_keys) == 2
    default_v = "D" if "D" in combo["vers"] else "L"

    # Цены
    prices_list = [prices.get(combo["vers"][k]["code"], 0) for k in vers_keys]
    valid_prices = [p for p in prices_list if p > 0]
    min_price = min(valid_prices) if valid_prices else 0

    # JSON-LD: Product по одному на каждый артикул (у D и L артикул обычно общий, тогда Product один)
    products_ld = []
    for art, keys in groups:
        g_prices = [p for p in (prices.get(combo["vers"][k]["code"], 0) for k in keys) if p > 0]
        node = {
            "@type": "Product",
            "name": nm.product_name(NAMING, SITE_NAME, art),
            "alternateName": nm.alternate_name(NAMING, power, cap),
            "sku": art,
            "mpn": art,
            "url": canonical,
            "brand": {"@type": "Brand", "name": SITE_NAME},
            "description": desc_first,  # поисковые формулировки в JSON-LD только в alternateName
            "image": f"{SITE_URL}{combo['vers'][keys[0]]['img']}",
            "additionalProperty": [
                {"@type": "PropertyValue", "name": "Номинальная мощность", "value": power, "unitCode": "WTT", "unitText": "Вт"},
                {"@type": "PropertyValue", "name": "Ёмкость", "value": cap, "unitCode": "WHR", "unitText": "Вт·ч"},
                {"@type": "PropertyValue", "name": "Пиковая мощность", "value": 2 * power, "unitCode": "WTT", "unitText": "Вт"},
                {"@type": "PropertyValue", "name": "Тип батареи", "value": "LiFePO4"},
            ],
        }
        if g_prices:
            if len(g_prices) > 1 and min(g_prices) != max(g_prices):
                node["offers"] = {
                    "@type": "AggregateOffer",
                    "priceCurrency": "RUB",
                    "lowPrice": min(g_prices),
                    "highPrice": max(g_prices),
                    "offerCount": len(g_prices),
                    "availability": "https://schema.org/PreOrder",
                }
            else:
                node["offers"] = {
                    "@type": "Offer",
                    "priceCurrency": "RUB",
                    "price": g_prices[0],
                    "availability": "https://schema.org/PreOrder",
                }
        products_ld.append(node)
    prod_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Главная", "item": SITE_URL},
                    {"@type": "ListItem", "position": 2, "name": NAMING["catalog_crumb"], "item": f"{SITE_URL}#catalog"},
                    {"@type": "ListItem", "position": 3, "name": title, "item": canonical},
                ],
            },
        ] + products_ld,
    }

    # Переключатель корпусов
    switch_html = ""
    if has_two:
        buttons = []
        for k in vers_keys:
            v_obj = combo["vers"][k]
            p_val = prices.get(v_obj["code"], 0)
            p_str = f"{num(p_val)} ₽" if p_val else "По запросу"
            act = " active" if k == default_v else ""
            b_name = data["versions"][k]["name"]
            buttons.append(
                f'<button type="button" class="model-btn{act}" data-target="{k}">'
                f'<img src="../{esc(v_obj["img"])}" alt="{esc(b_name)}" loading="lazy" width="96" height="76">'
                f'<div><b>{esc(b_name)}</b><span>{p_str}</span></div>'
                f'</button>'
            )
        switch_html = (
            f'<div class="model-switchers">'
            f'<div class="model-switch-title">Выберите вариант корпуса:</div>'
            f'<div class="model-switch-grid">{"".join(buttons)}</div>'
            f'</div>'
        )
    else:
        only_k = vers_keys[0]
        b_name = data["versions"][only_k]["name"]
        switch_html = f'<div class="model-switchers"><span class="badge">Только {esc(b_name).lower()}</span></div>'

    # Панели версий (D и/или L)
    panes_html = []
    for k in vers_keys:
        v_obj = combo["vers"][k]
        code = v_obj["code"]
        p_val = prices.get(code, 0)
        p_html = f"{num(p_val)} ₽ <small>с доставкой</small>" if p_val else "Цена по запросу"
        ch_info = charge.get(code)
        ch_text = charge_text_for(cap, ch_info)

        # Таблица характеристик
        specs_rows = f"<tr><th>Артикул</th><td>{esc(v_obj['article'])}</td></tr>" + "".join(
            f"<tr><th>{esc(r[0])}</th><td>{esc(r[1])}</td></tr>" for r in v_obj["rows"])

        # Порты
        legend_items = "".join(f"<li><b>{g['n']}</b><span>{esc(g['ru'])}</span></li>" for g in v_obj["legend"])

        # Розетки
        sock_text = "; ".join(v_obj["sockets"])

        disp = "" if k == default_v else ' style="display:none"'
        # главное фото: у видимой панели приоритет загрузки, у скрытой (второй корпус) отложенная загрузка
        img_attr = ' fetchpriority="high"' if k == default_v else ' loading="lazy"'
        pane = (
            f'<div class="v-pane" id="pane-{k}"{disp}>'
            f'  <div class="model-layout">'
            f'    <div class="model-gallery">'
            f'      <div class="model-img-box">'
            f'        <img src="../{esc(v_obj["img"])}" alt="{esc(combo["title"])} ({esc(data["versions"][k]["name"])})" width="1200" height="896"{img_attr}>'
            f'      </div>'
            f'      {switch_html}'
            f'    </div>'
            f'    <div class="model-buy">'
            f'      <div class="model-price">{p_html}</div>'
            f'      <div class="model-buy-meta">'
            f'        <div>Код на сайте: <strong>{esc(code)}</strong></div>'
            f'        <div>Корпус: <strong>{esc(data["versions"][k]["name"])}</strong> ({esc(v_obj["design"])})</div>'
            f'        <div>Розетки 220 В: <strong>{esc(sock_text)}</strong></div>'
            f'        <div>Гарантия: <strong>6 месяцев</strong> (продление до 12 мес: +10 000 ₽)</div>'
            f'        <div>Срок доставки в Россию: <strong>около 25 дней</strong></div>'
            f'      </div>'
            f'      <div class="model-cta">'
            f'        <a class="btn primary" href="tel:{PHONE}">Позвонить</a>'
            f'        <a class="btn" href="mailto:{EMAIL}">Написать</a>'
            f'        <a class="btn" href="../index.html#picker">Подобрать станцию</a>'
            f'      </div>'
            f'    </div>'
            f'  </div>'
            f'  <section class="model-sec">'
            f'    <h2>Характеристики и параметры зарядки ({esc(data["versions"][k]["name"])})</h2>'
            f'    <table class="rt-table specs-table"><tbody>{specs_rows}</tbody></table>'
            f'  </section>'
            f'  <section class="model-sec">'
            f'    <h2>Схема портов и разъёмов</h2>'
            f'    <figure class="fig">'
            f'      <img src="../{esc(v_obj["diagram"])}" alt="Схема портов: {esc(code)}" loading="lazy" width="900" height="{v_obj.get("dh", 672)}">'
            f'      <ol>{legend_items}</ol>'
            f'    </figure>'
            f'  </section>'
            f'</div>'
        )
        panes_html.append(pane)

    # Время работы приборов предложениями, отличия корпусов, зарядка и стоимость 1 Вт·ч, короткий FAQ (всё из данных)
    rt_table_html = runtime_html(cap, power)
    diff_block = diff_html(combo, data, prices)
    charge_block = charge_html(combo, data, prices, charge)
    faq_block = faq_model_html(combo, data, prices, all_combos)

    # Блок перелинковки (соседние модели)
    cur_idx = next(i for i, c in enumerate(all_combos) if c["id"] == cid)
    related_combos = []
    # берём до 4 соседних моделей
    for offset in (-2, -1, 1, 2, 3):
        n_idx = cur_idx + offset
        if 0 <= n_idx < len(all_combos) and len(related_combos) < 4:
            related_combos.append(all_combos[n_idx])

    related_cards = []
    for rc in related_combos:
        r_v = rc["vers"].get("D") or rc["vers"].get("L")
        r_p = prices.get(r_v["code"], 0)
        p_txt = f"от {num(r_p)} ₽" if r_p else "Цена по запросу"
        related_cards.append(
            f'<a class="related-card" href="z{rc["power"]}-{rc["cap"]}.html">'
            f'  <img src="../{esc(r_v["img"])}" alt="{esc(rc["title"])}" loading="lazy" width="400" height="300">'
            f'  <b>{esc(rc["title"])}</b>'
            f'  <span>{esc(rc["group"])}</span>'
            f'  <div class="rel-price">{p_txt}</div>'
            f'</a>'
        )
    related_html = (
        f'<section class="model-sec">'
        f'  <h2>Близкие по мощности и ёмкости модели</h2>'
        f'  <div class="related-grid">{"".join(related_cards)}</div>'
        f'</section>'
    )

    related_html = PT.compat_section(cid) + related_html   # «Совместимые аксессуары»: только если есть активные товары, совместимые со станцией

    # Чип с артикулом под H1: если у корпусов артикулы разные, по чипу на корпус, переключаются вместе с корпусом (как панели и цена)
    chip_label = "Артикул: "
    if len(groups) == 1:
        art_chips = f'<span class="badge art-chip">{chip_label}{esc(groups[0][0])}</span>'
    else:
        art_chips = "".join(
            f'<span class="badge art-chip" data-v="{k}"' + ("" if k == default_v else ' style="display:none"') + f'>{chip_label}{esc(combo["vers"][k]["article"])}</span>'
            for k in vers_keys)

    # Сборка финального HTML
    CONSENT = analytics.consent_tag(SEO, "../")           # баннер и счётчик: только при заданном ym_counter_id (assets/consent.js)
    CONSENT = (CONSENT + chr(10)) if CONSENT else ""
    COOKIE_LINK = analytics.settings_link(SEO)            # «Настройки cookie» в подвале: только при заданном ym_counter_id
    NAV_EXTRA = PT.nav_extra("../")                        # пункты навигации разделов новых типов товаров (пусто, пока таких разделов нет)
    doc = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no">
<title>{esc(page_title)}</title>
<meta name="description" content="{esc(meta_desc)}">
<link rel="canonical" href="{esc(canonical)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="{esc(SITE_NAME)}">
<meta property="og:title" content="{esc(page_title)}">
<meta property="og:description" content="{esc(meta_desc)}">
<meta property="og:url" content="{esc(canonical)}">
<meta property="og:image" content="{SITE_URL}{esc(combo['vers'][default_v]['img'])}">
<meta property="og:locale" content="ru_RU">
{SH.head_tail()}
<script type="application/ld+json">{json.dumps(prod_ld, ensure_ascii=False, separators=(',', ':'))}</script>
</head>
<body>
{SH.header(NAV_EXTRA)}

<div class="wrap">
  <nav class="breadcrumbs" aria-label="Хлебные крошки">
    <a href="../index.html">Главная</a>
    <span class="bc-sep">/</span>
    <a href="../index.html#catalog">{esc(NAMING['catalog_crumb'])}</a>
    <span class="bc-sep">/</span>
    <span>{esc(title)}</span>
  </nav>

  <div class="model-header">
    <h1>{esc(NAMING['formal'])} {esc(SITE_NAME)} {num(power)} Вт · {kwh} кВт·ч</h1>
    <p class="lead">Работает как {esc(NAMING['search_phrase'])}: резервное питание для дома, дачи и кемпинга</p>
    <div class="model-meta">
      {art_chips}
      <span class="badge">{esc(combo["group"])}</span>
      <span>LiFePO4 аккумулятор</span>
      <span>Чистая синусоида 220 В</span>
      <span>Пик: {num(2 * power)} Вт</span>
    </div>
  </div>

  {"".join(panes_html)}

  {diff_block}

  {charge_block}

  {rt_table_html}

  {faq_block}

  {related_html}

  {SH.footer(COOKIE_LINK, FOOT_NOTE)}
</div>

{SH.tail(CONSENT)}
<script>
(function(){{
  // Переключение версий корпуса
  var btns = document.querySelectorAll(".model-btn");
  btns.forEach(function(btn){{
    btn.addEventListener("click", function(){{
      var target = btn.getAttribute("data-target");
      btns.forEach(function(b){{ b.classList.toggle("active", b === btn); }});
      document.querySelectorAll(".v-pane").forEach(function(p){{
        p.style.display = (p.id === "pane-" + target) ? "" : "none";
      }});
      document.querySelectorAll(".art-chip[data-v]").forEach(function(c){{
        c.style.display = (c.getAttribute("data-v") === target) ? "" : "none";
      }});
    }});
  }});

  // Версия корпуса из адреса (#v=D или #v=L): так открывает страницу кнопка «К карточке» в ответе чата
  var hv = /[#&]v=([DL])(?:&|$)/.exec(location.hash);
  if(hv){{
    var hb = document.querySelector('.model-btn[data-target="' + hv[1] + '"]');
    if(hb && !hb.classList.contains("active")) hb.click();
  }}

  // Кнопка Наверх
  var topBtn = document.getElementById("toTop");
  if(topBtn){{
    window.addEventListener("scroll", function(){{
      if(window.scrollY > 500) topBtn.classList.add("visible");
      else topBtn.classList.remove("visible");
    }}, {{ passive: true }});
    topBtn.addEventListener("click", function(){{
      window.scrollTo({{ top: 0, behavior: "smooth" }});
    }});
  }}

}})();
</script>
</body>
</html>
"""
    out_path = MODELS_DIR / f"{slug}.html"
    out_path.write_text(doc, encoding="utf-8")
    return out_path


def main():
    data, prices, charge = load_data()
    combos = data["combos"]
    created = 0
    for c in combos:
        build_page(c, data, prices, charge, combos)
        created += 1
    print(f"Сгенерировано {created} страниц моделей в {MODELS_DIR}/")


if __name__ == "__main__":
    main()
