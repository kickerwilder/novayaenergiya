#!/usr/bin/env python3
"""База знаний чат-консультанта: data/kb.json (публичный файл, публикуется вместе с сайтом).
Запуск из корня репозитория: python scripts/build_bot_kb.py   (или scripts/build_all.py)

Без внешних зависимостей, идемпотентный: повторный запуск ничего не меняет, если данные те же.
Источники: data/catalog.js (версии, приборы), data/prices.js (цены «с доставкой»), data/charge.js (зарядка), scripts/faq.json,
data/source/station_specs.json (характеристики по каталогам завода: вес, размеры, упаковка, розетки, DC, USB и список unconfirmed;
руками не править, правки через этот файл и повторный запуск скрипта).
Расчёты (подбор, часы работы) бот делает кодом через assets/calc.js; в базе знаний только данные и правила.

Вес, габариты, точное число и тип розеток, допуск по напряжению, сертификаты и т. п. сюда НЕ попадают как факты:
они перечислены отдельным списком clarify (цифр не называть, отвечать «Уточните у менеджера» и давать контакты).
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import naming as nm  # noqa: E402
import product_types as PT  # noqa: E402

NAMING = nm.load()  # единственный источник наименований товара: data/naming.json

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "kb.json"
SPECS_SRC = ROOT / "data" / "source" / "station_specs.json"
SPEC_FIELDS = ["weight_kg", "weight_packed_kg", "size_cm", "package_cm", "sockets_ac", "dc_voltage_v", "dc_connectors", "usb"]
SITE_URL = None  # берётся из build_seo.py, чтобы адрес был в одном месте

CONTACTS = {"phone": "+7 978 728-00-02", "email": "apv0050@gmail.com"}

RULES = [
    "Официальное наименование товара — «%s». В разговоре говори «станция». У каждой станции есть артикул (поле article, вида ZF…): называй его рядом с мощностью и ёмкостью и пиши ровно так, как в данных (ZF16-2005 и ZF16-2005.0 — разные артикулы)." % NAMING["formal"],
    "Гарантия 6 месяцев. Продление до 12 месяцев — плюс 10 000 ₽ к стоимости станции. Основная цена не меняется.",
    "Срок доставки в Россию — около 25 дней (ориентировочно). Цена на сайте указана с доставкой. Других сроков не обещать.",
    "Класс защиты корпуса IP20: станцию использовать только в помещении или под навесом, где на неё не попадают дождь и брызги. Под дождём нельзя.",
    "Станция выдаёт напряжение 220 В, 50 Гц с искажением формы не более 3 % (чистая синусоида) — подходит для техники с электронными платами.",
    "К домашней сети станцию подключать только через переключатель ввода резерва (трансфер), который монтирует электрик. В обычную розетку дома втыкать нельзя.",
    "Через одну розетку нельзя брать больше её предела (поле maxSocket у модели); приборы лучше включать в разные розетки.",
    "На моделях с постоянным напряжением 24 В и 48 В гнездо-прикуриватель выдаёт 24 или 48 В, а не 12 В: подключать только приборы на это напряжение, обычные 12-вольтовые автоприборы нельзя.",
    "От солнечных панелей станция заряжается только через внешний MPPT-контроллер: в комплект он не входит, встроенного MPPT у станции нет. Панель и контроллер под модель подбирает менеджер; напряжение и мощность панелей не называть.",
    "Заряжать станцию можно при температуре воздуха от 0 до +45 °C.",
    "Ресурс батареи: не менее 2000 циклов заряда-разряда до 80 % остаточной ёмкости (по паспорту изделия).",
    "Собственное потребление станции при включённом инверторе — до 50 Вт (по паспорту изделия). У приборов до 100 Вт фактическое время работы может быть меньше расчётного; мелкие устройства лучше заряжать через USB.",
    "Пиковая мощность станции — двойной номинал на время до 0,3 с (по паспорту изделия). Пусковой ток прибора не должен её превышать.",
    "Время работы считается как ёмкость × 0,85 ÷ средняя мощность приборов; это расчётная оценка, точный расчёт подтвердит менеджер.",
    "Для газового котла проверьте требования по паспорту котла (в том числе по заземлению и подключению фазы) и уточните модель котла.",
]

CLARIFY = [
    "Число розеток, вес, размеры и порты — только из specs, а поля из unconfirmed называть как «по каталогу завода, точное значение: уточните у менеджера».",
    "Допуск по выходному напряжению уточняется — цифр не называть.",
    "Сертификаты и соответствие стандартам уточняются — не обещать.",
    "Работа тёмных моделей при низких температурах уточняется — отвечать «Уточните у менеджера».",
    "Точная ёмкость по реальным замерам уточняется.",
    "Мощность зарядного устройства (в ваттах), сертификаты и гарантия завода в таблице характеристик по каталогам завода не указаны — не выдумывать, передавать менеджеру: «Уточните у менеджера» и контакты.",
    "Наличие, скидки, сроки, кроме «около 25 дней», рассрочка, оплата, адрес и режим работы — не обещать, направлять на телефон или почту.",
]


def read(p):
    return Path(p).read_text(encoding="utf-8")


def site_url():
    m = re.search(r'^SITE_URL\s*=\s*"([^"]+)"', read(ROOT / "scripts" / "build_seo.py"), re.M)
    return m.group(1) if m else ""


def load_catalog():
    s = read(ROOT / "data" / "catalog.js")
    return json.loads(s[s.index("{"): s.rindex("}") + 1])


def load_prices():
    return {k: int(v) for k, v in re.findall(r'"(Z[\w-]+)"\s*:\s*(\d+)', read(ROOT / "data" / "prices.js"))}


def load_charge():
    t = read(ROOT / "data" / "charge.js")
    i = t.index("const CHARGE = ")
    return json.loads(t[t.index("{", i): t.rindex("}") + 1])


def load_owner_confirmed():
    """Факты владельца (проверены на практике, заводом не подтверждены): тип розеток и способы зарядки. Источник: station_specs.json, common.owner_confirmed."""
    oc = json.loads(read(SPECS_SRC))["common"]["owner_confirmed"]
    m = oc["charging_methods"]
    for k in ("grid", "solar", "car", "generator"):
        if k not in m:
            sys.exit("station_specs.json: нет charging_methods.%s" % k)
    if not oc.get("ac_socket_type") or not m["generator"].get("short") or not m["generator"].get("full") or "requires_dc_voltage_v" not in m["car"]:
        sys.exit("station_specs.json: owner_confirmed заполнен не полностью")
    return oc


def load_specs(stations):
    """Характеристики по артикулам: {артикул: [{body, specs, unconfirmed}, ...]} (для страницы из D и L обе версии с полем body)."""
    src = json.loads(read(SPECS_SRC))["stations"]
    by_code = {s["code"]: s for s in stations}
    if set(src) != set(by_code):
        sys.exit("station_specs.json и каталог расходятся: нет в таблице %s; лишние в таблице %s" % (
            sorted(set(by_code) - set(src)), sorted(set(src) - set(by_code))))
    out = {}
    for code in [s["code"] for s in stations]:  # порядок каталога: D, затем L внутри комбинации
        e, st = src[code], by_code[code]
        if e["article"] != st["article"] or e["body"] != st["body"] or e["power_w"] != st["power_w"] or e["cap_wh"] != st["cap_wh"]:
            sys.exit("station_specs.json: %s не совпадает с каталогом (артикул/корпус/мощность/ёмкость)" % code)
        entry = {"body": e["body"], "specs": {k: e[k] for k in SPEC_FIELDS},
                 "unconfirmed": [{"field": u["field"], "note": u["note"]} for u in e.get("unconfirmed", [])]}
        out.setdefault(st["article"], []).append(entry)
    return out


def r1(x):
    return round(x * 10) / 10


def build():
    data, prices, charge = load_catalog(), load_prices(), load_charge()
    stations = []
    for c in data["combos"]:
        for k in ("D", "L"):
            v = c["vers"].get(k)
            if not v:
                continue
            row = {r[0]: r[1] for r in v["rows"]}
            ch = charge.get(v["code"])
            if ch and ch.get("basis") == "range":
                charge_info = {"basis": "range", "t80_h": ch["t80"], "t100_h": ch["t100"]}
            elif ch and ch.get("acW"):
                p = ch["acW"] * 0.9
                charge_info = {"basis": ch["basis"], "t80_h": r1(0.8 * c["cap"] / p), "t100_h": r1(c["cap"] / p * 1.2)}
            else:
                charge_info = {"basis": "none"}
            st = {
                "code": v["code"], "article": v["article"], "combo": c["id"], "body": k, "bodyName": data["versions"][k]["name"],
                "title": c["title"], "group": c["group"],
                "power_w": c["power"], "peak_w": 2 * c["power"], "cap_wh": c["cap"],
                "price_rub": prices.get(v["code"], 0),
                "maxSocket_w": v["maxSocket"],
                "sockets_catalog": v["sockets"],
                "dc_output": row.get("Выход постоянного тока", ""),
                "charge": charge_info,
                "temp_charge": "0…+45 °C",
                "temp_discharge": row.get("Температура при работе", "") if k == "L" else "уточняется",
                "purposes": [data["purposes"][p_] for p_ in c["purposes"]],
            }
            stations.append(st)
    loads = []
    for l in data["loads"]:
        d = {"id": l["key"], "name": l["name"], "watts": l["watts"], "avg": l.get("avg", l["watts"]), "start": l.get("start", 0)}
        loads.append(d)
    owner = load_owner_confirmed()
    specs = load_specs(stations)
    # car_ok: зарядка от автомобиля через XT90 только у версий с нужным напряжением DC (из данных, не из кода)
    need_v = owner["charging_methods"]["car"]["requires_dc_voltage_v"]
    for st in stations:
        e = next(x for x in specs[st["article"]] if x["body"] == st["body"])
        st["car_ok"] = e["specs"]["dc_voltage_v"] == need_v
    faq = [{"q": nm.fill_tokens(f["q"], NAMING), "a": nm.fill_tokens(f["a"], NAMING)}
           for f in json.loads(read(ROOT / "scripts" / "faq.json"))]
    kb = {
        "version": 1,
        "site_url": site_url(),
        "naming": {"formal": NAMING["formal"], "short": NAMING["short"], "neutral": NAMING["neutral"]},
        "contacts": CONTACTS,
        "currency": "RUB",
        "price_note": "Цена указана с доставкой. 0 = цена по запросу.",
        "eff": data["eff"],
        "phone_wh": data["phone_wh"],
        "bodies": {k: data["versions"][k]["name"] for k in data["versions"]},
        "stations": stations,
        "specs": specs,
        "owner_confirmed": owner,
        "loads": loads,
        "rules": RULES,
        "clarify": CLARIFY,
        "faq": faq,
    }
    extra = PT.kb_entries()   # только типы с in_bot_kb = true (по умолчанию ни одного: kb.json не меняется)
    if extra:
        kb["products"] = extra
    return kb


def dump(kb):
    parts = []
    for key, val in kb.items():
        if key == "specs":
            body = ",\n    ".join("%s: %s" % (json.dumps(a), json.dumps(v, ensure_ascii=False, separators=(",", ":"))) for a, v in val.items())
            parts.append('  "specs": {\n    %s\n  }' % body)
        elif key in ("stations", "loads", "faq"):
            body = ",\n    ".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in val)
            parts.append('  %s: [\n    %s\n  ]' % (json.dumps(key), body))
        else:
            parts.append("  %s: %s" % (json.dumps(key), json.dumps(val, ensure_ascii=False, separators=(",", ":"))))
    return "{\n" + ",\n".join(parts) + "\n}\n"


def main():
    kb = build()
    text = dump(kb)
    json.loads(text)  # валидность
    old = OUT.read_text(encoding="utf-8") if OUT.exists() else None
    changed = old != text
    if changed:
        with open(OUT, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    st = kb["stations"]
    print("kb.json: версий %d, приборов %d, правил %d, к уточнению %d, FAQ %d; без цены: %d; %s" % (
        len(st), len(kb["loads"]), len(kb["rules"]), len(kb["clarify"]), len(kb["faq"]),
        sum(1 for s in st if s["price_rub"] == 0), "обновлён" if changed else "без изменений"))


if __name__ == "__main__":
    main()
