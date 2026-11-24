"""Типы товаров сайта (солнечные панели, батарейные блоки, аксессуары) без переписывания генераторов: реестр, данные, статусы, адреса, защита индексации.

Источники (все в data/source/, на сайт не публикуются):
  product_types.json      реестр типов: папка, названия, поля характеристик, шаблоны title/description/h1, разметка, признак базы знаний бота;
  products/<тип>.json     товары типа;
  urls_published.json     все когда-либо опубликованные адреса (защита индексации);
  redirects.json          переезды и удаления адресов (301, 410).
Пока в реестре нет типов, этот модуль ничего не добавляет на сайт: ни страниц, ни ссылок, ни строк в sitemap.xml и kb.json.

Схема адресов (существующие адреса станций не меняются):
  /                          главная (каталог станций),   /privacy.html,   /models/<slug>.html   страницы станций (slug из мощности и ёмкости, как сейчас)
  /<папка типа>/             список товаров типа (папка латиницей в нижнем регистре, например panels, battery-packs, accessories)
  /<папка типа>/<slug>.html  страница товара; slug по умолчанию из артикула (нижний регистр, латиница, цифры, дефисы), задаётся один раз и не меняется
Хлебные крошки: страница станции: Главная / Каталог станций / название станции; страница списка: Главная / Названия типа (мн. число);
страница товара: Главная / Названия типа (мн. число) / название товара.
"""
import html
import json
import re
import string
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source"
TYPES_PATH = SRC / "product_types.json"
PRODUCTS_DIR = SRC / "products"
URLS_PATH = SRC / "urls_published.json"
REDIRECTS_PATH = SRC / "redirects.json"
SITE_URL = "https://novaya-energy.ru/"
SITE_NAME = "НОВАЯ ЭНЕРДЖИ"
MARK = "<!-- generated:product-types -->"
MARK_REDIRECT = "<!-- generated:redirect -->"

RESERVED_FOLDERS = {"models", "assets", "img", "data", "bot", "scripts", "tests", "fonts", "docs", "node_modules", "claude", "github"}
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
STATUSES = ("active", "discontinued", "draft")
# названия, которые относятся только к станциям или запрещены правилами наименований (наименование станций, слово «электростанция»)
FORBIDDEN_NAME = re.compile(r"портативн\w*\s+зарядн\w*\s+станци|электро[с]танц", re.I)


def fail(msg):
    raise SystemExit("Типы товаров: " + msg)


def esc(x):
    return html.escape(str(x), quote=True)


def num(n):
    return f"{n:,}".replace(",", " ")


def _read_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        fail("%s: некорректный JSON (%s)" % (path.relative_to(ROOT), type(e).__name__))


# ---------- каталог станций (для адресов и совместимости) ----------
_catalog = None


def catalog():
    global _catalog
    if _catalog is None:
        t = (ROOT / "data" / "catalog.js").read_text(encoding="utf-8")
        _catalog = json.loads(t[t.index("{"): t.rindex("}") + 1])["combos"]
    return _catalog


def combo_ids():
    return [c["id"] for c in catalog()]


def combo_of(code):
    """Z1600-5000-L или Z1600-5000 -> запись каталога или None."""
    cid = re.sub(r"-[DL]$", "", str(code).strip())
    return next((c for c in catalog() if c["id"] == cid), None)


# ---------- реестр типов ----------
_registry = None


def _check_template(label, tpl, allowed):
    try:
        names = {f[1] for f in string.Formatter().parse(tpl) if f[1]}
    except ValueError:
        fail("%s: некорректный шаблон" % label)
    bad = names - allowed
    if bad:
        fail("%s: неизвестные поля %s (допустимы %s)" % (label, sorted(bad), sorted(allowed)))


