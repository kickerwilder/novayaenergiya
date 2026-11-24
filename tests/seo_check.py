#!/usr/bin/env python3
"""Проверка технического SEO без сети и без браузера: python tests/seo_check.py (из любой папки). Код возврата 0, если всё чисто.

Проверяет главную, privacy.html и 29 страниц моделей:
  - один <h1>, заголовки без скачков уровня; canonical на каждой странице (совпадает с адресом из sitemap.xml); og:image; описание;
  - у всех <img> есть alt, width и height; кроме картинок первого экрана, loading="lazy";
  - JSON-LD: парсится; Product (name, image, description, sku, mpn, brand, url, offers с ценой из data/prices.js), FAQPage (вопросы и ответы,
    совпадают с видимым FAQ), BreadcrumbList на страницах моделей; Offer только при цене, которая показана на странице;
  - sitemap.xml: только канонические страницы (31), lastmod в формате даты, внутренних путей нет; robots.txt: Allow для всего, строка Sitemap;
  - есть 404.html; нет noindex на публичных страницах; название товара: запрещённое слово не в title, og:title, twitter:title;
  - файл ключа IndexNow лежит в корне и не закрыт ни _config.yml, ни правилами Caddy и деплоя.
"""
import glob
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import product_types as PT  # noqa: E402
SITE = "https://novaya-energy.ru/"
errors = []


def err(msg):
    errors.append(msg)


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.heads, self.imgs, self.metas, self.canon, self.ld, self._t, self.title, self._ld = [], [], {}, None, [], False, "", False
        self.text = []

    def handle_starttag(self, tag, a):
        a = dict(a)
        if re.fullmatch(r"h[1-6]", tag): self.heads.append(int(tag[1]))
        if tag == "img": self.imgs.append(a)
        if tag == "title": self._t = True
        if tag == "meta" and (a.get("name") or a.get("property")): self.metas[a.get("name") or a.get("property")] = a.get("content", "")
        if tag == "link" and a.get("rel") == "canonical": self.canon = a.get("href")
        if tag == "script" and a.get("type") == "application/ld+json": self._ld = True; self.ld.append("")

    def handle_endtag(self, tag):
        if tag == "title": self._t = False
        if tag == "script": self._ld = False

    def handle_data(self, d):
        if self._t: self.title += d
        if self._ld: self.ld[-1] += d
        else: self.text.append(d)


def parse(rel):
    t = (ROOT / rel).read_text(encoding="utf-8")
    p = Page(); p.feed(t)
    return t, p


# ---------- данные ----------
cat = (ROOT / "data" / "catalog.js").read_text(encoding="utf-8")
DATA = json.loads(cat[cat.index("{"): cat.rindex("}") + 1])
prices = {k: int(v) for k, v in re.findall(r'"(Z[\w-]+)"\s*:\s*(\d+)', (ROOT / "data" / "prices.js").read_text(encoding="utf-8"))}
pages = ["index.html", "privacy.html"] + ["models/%s.html" % c["id"].lower() for c in DATA["combos"]]
canon_of = {"index.html": SITE}
for p in pages[1:]:
    canon_of[p] = SITE + p

# ---------- sitemap и robots ----------
sm = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
locs = re.findall(r"<loc>(.*?)</loc>", sm)
lastmods = re.findall(r"<lastmod>(.*?)</lastmod>", sm)
EXTRA_SITEMAP = [u for u, _ in PT.sitemap_pages()]   # списки и активные товары новых типов (пока типов нет: пусто)
if sorted(locs) != sorted(list(canon_of.values()) + EXTRA_SITEMAP): err("sitemap.xml: набор адресов не совпадает с каноническими страницами (%d из %d)" % (len(locs), len(canon_of)))
if len(lastmods) != len(locs) or not all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in lastmods): err("sitemap.xml: lastmod не у всех страниц или не в формате даты")
if any(re.search(r"data/source|naming\.json|README|SKILL|/scripts/|/tests/|/bot/|404\.html|\.txt", u) for u in locs): err("sitemap.xml: во внутренние пути попали: %s" % [u for u in locs if re.search(r"data/source|README|SKILL|scripts|tests|bot|404", u)])
robots = (ROOT / "robots.txt").read_text(encoding="utf-8")
if not re.search(r"(?m)^Allow:\s*/\s*$", robots) or "Disallow: /\n" in robots + "\n" and re.search(r"(?m)^Disallow:\s*/\s*$", robots): err("robots.txt: нужен Allow: / и не должно быть Disallow: / для основного домена")
if "Sitemap: %ssitemap.xml" % SITE not in robots: err("robots.txt: нет строки Sitemap")
if not (ROOT / "404.html").exists(): err("нет 404.html")

