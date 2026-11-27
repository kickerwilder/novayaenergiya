#!/usr/bin/env python3
"""Генератор страниц новых типов товаров и редиректов: python scripts/build_product_types.py (также вызывается из build_all.py).

Что делает (всё по данным из data/source/: реестр типов, товары, urls_published.json, redirects.json; описание схемы в scripts/product_types.py):
  1. защита индексации: адрес из urls_published.json, который больше не генерируется и не указан в redirects.json, останавливает сборку;
  2. страницы типов: <папка>/index.html (список, ItemList) и <папка>/<slug>.html (товар, Product); товар попадает на сайт только если название типа и
     товара утверждено (naming_approved) и статус active или discontinued; draft не генерируется; снятые с продажи остаются с пометкой и ссылками на замену;
  3. редиректы: bot/deploy/redirects.caddy (для Caddy, не публикуется) и запасные страницы с canonical и meta refresh для GitHub Pages (301);
  4. новые адреса sitemap.xml добавляются в urls_published.json.
Пока в реестре нет типов, сайт не меняется: ни страниц, ни ссылок. Страницы типов используют общие блоки (scripts/site_shell.py): шапку, подвал, чат, согласие на cookie.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analytics  # noqa: E402
import indexing  # noqa: E402
import product_types as PT  # noqa: E402
import site_shell as SH  # noqa: E402

ROOT = PT.ROOT
SEO = analytics.load()
CADDY_PATH = ROOT / "bot" / "deploy" / "redirects.caddy"
OG_DEFAULT = PT.SITE_URL + "img/og.jpg"
SKIP_DIRS = {".git", ".github", ".claude", "node_modules", "assets", "data", "bot", "scripts", "tests", "fonts", "img", "docs"}
TOP_JS = ('<script>\n(function(){var t=document.getElementById("toTop");if(!t)return;window.addEventListener("scroll",function(){if(window.scrollY>500)t.classList.add("visible");'
          'else t.classList.remove("visible")},{passive:true});t.addEventListener("click",function(){window.scrollTo({top:0,behavior:"smooth"})})})();\n</script>')

esc, num = PT.esc, PT.num


def write_if_changed(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    old = path.read_text(encoding="utf-8").replace("\r\n", "\n") if path.exists() else None
    if old == text:
        return False
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


def page(title, desc, canonical, og_image, ld, crumbs_html, content, og_type="product"):
    consent = analytics.consent_tag(SEO, "../")
    consent = (consent + "\n") if consent else ""
    robots = indexing.robots_meta()
    robots = ("\n" + robots) if robots else ""
    ld_json = json.dumps(ld, ensure_ascii=False, separators=(",", ":")).replace("<", chr(92) + "u003c")
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="format-detection" content="telephone=no">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{esc(canonical)}">{robots}
<meta property="og:type" content="{og_type}">
<meta property="og:site_name" content="{esc(SH.SITE_NAME)}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{esc(canonical)}">
<meta property="og:image" content="{esc(og_image)}">
<meta property="og:locale" content="ru_RU">
{SH.head_tail()}
<script type="application/ld+json">{ld_json}</script>
</head>
<body>
{SH.header(PT.nav_extra("../"))}

<div class="wrap">
  <nav class="breadcrumbs" aria-label="Хлебные крошки">
{crumbs_html}
  </nav>

{content}

  {SH.footer(analytics.settings_link(SEO))}
</div>

{SH.tail(consent)}
{TOP_JS}
{PT.MARK}
</body>
</html>
"""


def crumbs(items):
    """items: [(текст, адрес или None)]; последний элемент без ссылки."""
    out = []
    for i, (text, href) in enumerate(items):
        if i:
            out.append('    <span class="bc-sep">/</span>')
        out.append('    <a href="%s">%s</a>' % (esc(href), esc(text)) if href else "    <span>%s</span>" % esc(text))
    return "\n".join(out)


