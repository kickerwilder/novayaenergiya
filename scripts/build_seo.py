#!/usr/bin/env python3
"""SEO-основа сайта. Запуск из корня репозитория: python scripts/build_seo.py

Без внешних зависимостей, идемпотентный: повторный запуск ничего не меняет, если данные те же.

Что делает:
  1. Между <!-- SEO:BEGIN --> и <!-- SEO:END --> в <head> index.html: title, description, canonical, Open Graph,
     Twitter, theme-color и JSON-LD (Organization, WebSite, BreadcrumbList, Product на каждую комбинацию мощности и
     ёмкости, FAQPage).
  2. Между <!-- FAQ:BEGIN --> и <!-- FAQ:END --> в теле страницы: видимый блок «Частые вопросы» (<details>) из scripts/faq.json.
  3. robots.txt и sitemap.xml в корне.

ЕДИНСТВЕННОЕ место с адресом сайта: SITE_URL ниже. При переезде на свой домен поменяйте его и перезапустите скрипт.
Запускать после любого обновления цен (data/prices.js), каталога (data/catalog.js) или текстов (scripts/faq.json).
"""
import hashlib
import html
import json
import re
import sys
from datetime import date
from pathlib import Path

SITE_URL = "https://kickerwilder.github.io/novayaenergiya/"  # со слэшем на конце

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"

SITE_NAME = "НОВАЯ ЭНЕРГИЯ"
PHONE = "+79787280002"
PHONE_TEXT = "+7 978 728-00-02"
EMAIL = "apv0050@gmail.com"
TITLE = "Электростанции LiFePO4 — цены с доставкой | НОВАЯ ЭНЕРГИЯ"
DESCRIPTION = ("Портативные электростанции 0,8–8 кВт, 1,5–23 кВт·ч на LiFePO4 с чистой синусоидой. "
               "Подбор по приборам, время работы, цены с доставкой в Россию.")
OG_IMAGE = "img/og.jpg"
OG_IMAGE_ALT = "Две портативные электростанции — тёмная и светлая на колёсах — у дачного дома и палатки"
THEME_COLOR = "#ffffff"
LOGO = "assets/favicon.svg"


def read(p):
    return Path(p).read_text(encoding="utf-8")


def abs_url(rel):
    return SITE_URL + rel.lstrip("/")


def esc(s):
    return html.escape(s, quote=True)


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
    return data, prices


def build_products(data, prices):
    items, priced, unpriced = [], 0, 0
    for c in data["combos"]:
        vers = [c["vers"][k] for k in ("D", "L") if k in c["vers"]]
        ps = [prices.get(v["code"], 0) for v in vers]
        ps = [p for p in ps if p > 0]
        kwh = dec(c["cap"] / 1000)
        node = {
            "@type": "Product",
            "name": "Портативная электростанция %s Вт · %s кВт·ч" % (num(c["power"]), kwh),
            "sku": c["id"],
            "brand": {"@type": "Brand", "name": SITE_NAME},
            "description": ("Портативная электростанция на литий-железо-фосфатных батареях (LiFePO4): номинальная мощность %s Вт, "
                            "ёмкость %s Вт·ч (%s кВт·ч), чистая синусоида.") % (num(c["power"]), num(c["cap"]), kwh),
            "image": abs_url(vers[0]["img"]),
            "additionalProperty": [
                {"@type": "PropertyValue", "name": "Номинальная мощность", "value": c["power"], "unitCode": "WTT", "unitText": "Вт"},
                {"@type": "PropertyValue", "name": "Ёмкость", "value": c["cap"], "unitCode": "WHR", "unitText": "Вт·ч"},
            ],
        }
        if ps:  # цена «по запросу» (0) в разметку не попадает
            node["offers"] = {"@type": "AggregateOffer", "priceCurrency": "RUB", "lowPrice": min(ps), "highPrice": max(ps),
                              "offerCount": len(ps), "availability": "https://schema.org/PreOrder"}
            priced += 1
        else:
            unpriced += 1
        items.append(node)
    return items, priced, unpriced


def build_graph(data, prices, faq):
    products, priced, unpriced = build_products(data, prices)
    graph = [
        {"@type": "Organization", "@id": abs_url("#org"), "name": SITE_NAME, "url": SITE_URL, "telephone": PHONE, "email": EMAIL,
         "logo": abs_url(LOGO)},
        {"@type": "WebSite", "@id": abs_url("#website"), "name": SITE_NAME, "url": SITE_URL, "inLanguage": "ru",
         "publisher": {"@id": abs_url("#org")}},
        {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Главная", "item": SITE_URL}]},
    ] + products + [
        {"@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": f["q"], "acceptedAnswer": {"@type": "Answer", "text": f["a"]}} for f in faq]},
    ]
    return {"@context": "https://schema.org", "@graph": graph}, len(products), priced, unpriced