# ---------- страницы ----------
faq_visible = 0
for rel in pages:
    t, p = parse(rel)
    if p.heads.count(1) != 1: err("%s: h1 %d шт., нужен один" % (rel, p.heads.count(1)))
    if any(b - a > 1 for a, b in zip(p.heads, p.heads[1:])): err("%s: скачок уровня заголовков %s" % (rel, p.heads))
    if p.canon != canon_of[rel]: err("%s: canonical %r, ожидался %r" % (rel, p.canon, canon_of[rel]))
    if not p.metas.get("og:image", "").startswith(SITE): err("%s: нет og:image с абсолютным адресом" % rel)
    if not p.metas.get("description"): err("%s: нет description" % rel)
    if re.search(r'name="robots"[^>]*noindex', t): err("%s: noindex на публичной странице" % rel)
    for name in ("og:title", "twitter:title"):
        if re.search("электро[с]танц", p.metas.get(name, ""), re.I): err("%s: запрещённое название товара в %s" % (rel, name))
    if re.search("электро[с]танц", p.title, re.I): err("%s: запрещённое название товара в title" % rel)
    for i in p.imgs:
        src = i.get("src", "")
        if "alt" not in i: err("%s: img без alt: %s" % (rel, src))
        if not (i.get("width") and i.get("height")): err("%s: img без width/height: %s" % (rel, src))
    # картинки не первого экрана ленивые: на главной все, кроме логотипа; на моделях главное фото видимой панели и логотип — без lazy
    eager = [i.get("src") for i in p.imgs if i.get("loading") != "lazy"]
    allowed = {"favicon.svg?v=2", "../favicon.svg?v=2"}
    extra = [s for s in eager if s not in allowed and not (rel.startswith("models/") and s and s.startswith("../img/photo-"))]
    if extra: err("%s: img без loading=lazy вне первого экрана: %s" % (rel, extra))
    if rel.startswith("models/"):
        eager_main = [i for i in p.imgs if i.get("loading") != "lazy" and i.get("src", "").startswith("../img/photo-")]
        if len(eager_main) != 1 or eager_main[0].get("fetchpriority") != "high": err("%s: главное фото видимой панели должно быть одно, с fetchpriority=high (eager: %d)" % (rel, len(eager_main)))
    # JSON-LD
    blocks = []
    for raw in p.ld:
        try: blocks.append(json.loads(raw))
        except Exception as e: err("%s: JSON-LD не парсится: %s" % (rel, e))
    graph = [n for b in blocks for n in (b.get("@graph") or [b])]
    products = [n for n in graph if n.get("@type") == "Product"]
    crumbs = [n for n in graph if n.get("@type") == "BreadcrumbList"]
    faqs = [n for n in graph if n.get("@type") == "FAQPage"]
    visible_text = " ".join(p.text)
    for n in products:
        for k in ("name", "image", "description", "sku", "mpn", "url"):
            if not n.get(k): err("%s: у Product нет %s" % (rel, k))
        if not (n.get("brand") or {}).get("name"): err("%s: у Product нет brand.name" % rel)
        if not str(n.get("image", "")).startswith(SITE): err("%s: Product.image не абсолютный адрес" % rel)
        if n.get("sku") != n.get("mpn") or n.get("sku", "") not in n.get("name", ""): err("%s: sku/mpn/name Product не согласованы: %s" % (rel, n.get("sku")))
        o = n.get("offers")
        if o:
            if o.get("priceCurrency") != "RUB" or "schema.org" not in o.get("availability", ""): err("%s: Offer: нет RUB или availability" % rel)
            if o["@type"] == "Offer" and not (isinstance(o.get("price"), int) and o["price"] > 0): err("%s: Offer.price не число" % rel)
            if o["@type"] == "AggregateOffer" and not (o.get("lowPrice") and o.get("highPrice") and o.get("offerCount")): err("%s: AggregateOffer без lowPrice/highPrice/offerCount" % rel)
            vals = [o["price"]] if o["@type"] == "Offer" else [o["lowPrice"], o["highPrice"]]
            # цена должна существовать в data/prices.js (на главной цены выводит app.js; на моделях они в тексте страницы)
            if not all(v in prices.values() for v in vals): err("%s: цена в Offer не из data/prices.js: %s" % (rel, vals))
            if rel.startswith("models/"):
                for v in vals:
                    s = "{:,}".format(v).replace(",", " ")
                    if s not in visible_text.replace("\xa0", " "): err("%s: цена %s ₽ из Offer не показана на странице" % (rel, s))
    if rel.startswith("models/"):
        if len(crumbs) != 1 or len(crumbs[0].get("itemListElement", [])) != 3: err("%s: нужна BreadcrumbList из 3 элементов" % rel)
        if not products: err("%s: нет Product" % rel)
    if rel == "index.html":
        if len(products) != 31: err("index.html: Product %d, ожидалось 31" % len(products))
        if len(faqs) != 1: err("index.html: нужен один FAQPage")
        else:
            qs = faqs[0].get("mainEntity", [])
            if not qs or not all(q.get("name") and (q.get("acceptedAnswer") or {}).get("text") for q in qs): err("index.html: у вопросов FAQPage нет name или текста ответа")
            faq_visible = len(re.findall(r"<details><summary>", t.split("<!-- FAQ:BEGIN -->")[1].split("<!-- FAQ:END -->")[0])) if "<!-- FAQ:BEGIN -->" in t else 0
            if faq_visible != len(qs): err("index.html: вопросов в видимом FAQ %d, в FAQPage %d" % (faq_visible, len(qs)))

