#!/usr/bin/env python3
"""SEO-основа сайта. Запуск из корня репозитория: python scripts/build_seo.py

Без внешних зависимостей, идемпотентный: повторный запуск ничего не меняет, если данные те же.

Что делает:
  1. Между <!-- SEO:BEGIN --> и <!-- SEO:END --> в <head> index.html: title, description, canonical, Open Graph,
     Twitter, theme-color и JSON-LD (Organization, WebSite, BreadcrumbList, Product на каждую комбинацию мощности и
     ёмкости, FAQPage).
  2. Между <!-- FAQ:BEGIN --> и <!-- FAQ:END --> в теле страницы: видимый блок «Частые вопросы» (<details>) из scripts/faq.json.
  3. robots.txt и sitemap.xml в корне (lastmod из git-даты файла страницы). robots.txt всегда без Disallow.
  3а. Метатег robots noindex,nofollow в <head> главной и privacy.html (маркеры <!--ROBOTS:…-->), пока индексация закрыта
      (переключатель: scripts/indexing.py); 404.html всегда с noindex.
  4. Коды верификации и Яндекс.Метрика из scripts/seo.json (см. scripts/analytics.py): мета-теги и счётчик в <head> главной, счётчик и абзац
     про веб-аналитику в privacy.html (маркеры <!--CC:…-->, <!--CCL:…-->, <!--YMP:…--> и <!--YMP5:…-->); пустые значения ничего не выводят.

ЕДИНСТВЕННОЕ место с адресом сайта: SITE_URL ниже. При переезде на свой домен поменяйте его и перезапустите скрипт.
Запускать после любого обновления цен (data/prices.js), каталога (data/catalog.js) или текстов (scripts/faq.json).
"""
import html
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analytics  # noqa: E402
import indexing  # noqa: E402
import product_types as PT  # noqa: E402
import naming as nm  # noqa: E402

NAMING = nm.load()  # единственный источник наименований товара: data/naming.json

SITE_URL = "https://novaya-energy.ru/"  # со слэшем на конце

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"

SITE_NAME = "НОВАЯ ЭНЕРДЖИ"
PHONE = "+79787280002"
PHONE_TEXT = "+7 978 728-00-02"
EMAIL = "apv0050@gmail.com"
TITLE = "%s LiFePO4 — цены | %s" % (nm.cap_first(NAMING["tagline"]), SITE_NAME)
# первое предложение — наименование товара; второе — поисковые формулировки (разрешены только здесь, см. data/naming.json)
DESCRIPTION = ("%s 0,8–8 кВт, 1,5–23 кВт·ч на LiFePO4 с чистой синусоидой. "
               "Работают как %s и %s: подбор по приборам, время работы, цены с доставкой в Россию."
               % (NAMING["formal_plural"], NAMING["search_phrase"], NAMING["search_phrase_2"]))
OG_IMAGE = "img/og.jpg"
OG_IMAGE_ALT = "Две станции — тёмная и светлая на колёсах — у дачного дома и палатки"
THEME_COLOR = "#ffffff"
LOGO = "icon-512.png"


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
    """Product в JSON-LD: по одному на каждый артикул комбинации (у D и L артикул обычно общий, тогда Product один)."""
    items, priced, unpriced = [], 0, 0
    for c in data["combos"]:
        kwh = dec(c["cap"] / 1000)
        for art, keys in nm.article_groups(c):
            vers = [c["vers"][k] for k in keys]
            ps = [prices.get(v["code"], 0) for v in vers]
            ps = [p for p in ps if p > 0]
            node = {
                "@type": "Product",
                "name": nm.product_name(NAMING, SITE_NAME, art),
                "alternateName": nm.alternate_name(NAMING, c["power"], c["cap"]),
                "sku": art,
                "mpn": art,
                "url": abs_url("models/%s.html" % c["id"].lower()),
                "brand": {"@type": "Brand", "name": SITE_NAME},
                "description": ("%s на литий-железо-фосфатных батареях (LiFePO4): номинальная мощность %s Вт, "
                                "ёмкость %s Вт·ч (%s кВт·ч), чистая синусоида.") % (NAMING["short"], num(c["power"]), num(c["cap"]), kwh),
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
        {"@type": "Organization", "@id": abs_url("#org"), "name": SITE_NAME,
         "legalName": "Индивидуальный предприниматель Воробьёв Александр Павлович",
         "url": SITE_URL, "telephone": PHONE_TEXT, "email": EMAIL,
         "logo": abs_url(LOGO), "taxID": "910208709968",
         "address": {
             "@type": "PostalAddress",
             "streetAddress": "Евпаторийское шоссе, д. 5Б, офис 1",
             "addressLocality": "Симферополь",
             "addressRegion": "Республика Крым",
             "postalCode": "295000",
             "addressCountry": "RU"
         }},
        {"@type": "WebSite", "@id": abs_url("#website"), "name": SITE_NAME, "url": SITE_URL, "inLanguage": "ru",
         "publisher": {"@id": abs_url("#org")}},
        {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "name": "Главная", "item": SITE_URL}]},
    ] + products + [
        {"@type": "FAQPage", "mainEntity": [
            {"@type": "Question", "name": f["q"], "acceptedAnswer": {"@type": "Answer", "text": f["a"]}} for f in faq]},
    ]
    return {"@context": "https://schema.org", "@graph": graph}, len(products), priced, unpriced