def breadcrumb_ld(items):
    return {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": u} for i, (n, u) in enumerate(items)]}


def stations_block(p):
    codes = p.get("compatible_with", [])
    ids, seen = [], set()
    for c in codes:
        cb = PT.combo_of(c)
        if cb and cb["id"] not in seen:
            seen.add(cb["id"]); ids.append(cb)
    if not ids:
        return ""
    lis = "".join('<li><a href="../models/%s.html">%s</a></li>' % (cb["id"].lower(), esc(cb["title"])) for cb in ids)
    return f'  <section class="model-sec">\n    <h2>Совместимо со станциями</h2>\n    <ul class="diff-list">{lis}</ul>\n  </section>\n\n'


def product_page(tkey, t, p):
    ctx = PT.template_context(t, p)
    title, desc, h1 = t["title_template"].format_map(ctx), t["description_template"].format_map(ctx), t["h1_template"].format_map(ctx)
    canonical = PT.SITE_URL + p["_rel"]
    base = PT.SITE_URL + t["folder"] + "/"
    fields = {f["key"]: f for f in t["fields"]}
    rows = '<tr><th>Артикул</th><td>%s</td></tr>' % esc(p["article"]) + "".join(
        '<tr><th>%s</th><td>%s</td></tr>' % (esc(f["label"]), esc(PT.fmt_value(f, p["fields"][f["key"]]))) for f in t["fields"] if f["key"] in p.get("fields", {}))
    img = (p.get("images") or [None])[0]
    og_image = (PT.SITE_URL + img["src"]) if img else OG_DEFAULT
    img_html = ('<div class="model-img-box"><img src="../%s" alt="%s" width="%d" height="%d" fetchpriority="high"></div>\n  ' % (esc(img["src"]), esc(img.get("alt", p["name"])), img["width"], img["height"])) if img else ""
    status_html = ""
    if p["status"] == "discontinued":
        rep = PT.resolve_replacements(p)
        links = "".join('<li><a href="../%s">%s</a></li>' % (esc(q["_rel"]), esc(q["name"])) for q in rep)
        status_html = ('  <section class="model-sec"><h2>Снято с продажи</h2><p>Этот товар снят с продажи.'
                       + (" Замена:</p><ul class=\"diff-list\">%s</ul>" % links if links else "</p>") + "</section>\n\n")
    price = p.get("price_rub", 0)
    price_html = ('<div class="model-price">%s ₽</div>' % num(price)) if (price and p["status"] == "active") else ('<div class="model-price">Цена по запросу</div>' if p["status"] == "active" else "")
    cta = ('<div class="model-cta"><a class="btn primary" href="tel:%s">Позвонить</a> <a class="btn" href="mailto:%s">Написать</a></div>' % (SH.PHONE, SH.EMAIL)) if p["status"] == "active" else ""
    faq = ""
    if p.get("faq"):
        faq = '  <section class="model-sec faq">\n    <h2>Частые вопросы</h2>\n' + "".join("    <details><summary>%s</summary><p>%s</p></details>\n" % (esc(q["q"]), esc(q["a"])) for q in p["faq"]) + "  </section>\n\n"
    lead = '<p class="lead">%s</p>' % esc(p["summary"]) if p.get("summary") else ""
    content = f"""  <div class="model-header">
    <h1>{esc(h1)}</h1>
    {lead}
    <div class="model-meta"><span class="badge art-chip">Артикул: {esc(p["article"])}</span>{'<span class="badge">Снято с продажи</span>' if p["status"] == "discontinued" else ""}</div>
  </div>

  {img_html}{price_html}
  {cta}

{status_html}  <section class="model-sec">
    <h2>Характеристики</h2>
    <table class="rt-table specs-table"><tbody>{rows}</tbody></table>
  </section>

{stations_block(p)}{faq}"""
    node = {"@type": "Product", "name": p["name"], "sku": p["article"], "mpn": p["article"], "url": canonical, "brand": {"@type": "Brand", "name": SH.SITE_NAME},
            "description": desc, "additionalProperty": [{"@type": "PropertyValue", "name": fields[k]["label"], "value": v, **({"unitText": fields[k]["unit"]} if fields[k]["unit"] else {})}
                                                         for k, v in p.get("fields", {}).items()]}
    if img:
        node["image"] = PT.SITE_URL + img["src"]
    if price and p["status"] == "active":
        node["offers"] = {"@type": "Offer", "priceCurrency": "RUB", "price": price, "availability": "https://schema.org/PreOrder"}
    ld = {"@context": "https://schema.org", "@graph": [breadcrumb_ld([("Главная", PT.SITE_URL), (t["name_plural"], base), (p["name"], canonical)]), node]}
    cr = crumbs([("Главная", "../index.html"), (t["name_plural"], "./"), (p["name"], None)])
    return page(title, desc, canonical, og_image, ld, cr, content)


def list_page(tkey, t):
    ctx = {"type_singular": t["name_singular"], "type_plural": t["name_plural"], "site": SH.SITE_NAME}
    title, desc, h1 = t["list_title_template"].format_map(ctx), t["list_description_template"].format_map(ctx), t["list_h1_template"].format_map(ctx)
    base = PT.SITE_URL + t["folder"] + "/"
    prods = PT.load_products(tkey)
    active = [p for p in prods if p["_active"]]
    gone = [p for p in prods if p["_generated"] and not p["_active"]]
    item = lambda p: '<li><a href="%s.html">%s</a>%s%s</li>' % (p["slug"], esc(p["name"]), (" — " + esc(p["summary"])) if p.get("summary") else "", (", %s ₽" % num(p["price_rub"])) if p.get("price_rub") and p["status"] == "active" else "")
    body = ""
    if active:
        body += '  <section class="model-sec">\n    <ul class="diff-list">%s</ul>\n  </section>\n\n' % "".join(item(p) for p in active)
    else:
        body += '  <section class="model-sec"><p>Все товары этого раздела сняты с продажи.</p></section>\n\n'
    if gone:
        body += '  <section class="model-sec">\n    <h2>Снято с продажи</h2>\n    <ul class="diff-list">%s</ul>\n  </section>\n\n' % "".join(item(p) for p in gone)
    intro = '<p class="lead">%s</p>' % esc(t["list_intro"]) if t["list_intro"] else ""
    content = f'  <div class="model-header">\n    <h1>{esc(h1)}</h1>\n    {intro}\n  </div>\n\n{body}'
    ld = {"@context": "https://schema.org", "@graph": [
        breadcrumb_ld([("Главная", PT.SITE_URL), (t["name_plural"], base)]),
        {"@type": "ItemList", "name": h1, "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": PT.SITE_URL + p["_rel"], "name": p["name"]} for i, p in enumerate(active)]}]}
    return page(title, desc, base, OG_DEFAULT, ld, crumbs([("Главная", "../index.html"), (t["name_plural"], None)]), content, og_type="website")