# ---------- ключ IndexNow и закрытые пути ----------
seo = json.loads((ROOT / "scripts" / "seo.json").read_text(encoding="utf-8"))
key = seo.get("indexnow_key", "")
if not re.fullmatch(r"[0-9a-f]{32}", key): err("scripts/seo.json: indexnow_key должен быть 32 hex-символа")
elif not (ROOT / (key + ".txt")).exists() or (ROOT / (key + ".txt")).read_text(encoding="utf-8").strip() != key: err("нет файла %s.txt в корне с ключом внутри" % key)
else:
    cfg = (ROOT / "_config.yml").read_text(encoding="utf-8") if (ROOT / "_config.yml").exists() else ""
    ex = [l.strip()[2:].strip() for l in cfg.splitlines() if l.strip().startswith("- ")]
    if any(key + ".txt" == e or e in ("*.txt", ".txt") for e in ex): err("файл ключа IndexNow исключён в _config.yml")
    cf = ROOT / "bot" / "deploy" / "Caddyfile"
    if cf.exists():
        c = cf.read_text(encoding="utf-8")
        internal = " ".join(re.findall(r"@internal(?:_ext)? path (.*)", c))
        if re.search(r"\*\.txt|/%s" % re.escape(key), internal): err("файл ключа IndexNow закрыт в bot/deploy/Caddyfile")
    wf = ROOT / ".github" / "workflows" / "deploy.yml"
    if wf.exists() and re.search(r"--exclude '[^']*\.txt'", wf.read_text(encoding="utf-8")): err("файл ключа IndexNow исключён в deploy.yml")

# ---------- новые типы товаров: страницы, защита адресов, редиректы, навигация ----------
type_pages = PT.all_pages_rel()
FORBID = re.compile("электро[с]танц|портативн\\w*\\s+зарядн\\w*\\s+станци", re.I)
for guard in PT.check_guard():
    err("защита индексации: " + guard)
for tkey, t in PT.load_registry().items():
    for pr in PT.load_products(tkey):
        if not pr["_generated"] and (ROOT / pr["_rel"]).exists() and PT.MARK in (ROOT / pr["_rel"]).read_text(encoding="utf-8"):
            err("%s: товар не опубликован (черновик, не утверждено название или тип), а страница есть" % pr["_rel"])
index_html = (ROOT / "index.html").read_text(encoding="utf-8")
if (not PT.nav_types()) and "data-ptype" in index_html: err("index.html: есть пункт навигации раздела, а опубликованных товаров нет")
for tk in PT.nav_types():
    if 'data-ptype="%s"' % tk not in index_html: err("index.html: нет пункта навигации раздела %s" % tk)