def load_registry():
    """Реестр типов (с проверкой). Пустой реестр (types = {}) допустим: тогда сайт не меняется."""
    global _registry
    if _registry is not None:
        return _registry
    data = _read_json(TYPES_PATH, {"types": {}})
    types = data.get("types")
    if not isinstance(types, dict):
        fail("product_types.json: поле types должно быть объектом")
    seen = {}
    for key, t in types.items():
        if not KEY_RE.match(key):
            fail("тип %r: ключ должен быть латиницей в нижнем регистре" % key)
        for req in ("folder", "name_singular", "name_plural", "fields", "title_template", "description_template", "h1_template"):
            if req not in t:
                fail("тип %s: нет поля %s" % (key, req))
        folder = t["folder"]
        if not SLUG_RE.match(folder) or folder in RESERVED_FOLDERS:
            fail("тип %s: папка %r недопустима (латиница в нижнем регистре, не из служебных: %s)" % (key, folder, sorted(RESERVED_FOLDERS)))
        if folder in seen:
            fail("тип %s: папка %r уже занята типом %s" % (key, folder, seen[folder]))
        seen[folder] = key
        if t.get("schema", "Product") != "Product":
            fail("тип %s: поддерживается разметка Product" % key)
        t.setdefault("schema", "Product")
        t.setdefault("in_bot_kb", False)
        t.setdefault("naming_approved", False)
        t.setdefault("nav_label", t["name_plural"])
        t.setdefault("list_title_template", "{type_plural} | {site}")
        t.setdefault("list_h1_template", "{type_plural}")
        t.setdefault("list_description_template", "{type_plural} {site}: характеристики, цены и совместимость со станциями.")
        t.setdefault("list_intro", "")
        if not isinstance(t["fields"], list):
            fail("тип %s: fields должен быть списком" % key)
        fkeys = set()
        for f in t["fields"]:
            if not KEY_RE.match(f.get("key", "")) or not f.get("label"):
                fail("тип %s: у поля нужны key (латиница) и label" % key)
            f.setdefault("unit", ""); f.setdefault("required", False)
            if f["key"] in fkeys:
                fail("тип %s: поле %s повторяется" % (key, f["key"]))
            fkeys.add(f["key"])
        allowed = {"name", "article", "type_singular", "type_plural", "site", "summary"} | {"f_" + k for k in fkeys}
        for tn in ("title_template", "description_template", "h1_template"):
            _check_template("тип %s, %s" % (key, tn), t[tn], allowed)
        allowed_list = {"type_singular", "type_plural", "site"}
        for tn in ("list_title_template", "list_description_template", "list_h1_template"):
            _check_template("тип %s, %s" % (key, tn), t[tn], allowed_list)
        if t["naming_approved"]:
            for what in ("name_singular", "name_plural", "nav_label", "title_template", "description_template", "h1_template", "list_title_template", "list_h1_template"):
                if FORBIDDEN_NAME.search(str(t[what])):
                    fail("тип %s: %s содержит название, которое относится только к станциям или запрещено правилами наименований" % (key, what))
    _registry = types
    return types


def fmt_value(field, v):
    """Значение поля для текста: число с разрядами и единицей, строка как есть."""
    if isinstance(v, bool):
        s = "да" if v else "нет"
    elif isinstance(v, int):
        s = num(v)
    elif isinstance(v, float):
        s = (("%.2f" % v).rstrip("0").rstrip(".")).replace(".", ",")
    else:
        s = str(v)
    return (s + " " + field["unit"]).strip() if field.get("unit") else s


# ---------- товары ----------
_products = {}


def slug_from_article(article):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", str(article).lower())).strip("-")


def load_products(tkey):
    """Товары типа (с проверкой). Черновики и неутверждённые названия проверяются поверхностно, остальные полностью."""
    if tkey in _products:
        return _products[tkey]
    t = load_registry()[tkey]
    data = _read_json(PRODUCTS_DIR / ("%s.json" % tkey), {"products": []})
    items = data.get("products")
    if not isinstance(items, list):
        fail("products/%s.json: products должен быть списком" % tkey)
    out, seen_art, seen_slug = [], set(), set()
    fields = {f["key"]: f for f in t["fields"]}
    for p in items:
        art = p.get("article")
        if not art or not isinstance(art, str):
            fail("%s: у товара нет article" % tkey)
        if art in seen_art:
            fail("%s: артикул %s повторяется" % (tkey, art))
        seen_art.add(art)
        status = p.get("status", "draft")
        if status not in STATUSES:
            fail("%s/%s: status должен быть одним из %s" % (tkey, art, STATUSES))
        p["status"] = status
        p["naming_approved"] = p.get("naming_approved") is True
        slug = p.get("slug") or slug_from_article(art)
        if not SLUG_RE.match(slug):
            fail("%s/%s: slug %r недопустим (латиница в нижнем регистре, цифры, дефисы)" % (tkey, art, slug))
        if slug in seen_slug or slug == "index":
            fail("%s/%s: slug %r повторяется или зарезервирован" % (tkey, art, slug))
        seen_slug.add(slug)
        p["slug"] = slug
        p["_rel"] = "%s/%s.html" % (t["folder"], slug)
        p["_type"] = tkey
        p["_generated"] = bool(t["naming_approved"] and p["naming_approved"] and status in ("active", "discontinued"))
        p["_active"] = p["_generated"] and status == "active"
        out.append(p)
        if not p["_generated"]:
            continue
        # полная проверка того, что попадёт на сайт
        if not p.get("name") or FORBIDDEN_NAME.search(p["name"]):
            fail("%s/%s: нужно утверждённое название (name), которое не относится к станциям и не содержит запрещённых слов" % (tkey, art))
        pf = p.get("fields", {})
        for k in pf:
            if k not in fields:
                fail("%s/%s: поле %s не описано в реестре типа" % (tkey, art, k))
        for k, f in fields.items():
            if f["required"] and k not in pf:
                fail("%s/%s: нет обязательного поля %s (%s)" % (tkey, art, k, f["label"]))
        if "price_rub" in p and (not isinstance(p["price_rub"], int) or p["price_rub"] < 0):
            fail("%s/%s: price_rub должен быть целым числом рублей" % (tkey, art))
        for img in p.get("images", []):
            if not (ROOT / img).exists():
                fail("%s/%s: нет файла изображения %s" % (tkey, art, img))
        for code in p.get("compatible_with", []):
            if not combo_of(code):
                fail("%s/%s: совместимость: неизвестная станция %r" % (tkey, art, code))
        for q in p.get("faq", []):
            if not q.get("q") or not q.get("a"):
                fail("%s/%s: в faq нужны q и a" % (tkey, art))
        ctx = template_context(t, p)
        for tn in ("title_template", "description_template", "h1_template"):
            if FORBIDDEN_NAME.search(t[tn].format_map(ctx)):
                fail("%s/%s: %s даёт название, которое относится только к станциям или запрещено" % (tkey, art, tn))
    _products[tkey] = out
    return out