def seo_head(graph):
    ld = json.dumps(graph, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    lines = [
        "<title>%s</title>" % esc(TITLE),
        '<meta name="description" content="%s">' % esc(DESCRIPTION),
        '<link rel="canonical" href="%s">' % esc(SITE_URL),
        '<meta name="theme-color" content="%s">' % THEME_COLOR,
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="%s">' % esc(SITE_NAME),
        '<meta property="og:title" content="%s">' % esc(TITLE),
        '<meta property="og:description" content="%s">' % esc(DESCRIPTION),
        '<meta property="og:locale" content="ru_RU">',
        '<meta property="og:url" content="%s">' % esc(SITE_URL),
        '<meta property="og:image" content="%s">' % esc(abs_url(OG_IMAGE)),
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:image:alt" content="%s">' % esc(OG_IMAGE_ALT),
        '<meta name="twitter:card" content="summary_large_image">',
        '<meta name="twitter:title" content="%s">' % esc(TITLE),
        '<meta name="twitter:description" content="%s">' % esc(DESCRIPTION),
        '<meta name="twitter:image" content="%s">' % esc(abs_url(OG_IMAGE)),
        '<meta name="twitter:image:alt" content="%s">' % esc(OG_IMAGE_ALT),
        '<script type="application/ld+json">%s</script>' % ld,
    ]
    return "\n".join(lines)


def linkify(text):
    """Телефон и почта в видимом ответе становятся ссылками; текст при этом остаётся тем же, что в JSON-LD."""
    t = esc(text)
    t = t.replace(esc(PHONE_TEXT), '<a href="tel:%s">%s</a>' % (PHONE, esc(PHONE_TEXT)))
    t = t.replace(esc(EMAIL), '<a href="mailto:%s">%s</a>' % (EMAIL, esc(EMAIL)))
    return t


def faq_block(faq):
    out = ['<section class="sec reveal" aria-labelledby="fqh" id="faq">',
           '  <h2 id="fqh">Частые вопросы</h2>',
           '  <div class="faq">']
    for f in faq:
        out.append("    <details><summary>%s</summary><p>%s</p></details>" % (esc(f["q"]), linkify(f["a"])))
    out += ["  </div>", "</section>"]
    return "\n".join(out)


def replace_between(text, begin, end, body, indent=""):
    pat = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
    if len(pat.findall(text)) != 1:
        sys.exit("В index.html должна быть ровно одна пара маркеров %s ... %s" % (begin, end))
    repl = begin + "\n" + "\n".join((indent + l if l else l) for l in body.split("\n")) + "\n" + indent + end
    return pat.sub(lambda m: repl, text)


def write_if_changed(path, text):
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == text.replace("\r\n", "\n") or (old is not None and old.replace("\r\n", "\n") == text):
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def main():
    assert len(TITLE) <= 60, "title длиннее 60 символов: %d" % len(TITLE)
    assert len(DESCRIPTION) <= 160, "description длиннее 160 символов: %d" % len(DESCRIPTION)
    assert SITE_URL.endswith("/")
    data, prices = load_data()
    faq = json.loads(read(ROOT / "scripts" / "faq.json"))
    assert all(f.get("q") and f.get("a") for f in faq)
    combos = data["combos"]
    # описание в <meta> написано вручную: следим, чтобы оно не разошлось с каталогом
    pw = [c["power"] for c in combos]; cp = [c["cap"] for c in combos]
    if (min(pw), max(pw), min(cp), max(cp)) != (800, 8000, 1500, 23000):
        print("ВНИМАНИЕ: диапазоны каталога изменились, обновите DESCRIPTION в build_seo.py: мощность %d–%d Вт, ёмкость %d–%d Вт·ч" % (min(pw), max(pw), min(cp), max(cp)))

    graph, n_prod, n_priced, n_unpriced = build_graph(data, prices, faq)
    text = read(INDEX).replace("\r\n", "\n")
    text = replace_between(text, "<!-- SEO:BEGIN -->", "<!-- SEO:END -->", seo_head(graph))
    text = replace_between(text, "<!-- FAQ:BEGIN -->", "<!-- FAQ:END -->", faq_block(faq), indent="  ")
    changed = [write_if_changed(INDEX, text)]

    robots = (
        "# Сайт сейчас закрыт от индексации тегом <meta name=\"robots\" content=\"noindex,nofollow\"> в index.html.\n"
        "# Disallow здесь намеренно нет: если запретить обход, поисковик не прочитает noindex и может показать адрес в выдаче.\n"
        "# При запуске на своём домене достаточно убрать noindex из index.html (см. README).\n"
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        "Sitemap: %ssitemap.xml\n" % SITE_URL
    )
    changed.append(write_if_changed(ROOT / "robots.txt", robots))

    # lastmod меняется только когда поменялись данные: хэш входных файлов хранится в комментарии
    h = hashlib.sha256()
    for f in ("data/catalog.js", "data/prices.js", "scripts/faq.json"):
        h.update(read(ROOT / f).replace("\r\n", "\n").encode("utf-8"))
    digest = h.hexdigest()[:16]
    sm_path = ROOT / "sitemap.xml"
    lastmod = date.today().isoformat()
    if sm_path.exists():
        old = sm_path.read_text(encoding="utf-8")
        m = re.search(r"<!-- data-hash: (\w+) -->", old)
        d = re.search(r"<lastmod>([\d-]+)</lastmod>", old)
        if m and d and m.group(1) == digest:
            lastmod = d.group(1)
    sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               '<!-- data-hash: %s -->\n'
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
               '  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n  </url>\n</urlset>\n' % (digest, esc(SITE_URL), lastmod))
    changed.append(write_if_changed(sm_path, sitemap))

    print("Product: %d (с ценой: %d, без цены: %d); FAQ: %d вопросов" % (n_prod, n_priced, n_unpriced, len(faq)))
    print("title: %d симв., description: %d симв." % (len(TITLE), len(DESCRIPTION)))
    print("Изменено файлов: %d из 3 (index.html, robots.txt, sitemap.xml)" % sum(changed))


if __name__ == "__main__":
    main()