for rel in type_pages:
    t_, p_ = parse(rel)
    is_list = rel.endswith("/index.html")
    want = SITE + (rel[: -len("index.html")] if is_list else rel)
    if p_.heads.count(1) != 1: err("%s: h1 %d шт., нужен один" % (rel, p_.heads.count(1)))
    if any(b - a > 1 for a, b in zip(p_.heads, p_.heads[1:])): err("%s: скачок уровня заголовков %s" % (rel, p_.heads))
    if p_.canon != want: err("%s: canonical %r, ожидался %r" % (rel, p_.canon, want))
    if not p_.metas.get("og:image", "").startswith(SITE): err("%s: нет og:image с абсолютным адресом" % rel)
    if not p_.metas.get("description") or not p_.title.strip(): err("%s: нет title или description" % rel)
    if re.search(r'name="robots"[^>]*noindex', t_): err("%s: noindex на странице типа" % rel)
    if PT.MARK not in t_: err("%s: нет метки генератора" % rel)
    for field in (p_.title, p_.metas.get("og:title", ""), p_.metas.get("twitter:title", "")):
        if FORBID.search(field): err("%s: в заголовке название, которое относится только к станциям или запрещено" % rel)
    for i in p_.imgs:
        if "alt" not in i or not (i.get("width") and i.get("height")): err("%s: img без alt, width или height: %s" % (rel, i.get("src")))
    blocks_ld = []
    for raw_ld in p_.ld:
        try: blocks_ld.append(json.loads(raw_ld))
        except Exception as e: err("%s: JSON-LD не парсится: %s" % (rel, e))
    graph_ = [n for b in blocks_ld for n in (b.get("@graph") or [b])]
    crumbs_ = [n for n in graph_ if n.get("@type") == "BreadcrumbList"]
    if len(crumbs_) != 1 or len(crumbs_[0].get("itemListElement", [])) != (2 if is_list else 3): err("%s: хлебные крошки в JSON-LD: нужно %d элемента" % (rel, 2 if is_list else 3))
    if "breadcrumbs" not in t_: err("%s: нет видимых хлебных крошек" % rel)
    if is_list:
        lists_ = [n for n in graph_ if n.get("@type") == "ItemList"]
        folder = rel.split("/")[0]
        tkey_ = next(k for k, v in PT.load_registry().items() if v["folder"] == folder)
        n_active = sum(1 for q in PT.load_products(tkey_) if q["_active"])
        if len(lists_) != 1 or len(lists_[0].get("itemListElement", [])) != n_active: err("%s: ItemList должен содержать %d активных товаров" % (rel, n_active))
    else:
        prods_ = [n for n in graph_ if n.get("@type") == "Product"]
        if len(prods_) != 1: err("%s: нужен один Product" % rel); continue
        n = prods_[0]
        for k in ("name", "sku", "mpn", "url", "description"):
            if not n.get(k): err("%s: у Product нет %s" % (rel, k))
        if not (n.get("brand") or {}).get("name"): err("%s: у Product нет brand.name" % rel)
        q = next(q for q in sum((PT.load_products(k) for k in PT.load_registry()), []) if q["_rel"] == rel)
        has_price = bool(q.get("price_rub")) and q["status"] == "active"
        if bool(n.get("offers")) != has_price: err("%s: Offer должен быть только у активного товара с ценой" % rel)
        if q["status"] == "discontinued" and "снято с продажи" not in re.sub(r"\s+", " ", " ".join(p_.text)).lower(): err("%s: у снятого с продажи товара нет пометки" % rel)
        if q["status"] == "discontinued" and any(u.endswith(rel) for u in locs): err("%s: снятый с продажи товар не должен быть в sitemap.xml" % rel)
        for c in q.get("compatible_with", []):
            cb = PT.combo_of(c)
            if cb and ("../models/%s.html" % cb["id"].lower()) not in t_: err("%s: нет ссылки на совместимую станцию %s" % (rel, c))
for r in PT.load_redirects():
    if r["code"] == 301:
        path = PT.ROOT / (r["from"].lstrip("/") + ("index.html" if r["from"].endswith("/") else ""))
        if not path.exists() or PT.MARK_REDIRECT not in path.read_text(encoding="utf-8") or ('rel="canonical" href="%s"' % (SITE.rstrip("/") + r["to"])) not in path.read_text(encoding="utf-8"):
            err("редирект %s: нет запасной страницы с canonical на %s" % (r["from"], r["to"]))
caddy = (ROOT / "bot" / "deploy" / "redirects.caddy")
if not caddy.exists() or any(r["from"] not in caddy.read_text(encoding="utf-8") for r in PT.load_redirects()): err("bot/deploy/redirects.caddy: нет правил для всех записей redirects.json")
if len(locs) != len(set(locs)): err("sitemap.xml: адреса повторяются")
pages = pages + type_pages

print("страниц проверено: %d; адресов в sitemap.xml: %d" % (len(pages), len(locs)))
if errors:
    print("ОШИБОК: %d" % len(errors))
    for e in errors[:60]: print(" -", e)
    sys.exit(1)
print("seo_check: всё чисто")