def template_context(t, p):
    ctx = {"name": p.get("name", ""), "article": p["article"], "type_singular": t["name_singular"], "type_plural": t["name_plural"], "site": SITE_NAME, "summary": p.get("summary", "")}
    fields = {f["key"]: f for f in t["fields"]}
    for k, v in p.get("fields", {}).items():
        ctx["f_" + k] = fmt_value(fields[k], v)
    return ctx


def resolve_replacements(p):
    """replaced_by: артикулы товаров (любого типа), опубликованных и активных."""
    out = []
    for art in p.get("replaced_by", []):
        found = None
        for tk in load_registry():
            for q in load_products(tk):
                if q["article"] == art:
                    found = q
        if not found or not found["_active"]:
            fail("%s/%s: замена %s не найдена среди активных опубликованных товаров" % (p["_type"], p["article"], art))
        out.append(found)
    return out


# ---------- разделы, навигация, адреса ----------
def section_types():
    """Типы, у которых есть страницы: название типа утверждено и есть хотя бы один сгенерированный товар (активный или снятый)."""
    return [k for k, t in load_registry().items() if t["naming_approved"] and any(p["_generated"] for p in load_products(k))]


def nav_types():
    """Типы с пунктом навигации: есть хотя бы один активный опубликованный товар."""
    return [k for k in section_types() if any(p["_active"] for p in load_products(k))]


def type_pages(tkey):
    """Относительные пути страниц типа: список и товары (активные и снятые с продажи)."""
    t = load_registry()[tkey]
    return ["%s/index.html" % t["folder"]] + [p["_rel"] for p in load_products(tkey) if p["_generated"]]


def all_pages_rel():
    return [rel for k in section_types() for rel in type_pages(k)]


def static_urls():
    return ["/", "/privacy.html"] + ["/models/%s.html" % cid.lower() for cid in combo_ids()]


def url_of(rel):
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    return "/" + rel


def generated_urls():
    return set(static_urls()) | {url_of(rel) for rel in all_pages_rel()}


def sitemap_pages():
    """Страницы типов для sitemap.xml: список типа с активными товарами и сами активные товары (снятые и черновики не попадают)."""
    out = []
    for k in nav_types():
        t = load_registry()[k]
        out.append((SITE_URL + "%s/" % t["folder"], "%s/index.html" % t["folder"]))
        for p in load_products(k):
            if p["_active"]:
                out.append((SITE_URL + p["_rel"], p["_rel"]))
    return out


def sitemap_urls():
    return set(static_urls()) | {url_of(rel) for _, rel in sitemap_pages()}


def nav_extra(prefix):
    """Пункты навигации разделов (после «Каталог»); пустая строка, пока нет опубликованных товаров."""
    out = ""
    for k in nav_types():
        t = load_registry()[k]
        out += '\n      <a href="%s%s/" data-ptype="%s">%s</a>' % (prefix, t["folder"], k, esc(t["nav_label"]))
    return out


NAV_ITEM_RE = re.compile(r'\n      <a href="[^"]*" data-ptype="[^"]*">[^<]*</a>')


def apply_nav_to_index(text):
    """Идемпотентно вставляет пункты разделов в навигацию главной после «Каталог»; без разделов текст не меняется (ни маркеров, ни пустых строк)."""
    text = NAV_ITEM_RE.sub("", text)
    extra = nav_extra("")
    if not extra:
        return text
    anchor = '      <a href="#catalog">Каталог</a>'
    if text.count(anchor) != 1:
        fail("в index.html не найден пункт навигации «Каталог» (одна пара)")
    return text.replace(anchor, anchor + extra)