# ---------- редиректы ----------
def redirect_target_path(src):
    rel = src.lstrip("/")
    return ROOT / (rel + "index.html" if rel.endswith("/") or rel == "" else rel)


def redirect_page(to):
    robots = indexing.robots_meta()
    robots = ("\n" + robots) if robots else ""
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Страница перемещена | {SH.SITE_NAME}</title>
<link rel="canonical" href="{esc(PT.SITE_URL.rstrip('/') + to)}">{robots}
<meta http-equiv="refresh" content="0; url={esc(to)}">
</head>
<body>
<p>Страница перемещена: <a href="{esc(to)}">{esc(PT.SITE_URL.rstrip('/') + to)}</a></p>
{PT.MARK_REDIRECT}
</body>
</html>
"""


def caddy_fragment(reds):
    lines = ["# Сгенерировано scripts/build_product_types.py из data/source/redirects.json: не редактировать вручную; не публикуется на сайте.",
             "# Подключение: в блок основного домена bot/deploy/Caddyfile добавить строку «import redirects.caddy» (файл лежит рядом с Caddyfile на сервере).",
             "# Пока в redirects.json нет записей, файл пустой."]
    for i, r in enumerate(reds, 1):
        lines.append("@redirect%d path %s" % (i, r["from"]))
        if r["code"] == 301:
            lines.append("redir @redirect%d %s 301" % (i, r["to"]))
        else:   # respond выполняется после handle, поэтому без своего блока handle его перехватил бы общий handle сайта (было бы 404 вместо 410)
            lines += ["handle @redirect%d {" % i, '\trespond "Страница удалена" 410', "}"]
    return "\n".join(lines) + "\n"


def cleanup(keep):
    """Удаляет ранее сгенерированные файлы (по метке), которых больше нет в сборке."""
    removed = []
    for d in [ROOT] + [x for x in ROOT.iterdir() if x.is_dir() and x.name not in SKIP_DIRS]:
        touched = False
        for f in d.glob("*.html"):
            rel = f.relative_to(ROOT).as_posix()
            if rel in keep:
                continue
            try:
                head = f.read_text(encoding="utf-8")
            except Exception:
                continue
            if PT.MARK in head or PT.MARK_REDIRECT in head:
                f.unlink(); removed.append(rel); touched = True
        if touched and d != ROOT and not any(d.iterdir()):
            d.rmdir()
    return removed


def main():
    PT.load_registry()
    errors = PT.check_guard()
    if errors:
        print("ЗАЩИТА ИНДЕКСАЦИИ: сборка остановлена")
        for e in errors:
            print(" - " + e)
        sys.exit(1)
    changed, keep = 0, set()
    for k in PT.section_types():
        t = PT.load_registry()[k]
        for p in PT.load_products(k):
            if p["_generated"]:
                keep.add(p["_rel"]); changed += write_if_changed(ROOT / p["_rel"], product_page(k, t, p))
        keep.add(t["folder"] + "/index.html"); changed += write_if_changed(ROOT / t["folder"] / "index.html", list_page(k, t))
    reds = PT.load_redirects()
    for r in reds:
        if r["code"] == 301:
            path = redirect_target_path(r["from"])
            if path.exists() and not any(m in path.read_text(encoding="utf-8") for m in (PT.MARK_REDIRECT, PT.MARK)):   # заменять можно запасную страницу и ранее сгенерированную страницу товара
                sys.exit("redirects.json: %s существует как обычный файл, редирект не может его заменить" % r["from"])
            keep.add(path.relative_to(ROOT).as_posix()); changed += write_if_changed(path, redirect_page(r["to"]))
    changed += write_if_changed(CADDY_PATH, caddy_fragment(reds))
    removed = cleanup(keep)
    added = PT.update_urls_published()
    print("Типы товаров: разделов %d, страниц %d, редиректов %d; изменено файлов: %d; удалено устаревших: %d; новых адресов в urls_published.json: %d"
          % (len(PT.section_types()), len(keep) - sum(1 for r in reds if r["code"] == 301), len(reds), changed, len(removed), len(added)))


if __name__ == "__main__":
    main()