def seo_head(graph, seo):
    ld = json.dumps(graph, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    lines = [
        "<title>%s</title>" % esc(TITLE),
        '<meta name="description" content="%s">' % esc(DESCRIPTION),
        '<link rel="canonical" href="%s">' % esc(SITE_URL),
    ] + [m for m in [indexing.robots_meta()] if m] + [
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
    ] + analytics.verification_lines(seo)
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
        out.append("    <details><summary>%s</summary><p>%s</p></details>" % (esc(f["q"]), linkify(f["a"]).replace("\n", "<br>")))
    out += ["  </div>", "</section>"]
    return "\n".join(out)


def replace_between(text, begin, end, body, indent=""):
    pat = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
    if len(pat.findall(text)) != 1:
        sys.exit("В index.html должна быть ровно одна пара маркеров %s ... %s" % (begin, end))
    repl = begin + "\n" + "\n".join((indent + l if l else l) for l in body.split("\n")) + "\n" + indent + end
    return pat.sub(lambda m: repl, text)


def replace_inline(text, begin, end, body):
    """Содержимое между маркерами (если body пустое, маркеры стоят вплотную)."""
    pat = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
    if len(pat.findall(text)) != 1:
        sys.exit("Ожидалась ровно одна пара маркеров %s ... %s" % (begin, end))
    repl = begin + ("\n" + body + "\n" if body else "") + end
    return pat.sub(lambda m: repl, text)


def replace_tight(text, begin, end, body):
    """Содержимое между маркерами без переводов строк (для вставки внутрь строки текста)."""
    pat = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
    if len(pat.findall(text)) != 1:
        sys.exit("Ожидалась ровно одна пара маркеров %s ... %s" % (begin, end))
    return pat.sub(lambda m: begin + body + end, text)


def lastmod_for(rel):
    """Дата для <lastmod>: дата последнего коммита файла; для изменённого или нового файла сегодняшняя; без git — дата изменения файла."""
    try:
        dirty = subprocess.run(["git", "status", "--porcelain", "--", rel], cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", check=True).stdout.strip()
        if dirty:
            return date.today().isoformat()
        last = subprocess.run(["git", "log", "-1", "--format=%cs", "--", rel], cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", check=True).stdout.strip()
        if last:
            return last
    except Exception:
        pass
    return date.fromtimestamp((ROOT / rel).stat().st_mtime).isoformat()


def write_if_changed(path, text):
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == text.replace("\r\n", "\n") or (old is not None and old.replace("\r\n", "\n") == text):
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return True


def main():
    assert len(TITLE) <= 60, "title длиннее 60 символов: %d" % len(TITLE)
    assert len(DESCRIPTION) <= 240, "description длиннее 240 символов: %d" % len(DESCRIPTION)
    assert SITE_URL.endswith("/")
    data, prices = load_data()
    faq = [{"q": nm.fill_tokens(f["q"], NAMING), "a": nm.fill_tokens(f["a"], NAMING)}
           for f in json.loads(read(ROOT / "scripts" / "faq.json"))]
    assert all(f.get("q") and f.get("a") for f in faq)
    combos = data["combos"]
    # описание в <meta> написано вручную: следим, чтобы оно не разошлось с каталогом
    pw = [c["power"] for c in combos]; cp = [c["cap"] for c in combos]
    if (min(pw), max(pw), min(cp), max(cp)) != (800, 8000, 1500, 23000):
        print("ВНИМАНИЕ: диапазоны каталога изменились, обновите DESCRIPTION в build_seo.py: мощность %d–%d Вт, ёмкость %d–%d Вт·ч" % (min(pw), max(pw), min(cp), max(cp)))

    seo = analytics.load()
    graph, n_prod, n_priced, n_unpriced = build_graph(data, prices, faq)
    text = read(INDEX).replace("\r\n", "\n")
    text = replace_between(text, "<!-- SEO:BEGIN -->", "<!-- SEO:END -->", seo_head(graph, seo))
    text = replace_between(text, "<!-- FAQ:BEGIN -->", "<!-- FAQ:END -->", faq_block(faq), indent="  ")
    text = replace_inline(text, "<!--CC:BEGIN-->", "<!--CC:END-->", analytics.consent_tag(seo, ""))
    text = PT.apply_nav_to_index(text)   # пункты разделов новых типов товаров (пока их нет, текст не меняется)
    text = replace_tight(text, "<!--CCL:BEGIN-->", "<!--CCL:END-->", analytics.settings_link(seo))
    changed = [write_if_changed(INDEX, text)]

    robots = (
        "User-agent: *\n"
        "Allow: /\n"
        "\n"
        "Sitemap: %ssitemap.xml\n" % SITE_URL
    )
    changed.append(write_if_changed(ROOT / "robots.txt", robots))

    # privacy.html: счётчик Метрики в <head> и абзац про веб-аналитику (только при подключённом счётчике, scripts/seo.json)
    priv_path = ROOT / "privacy.html"
    priv = priv_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    priv = replace_inline(priv, "<!--ROBOTS:BEGIN-->", "<!--ROBOTS:END-->", indexing.robots_meta())
    priv = replace_inline(priv, "<!--CC:BEGIN-->", "<!--CC:END-->", analytics.consent_tag(seo, ""))
    priv = replace_tight(priv, "<!--CCL:BEGIN-->", "<!--CCL:END-->", analytics.settings_link(seo))
    priv = replace_inline(priv, "<!--YMP:BEGIN-->", "<!--YMP:END-->", analytics.privacy_section(seo))
    priv = replace_inline(priv, "<!--YMP5:BEGIN-->", "<!--YMP5:END-->", analytics.privacy_transfer(seo))
    changed.append(write_if_changed(priv_path, priv))

    # 404.html: страница открывается по любому несуществующему адресу, поэтому пути к файлам абсолютные
    nf_path = ROOT / "404.html"
    nf = nf_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    nf = replace_inline(nf, "<!--CC:BEGIN-->", "<!--CC:END-->", analytics.consent_tag(seo, "/"))
    changed.append(write_if_changed(nf_path, nf))

    # sitemap.xml: только канонические страницы; lastmod берётся из git-даты соответствующего файла (если в файле есть незакоммиченные
    # правки или файл новый, то сегодняшняя дата); без исключённых путей (внутренние файлы в карту не попадают)
    sm_path = ROOT / "sitemap.xml"
    pages = [(SITE_URL, "index.html"), (SITE_URL + "privacy.html", "privacy.html")]
    for c in data["combos"]:
        rel = "models/%s.html" % c["id"].lower()
        pages.append((SITE_URL + rel, rel))
    pages += PT.sitemap_pages()   # списки и активные товары новых типов (снятые с продажи и черновики не попадают)
    url_tags = "\n".join("  <url>\n    <loc>%s</loc>\n    <lastmod>%s</lastmod>\n  </url>" % (esc(u), lastmod_for(rel)) for u, rel in pages)
    sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
               '%s\n'
               '</urlset>\n' % url_tags)
    changed.append(write_if_changed(sm_path, sitemap))

    print("Product: %d (с ценой: %d, без цены: %d); FAQ: %d вопросов" % (n_prod, n_priced, n_unpriced, len(faq)))
    print("title: %d симв., description: %d симв." % (len(TITLE), len(DESCRIPTION)))
    print("Изменено файлов: %d из 5 (index.html, robots.txt, privacy.html, 404.html, sitemap.xml)" % sum(changed))


if __name__ == "__main__":
    main()