# ---------- совместимость ----------
def compat_products(cid):
    """Активные товары, совместимые со станцией (id комбинации, например Z1600-5000)."""
    out = []
    for k in nav_types():
        for p in load_products(k):
            if p["_active"] and any((combo_of(c) or {}).get("id") == cid for c in p.get("compatible_with", [])):
                out.append(p)
    return out


def compat_section(cid, prefix="../"):
    """Блок «Совместимые аксессуары» для страницы станции; пустая строка, если совместимых товаров нет (страница станции не меняется)."""
    items = compat_products(cid)
    if not items:
        return ""
    reg = load_registry()
    lis = "".join('<li><a href="%s%s/%s.html">%s</a> — %s%s</li>' % (
        prefix, reg[p["_type"]]["folder"], p["slug"], esc(p["name"]), esc(reg[p["_type"]]["name_singular"]),
        (", %s ₽" % num(p["price_rub"])) if p.get("price_rub") else "") for p in items)
    return '<section class="model-sec"><h2>Совместимые аксессуары</h2><ul class="diff-list">%s</ul></section>\n\n  ' % lis


# ---------- база знаний бота ----------
def kb_entries():
    """Записи для kb.json: только типы с in_bot_kb = true (по умолчанию ни одного: kb.json не меняется)."""
    out = []
    for k, t in load_registry().items():
        if not t["in_bot_kb"] or k not in nav_types():
            continue
        for p in load_products(k):
            if p["_active"]:
                out.append({"type": k, "article": p["article"], "name": p["name"], "url": SITE_URL + p["_rel"], "price_rub": p.get("price_rub", 0),
                            "fields": p.get("fields", {}), "compatible_with": p.get("compatible_with", [])})
    return out


# ---------- защита индексации: опубликованные адреса и редиректы ----------
def load_urls_published():
    d = _read_json(URLS_PATH, {"urls": []})
    urls = d.get("urls")
    if not isinstance(urls, list) or not all(isinstance(u, str) and u.startswith("/") for u in urls):
        fail("urls_published.json: urls должен быть списком адресов, начинающихся с «/»")
    return urls


def load_redirects():
    d = _read_json(REDIRECTS_PATH, {"redirects": []})
    items = d.get("redirects")
    if not isinstance(items, list):
        fail("redirects.json: redirects должен быть списком")
    seen = set()
    for r in items:
        src, code = r.get("from"), r.get("code")
        if not isinstance(src, str) or not src.startswith("/") or not (src.endswith(".html") or src.endswith("/")):
            fail("redirects.json: from должен быть адресом, начинающимся с «/» и оканчивающимся на .html или «/»: %r" % src)
        if code not in (301, 410):
            fail("redirects.json: code для %s должен быть 301 или 410" % src)
        if code == 301 and not (isinstance(r.get("to"), str) and r["to"].startswith("/")):
            fail("redirects.json: для 301 нужен адрес to, начинающийся с «/» (%s)" % src)
        if src in seen:
            fail("redirects.json: адрес %s указан дважды" % src)
        seen.add(src)
    return items


def check_guard():
    """Список ошибок защиты индексации (пустой, если всё в порядке)."""
    errors = []
    gen = generated_urls()
    reds = {r["from"]: r for r in load_redirects()}
    for u in load_urls_published():
        if u not in gen and u not in reds:
            errors.append("адрес %s был опубликован, но больше не генерируется и не указан в data/source/redirects.json (нужен 301 на новый адрес или 410)" % u)
    for src, r in reds.items():
        if src in gen:
            errors.append("redirects.json: %s всё ещё генерируется как страница; уберите запись или страницу" % src)
        if r["code"] == 301 and r["to"] not in gen:
            errors.append("redirects.json: цель 301 %s (из %s) не генерируется сайтом" % (r["to"], src))
    return errors


def update_urls_published():
    """Добавляет в urls_published.json новые адреса из sitemap.xml (при публикации); возвращает список добавленных."""
    cur = load_urls_published()
    new = sorted(sitemap_urls() - set(cur))
    if new or not URLS_PATH.exists():
        allu = sorted(set(cur) | set(new), key=lambda u: (u != "/", u))
        data = {"_about": "Все когда-либо опубликованные адреса сайта (из sitemap.xml). Адрес из списка нельзя просто перестать генерировать: нужна запись в redirects.json "
                          "(301 на новый адрес или 410). Новые адреса добавляет сборка (scripts/build_product_types.py) сама.", "urls": allu}
        URLS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    return new
