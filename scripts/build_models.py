#!/usr/bin/env python3
"""Генератор 29 детальных SEO-страниц моделей в models/z{power}-{cap}.html.
Запуск из корня: python scripts/build_models.py (также вызывается из build_all.py).
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)

SITE_URL = "https://novaya-energy.ru/"
SITE_NAME = "НОВАЯ ЭНЕРДЖИ"
PHONE = "+79787280002"
PHONE_TEXT = "+7 978 728-00-02"
EMAIL = "apv0050@gmail.com"


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


def build_page(combo, data, prices, charge, all_combos):
    cid = combo["id"]
    slug = cid.lower()
    power = combo["power"]
    cap = combo["cap"]
    kwh = dec(cap / 1000)
    title = f"Электростанция {num(power)} Вт · {kwh} кВт·ч"
    page_title = f"Портативная электростанция {num(power)} Вт · {kwh} кВт·ч на LiFePO4 — купить, цены | {SITE_NAME}"
    meta_desc = (
        f"Портативная электростанция {num(power)} Вт, {num(cap)} Вт·ч ({kwh} кВт·ч) на LiFePO4 аккумуляторах "
        f"с чистой синусоидой. Время работы бытовых приборов, характеристики, цена с доставкой в Россию."
    )
    canonical = f"{SITE_URL}models/{slug}.html"

    vers_keys = [k for k in ("D", "L") if k in combo["vers"]]
    has_two = len(vers_keys) == 2
    default_v = "D" if "D" in combo["vers"] else "L"

    # Цены
    prices_list = [prices.get(combo["vers"][k]["code"], 0) for k in vers_keys]
    valid_prices = [p for p in prices_list if p > 0]
    min_price = min(valid_prices) if valid_prices else 0

    # JSON-LD
    prod_ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": "Главная", "item": SITE_URL},
                    {"@type": "ListItem", "position": 2, "name": "Каталог электростанций", "item": f"{SITE_URL}#catalog"},
                    {"@type": "ListItem", "position": 3, "name": title, "item": canonical},
                ],
            },
            {
                "@type": "Product",
                "name": f"Портативная электростанция {num(power)} Вт · {kwh} кВт·ч",
                "sku": cid,
                "brand": {"@type": "Brand", "name": SITE_NAME},
                "description": meta_desc,
                "image": f"{SITE_URL}{combo['vers'][default_v]['img']}",
                "additionalProperty": [
                    {"@type": "PropertyValue", "name": "Номинальная мощность", "value": power, "unitCode": "WTT", "unitText": "Вт"},
                    {"@type": "PropertyValue", "name": "Ёмкость", "value": cap, "unitCode": "WHR", "unitText": "Вт·ч"},
                    {"@type": "PropertyValue", "name": "Пиковая мощность", "value": 2 * power, "unitCode": "WTT", "unitText": "Вт"},
                    {"@type": "PropertyValue", "name": "Тип батареи", "value": "LiFePO4"},
                ],
            },
        ],
    }
    if valid_prices:
        if has_two and len(valid_prices) > 1 and min(valid_prices) != max(valid_prices):
            prod_ld["@graph"][1]["offers"] = {
                "@type": "AggregateOffer",
                "priceCurrency": "RUB",
                "lowPrice": min(valid_prices),
                "highPrice": max(valid_prices),
                "offerCount": len(valid_prices),
                "availability": "https://schema.org/PreOrder",
            }
        else:
            prod_ld["@graph"][1]["offers"] = {
                "@type": "Offer",
                "priceCurrency": "RUB",
                "price": valid_prices[0],
                "availability": "https://schema.org/PreOrder",
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
        specs_rows = "".join(f"<tr><th>{esc(r[0])}</th><td>{esc(r[1])}</td></tr>" for r in v_obj["rows"])

        # Порты
        legend_items = "".join(f"<li><b>{g['n']}</b><span>{esc(g['ru'])}</span></li>" for g in v_obj["legend"])

        # Розетки
        sock_text = "; ".join(v_obj["sockets"])

        disp = "" if k == default_v else ' style="display:none"'
        pane = (
            f'<div class="v-pane" id="pane-{k}"{disp}>'
            f'  <div class="model-layout">'
            f'    <div class="model-gallery">'
            f'      <div class="model-img-box">'
            f'        <img src="../{esc(v_obj["img"])}" alt="{esc(combo["title"])} ({esc(data["versions"][k]["name"])})" width="1200" height="896">'
            f'      </div>'
            f'      {switch_html}'
            f'    </div>'
            f'    <div class="model-buy">'
            f'      <div class="model-price">{p_html}</div>'
            f'      <div class="model-buy-meta">'
            f'        <div>Артикул: <strong>{esc(code)}</strong></div>'
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
            f'    <p class="fn">{ch_text}</p>'
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

    # Инженерная таблица расчёта времени работы приборов
    rt_rows = []
    for app in APPLIANCES:
        res = eval_appliance(app, cap, power)
        app_watts = f" ({app['watts']} Вт)" if app["watts"] else ""
        rt_rows.append(
            f'<tr>'
            f'  <td><strong>{esc(app["name"])}</strong>{app_watts}</td>'
            f'  <td>{res["badge"]}</td>'
            f'  <td>{res["time"]}</td>'
            f'</tr>'
        )
    rt_table_html = (
        f'<section class="model-sec">'
        f'  <h2>Что и сколько часов будет работать от этой электростанции</h2>'
        f'  <p class="lead">Расчёт автономной работы приборов от ёмкости {num(cap)} Вт·ч с учётом КПД инвертора 85 % и номинальной мощности {num(power)} Вт:</p>'
        f'  <div class="table-wrap">'
        f'    <table class="rt-table">'
        f'      <thead><tr><th>Прибор / нагрузка</th><th>Статус запуска</th><th>Время автономной работы</th></tr></thead>'
        f'      <tbody>{"".join(rt_rows)}</tbody>'
        f'    </table>'
        f'  </div>'
        f'  <p class="fn">* Время расчётное. При включённом инверторе станция потребляет до 50 Вт (по паспорту изделия): у приборов до 100 Вт фактическое время работы может быть меньше. Мелкие гаджеты рекомендуется заряжать через штатные USB-порты.</p>'
        f'</section>'
    )

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

    # Сборка финального HTML
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
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../assets/styles.css">
<script type="application/ld+json">{json.dumps(prod_ld, ensure_ascii=False, separators=(',', ':'))}</script>
</head>
<body>
<header class="bar" id="top">
  <div class="wrap bar-in">
    <a class="brand" href="../index.html" aria-label="{esc(SITE_NAME)} — портативные электростанции, на главную"><span class="brand-n">{esc(SITE_NAME)}</span><span class="brand-s">портативные электростанции</span></a>
    <nav class="nav" aria-label="Разделы страницы">
      <a href="../index.html#catalog">Каталог</a>
      <a href="../index.html#picker">Подбор</a>
      <a href="../index.html#faq">Вопросы</a>
      <a href="../index.html#contacts">Контакты</a>
    </nav>
    <div class="bar-c">
      <a class="tel" href="tel:{PHONE}">{PHONE_TEXT}</a>
      <a class="mail" href="mailto:{EMAIL}">{EMAIL}</a>
      <a class="btn sm primary" href="mailto:{EMAIL}">Написать</a>
    </div>
  </div>
</header>

<div class="wrap">
  <nav class="breadcrumbs" aria-label="Хлебные крошки">
    <a href="../index.html">Главная</a>
    <span class="bc-sep">/</span>
    <a href="../index.html#catalog">Каталог</a>
    <span class="bc-sep">/</span>
    <span>{esc(title)}</span>
  </nav>

  <div class="model-header">
    <h1>Портативная электростанция {num(power)} Вт · {kwh} кВт·ч</h1>
    <div class="model-meta">
      <span class="badge">{esc(combo["group"])}</span>
      <span>LiFePO4 аккумулятор</span>
      <span>Чистая синусоида 220 В</span>
      <span>Пик: {num(2 * power)} Вт</span>
    </div>
  </div>

  {"".join(panes_html)}

  {rt_table_html}

  {related_html}

  <footer class="foot">
    <p class="foot-brand">{esc(SITE_NAME)}</p>
    <p class="req"><a href="tel:{PHONE}">{PHONE_TEXT}</a> · <a href="mailto:{EMAIL}">{EMAIL}</a></p>
    <div class="foot-legal">
      <p class="legal-seller"><strong>ИП Воробьёв Александр Павлович</strong> · ИНН 910208709968 · ОГРНИП 326911200011729<br>Республика Крым, г. Симферополь, Евпаторийское шоссе, д. 5Б, офис 1</p>
      <p class="legal-offer">Информация о ценах, характеристиках и комплектации носит информационный характер и не является публичной офертой, определяемой положениями ст. 437 ГК РФ. Точные параметры и комплектацию подтверждаем при оформлении заказа.</p>
      <p class="legal-links"><a href="../privacy.html">Политика обработки персональных данных</a> · <a href="../index.html#contacts">Реквизиты и контакты</a></p>
    </div>
    <p>Время работы — расчётная оценка: ёмкость × 0,85 ÷ средняя мощность приборов. Доставка в Россию: около 25 дней.</p>
    <p class="copy">© 2026 НОВАЯ ЭНЕРДЖИ. Все права защищены.</p>
  </footer>
</div>

<div class="dock" role="group" aria-label="Связаться">
  <a class="btn primary" href="tel:{PHONE}">Позвонить</a>
  <a class="btn" href="mailto:{EMAIL}">Написать</a>
</div>
<div class="cookie-banner" id="cookieBanner" role="region" aria-label="Уведомление о файлах cookie" hidden>
  <div class="cookie-text">Мы используем файлы cookie для корректной работы сайта. Оставаясь на сайте, вы соглашаетесь с <a href="../privacy.html">Политикой обработки данных</a>.</div>
  <button type="button" class="btn sm primary" id="cookieAccept">Понятно</button>
</div>
<button type="button" class="to-top" id="toTop" aria-label="Наверх" title="Наверх">↑</button>

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
    }});
  }});

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

  // Cookie
  var cb = document.getElementById("cookieBanner"), ca = document.getElementById("cookieAccept");
  if(cb && ca){{
    try{{
      if(!localStorage.getItem("ne_cookie_consent")){{
        cb.hidden = false;
        ca.addEventListener("click", function(){{
          localStorage.setItem("ne_cookie_consent", "1");
          cb.hidden = true;
        }});
      }}
    }}catch(_){{}}
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
