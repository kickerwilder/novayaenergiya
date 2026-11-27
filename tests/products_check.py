#!/usr/bin/env python3
"""Проверка инфраструктуры типов товаров: python tests/products_check.py [--baseline-ref REF]

Все сценарии идут на ВРЕМЕННЫХ копиях репозитория; вымышленные типы и товары (панель, батарейный блок) существуют только в тесте и в репозиторий не попадают.
  а) нулевой эффект: при реестре без типов сборка копии побайтно совпадает с файлами репозитория (31 страница, sitemap.xml, robots.txt, kb.json, 404.html);
     с --baseline-ref REF сравнение идёт с версией из git (например, feat/model-unique): доказывает, что инфраструктура ничего не изменила;
     то же при реестре, где ничего не опубликовано (черновики, название не утверждено, пустой тип);
  б) тестовые типы: страницы списка и товаров, хлебные крошки, JSON-LD (Product, ItemList, BreadcrumbList), ссылки совместимости в обе стороны, пункты навигации,
     sitemap.xml (без draft, discontinued и неутверждённых), статус discontinued (пометка, замена), naming_approved: false, пустой тип без страниц, повторная
     сборка без изменений, tests/seo_check.py на копии, база знаний бота (in_bot_kb);
  в) защита индексации: адрес из urls_published.json без генерации и без записи в redirects.json роняет сборку; с записью 301 или 410 проходит, генерируются
     запасная страница и фрагмент для Caddy; цель 301, которой нет на сайте, роняет сборку;
  г) названия: запрещённые для новых типов формулировки (наименование станций, слово «электростанция») останавливают сборку.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
errors, passed = [], 0
SITE = "https://novaya-energy.ru"
# вымышленные слова, которых нет в репозитории: проверка запретов на названия строится из частей, чтобы тест сам не содержал запрещённых формулировок
BAD_STATION_NAME = "Тестовая " + "электро" + "станция"
BAD_STATION_PHRASE = "Внешний аккумулятор (портативная " + "зарядная станция) ТП"


def check(cond, msg):
    global passed
    if cond: passed += 1
    else: errors.append(msg); print("  FAIL:", msg)


def copy_repo():
    tmp = Path(tempfile.mkdtemp(prefix="ne_ptypes_"))
    dst = tmp / "site"
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns("node_modules", "__pycache__", "dist"))   # .git остаётся: lastmod в sitemap.xml берётся из git-дат
    return tmp, dst


def build(site):
    r = subprocess.run([sys.executable, str(site / "scripts" / "build_all.py")], cwd=str(site), capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    return r.returncode, r.stdout + r.stderr


def run_py(site, *args):
    r = subprocess.run([sys.executable] + [str(a) for a in args], cwd=str(site), capture_output=True, text=True, encoding="utf-8", errors="replace", env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    return r.returncode, r.stdout + r.stderr


def tree_hash(site):
    h = hashlib.sha1()
    for p in sorted(site.rglob("*")):
        if p.is_file() and not any(x in p.parts for x in ("__pycache__", "node_modules")):
            h.update(p.relative_to(site).as_posix().encode()); h.update(p.read_bytes())
    return h.hexdigest()


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")


def read(p):
    return Path(p).read_text(encoding="utf-8")


OUTPUTS = ["index.html", "privacy.html", "404.html", "robots.txt", "sitemap.xml", "data/kb.json"]


def outputs(site):
    return OUTPUTS + ["models/%s" % p.name for p in sorted((site / "models").glob("*.html"))]


def fixture(site, in_bot_kb=False):
    """Вымышленные типы: панель (есть активные, снятый, черновик, неутверждённый), батарейный блок, пустой тип."""
    base = {"schema": "Product", "naming_approved": True, "title_template": "{name} — цена | {site}", "description_template": "{name}: {f_power_w}. {summary}", "h1_template": "{name}",
            "fields": [{"key": "power_w", "label": "Мощность", "unit": "Вт", "required": True}, {"key": "voltage_v", "label": "Напряжение", "unit": "В", "required": False}]}
    types = {
        "panel": dict(base, folder="panels", name_singular="Солнечная панель", name_plural="Солнечные панели", nav_label="Солнечные панели", in_bot_kb=False),
        "battery": dict(base, folder="battery-packs", name_singular="Батарейный блок", name_plural="Батарейные блоки", nav_label="Батарейные блоки", in_bot_kb=in_bot_kb),
        "empty": dict(base, folder="accessories", name_singular="Аксессуар", name_plural="Аксессуары", nav_label="Аксессуары"),
    }
    write_json(site / "data" / "source" / "product_types.json", {"types": types})
    prod = lambda art, name, status="active", approved=True, **kw: dict({"article": art, "name": name, "status": status, "naming_approved": approved, "fields": {"power_w": 100}, "summary": "Вымышленный товар для проверки."}, **kw)
    write_json(site / "data" / "source" / "products" / "panel.json", {"products": [
        prod("TP-100", "Тестовая панель TP-100", price_rub=12345, fields={"power_w": 100, "voltage_v": 18}, compatible_with=["Z1600-5000-L", "Z800-1500"], faq=[{"q": "Вопрос про TP-100?", "a": "Ответ про TP-100."}]),
        prod("TP-200", "Тестовая панель TP-200"),
        prod("TP-OLD", "Тестовая панель TP-OLD", status="discontinued", replaced_by=["TP-200"], price_rub=9999),
        prod("TP-DRAFT", "Тестовая панель TP-DRAFT", status="draft"),
        prod("TP-NEW", "Тестовая панель TP-NEW", approved=False),
    ]})
    write_json(site / "data" / "source" / "products" / "battery.json", {"products": [
        prod("BB-1", "Тестовый батарейный блок BB-1", price_rub=20000, fields={"power_w": 2000}, compatible_with=["Z4000-8600-L"])]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline-ref", default=None, help="git-ссылка, с версией которой сравнивается результат сборки (например, feat/model-unique)")
    a = ap.parse_args()
    keep = []

    # ---------- а) нулевой эффект ----------
    print("а) нулевой эффект: пустой реестр")
    tmp, site = copy_repo(); keep.append(tmp)
    rc, out = build(site); check(rc == 0, "сборка с пустым реестром упала: " + out[-300:])
    same = [f for f in outputs(site) if read(site / f).replace("\r\n", "\n") != read(ROOT / f).replace("\r\n", "\n")]
    check(not same, "после сборки копии изменились файлы репозитория: %s" % same[:5])
    sm = re.findall(r"<loc>(.*?)</loc>", read(site / "sitemap.xml"))
    check(len(sm) == 31, "в sitemap.xml должно быть 31 адрес, а не %d" % len(sm))
    extra_dirs = [p.name for p in site.iterdir() if p.is_dir() and p.name in ("panels", "battery-packs", "accessories")]
    check(not extra_dirs, "при пустом реестре появились папки типов: %s" % extra_dirs)
    check("data-ptype" not in read(site / "index.html"), "в index.html есть пункт навигации раздела при пустом реестре")
    kb = json.loads(read(site / "data" / "kb.json")); check("products" not in kb, "в kb.json появился ключ products при пустом реестре")
    urls = json.loads(read(site / "data" / "source" / "urls_published.json"))["urls"]
    check(len(urls) == 31 and urls[0] == "/" and "/privacy.html" in urls and sum(1 for u in urls if u.startswith("/models/")) == 29, "urls_published.json: должно быть 31 адрес (главная, privacy, 29 моделей)")
    if a.baseline_ref:
        bad = []
        for f in outputs(site):
            r = subprocess.run(["git", "show", "%s:%s" % (a.baseline_ref, f)], cwd=str(ROOT), capture_output=True)
            if r.returncode or r.stdout.replace(b"\r\n", b"\n") != (site / f).read_bytes().replace(b"\r\n", b"\n"):
                bad.append(f)
        check(not bad, "результат сборки отличается от %s: %s" % (a.baseline_ref, bad[:5]))
        print("   сравнено с %s: %d файлов, различий %d" % (a.baseline_ref, len(outputs(site)), len(bad)))

    print("   реестр с типами, но ничего не опубликовано (черновики, название не утверждено, пустой тип)")
    fixture(site)
    ptj = json.loads(read(site / "data" / "source" / "product_types.json"))
    for t in ptj["types"].values(): t["naming_approved"] = False
    write_json(site / "data" / "source" / "product_types.json", ptj)
    rc, out = build(site); check(rc == 0, "сборка упала: " + out[-300:])
    same = [f for f in outputs(site) if read(site / f).replace("\r\n", "\n") != read(ROOT / f).replace("\r\n", "\n")]
    check(not same, "при неутверждённых типах изменились файлы: %s" % same[:5])
    check(not any((site / d).exists() for d in ("panels", "battery-packs", "accessories")), "при неутверждённых типах созданы папки")

    # ---------- б) тестовые типы ----------
    print("б) тестовые типы (панель, батарейный блок, пустой тип)")
    tmp2, site = copy_repo(); keep.append(tmp2)
    fixture(site)
    rc, out = build(site); check(rc == 0, "сборка с тестовыми типами упала: " + out[-500:])
    P = lambda rel: site / rel
    for rel in ("panels/index.html", "panels/tp-100.html", "panels/tp-200.html", "panels/tp-old.html", "battery-packs/index.html", "battery-packs/bb-1.html"):
        check(P(rel).exists(), "нет страницы %s" % rel)
    for rel in ("panels/tp-draft.html", "panels/tp-new.html", "accessories/index.html"):
        check(not P(rel).exists(), "страница %s не должна создаваться (draft, не утверждено или пустой тип)" % rel)
    check(not P("accessories").exists(), "пустой тип создал папку")
    sm = set(re.findall(r"<loc>(.*?)</loc>", read(P("sitemap.xml"))))
    want = {SITE + "/panels/", SITE + "/panels/tp-100.html", SITE + "/panels/tp-200.html", SITE + "/battery-packs/", SITE + "/battery-packs/bb-1.html"}
    check(want <= sm and len(sm) == 36, "sitemap.xml: ожидались 31 + 5 адресов, получено %d, нет: %s" % (len(sm), sorted(want - sm)))
    for bad in ("tp-old", "tp-draft", "tp-new", "accessories"):
        check(not any(bad in u for u in sm), "в sitemap.xml попало %s" % bad)
    idx = read(P("index.html")); mdl = read(P("models/z1600-5000.html"))
    check('data-ptype="panel"' in idx and 'data-ptype="battery"' in idx and 'data-ptype="empty"' not in idx, "пункты навигации на главной: только разделы с опубликованными товарами")
    check('href="../panels/" data-ptype="panel"' in mdl, "пункт навигации раздела на странице станции")
    pp = read(P("panels/tp-100.html"))
    check(len(re.findall(r'class="bc-sep"', pp)) == 2 and 'href="./">Солнечные панели<' in pp and "Тестовая панель TP-100</span>" in pp, "хлебные крошки страницы товара: Главная / Солнечные панели / название")
    ld = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', pp, re.S).group(1))["@graph"]
    prod = next(n for n in ld if n["@type"] == "Product"); crumbs = next(n for n in ld if n["@type"] == "BreadcrumbList")
    check(prod["sku"] == "TP-100" and prod["offers"]["price"] == 12345 and prod["brand"]["name"] == "НОВАЯ ЭНЕРДЖИ" and len(crumbs["itemListElement"]) == 3, "JSON-LD Product и BreadcrumbList страницы товара")
    check("offers" not in next(n for n in json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', read(P("panels/tp-200.html")), re.S).group(1))["@graph"] if n["@type"] == "Product"), "у товара без цены нет Offer")
    check("<title>Тестовая панель TP-100 — цена | НОВАЯ ЭНЕРДЖИ</title>" in pp and "<h1>Тестовая панель TP-100</h1>" in pp, "title и h1 по шаблонам типа")
    lp = read(P("panels/index.html"))
    ldl = json.loads(re.search(r'<script type="application/ld\+json">(.*?)</script>', lp, re.S).group(1))["@graph"]
    il = next(n for n in ldl if n["@type"] == "ItemList")
    check([e["url"] for e in il["itemListElement"]] == [SITE + "/panels/tp-100.html", SITE + "/panels/tp-200.html"], "ItemList списка: только активные товары по порядку")
    check('href="tp-100.html"' in lp and "Снято с продажи" in lp and 'href="tp-old.html"' in lp, "список: активные товары и блок «Снято с продажи»")
    old = read(P("panels/tp-old.html"))
    check("Снято с продажи" in old and 'href="../panels/tp-200.html"' in old and '"offers"' not in old, "снятый товар: пометка, ссылка на замену, без Offer")
    check('href="../models/z1600-5000.html"' in pp and 'href="../models/z800-1500.html"' in pp, "страница товара ссылается на совместимые станции")
    check("Совместимые аксессуары" in mdl and 'href="../panels/tp-100.html"' in mdl, "страница станции ссылается на совместимый аксессуар")
    check("Совместимые аксессуары" in read(P("models/z800-1500.html")) and "Совместимые аксессуары" in read(P("models/z4000-8600.html")), "совместимость по коду комбинации и по коду версии")
    check("Совместимые аксессуары" not in read(P("models/z2000-5000.html")) and "tp-old" not in read(P("models/z1600-5000.html")), "станции без совместимых товаров не меняются; снятый товар не рекламируется")
    kb = json.loads(read(P("data/kb.json"))); check("products" not in kb, "in_bot_kb = false: kb.json не меняется")
    check(read(P("data/kb.json")) == read(ROOT / "data" / "kb.json"), "kb.json побайтно прежний при in_bot_kb = false")
    up = json.loads(read(P("data/source/urls_published.json")))["urls"]
    check(len(up) == 36 and "/panels/" in up and "/panels/tp-old.html" not in up, "urls_published.json пополнился адресами sitemap (36), снятый товар не добавлен как новый адрес")
    h1 = tree_hash(site); rc, out = build(site); h2 = tree_hash(site)
    check(rc == 0 and h1 == h2, "повторная сборка изменила файлы")
    rc, out = run_py(site, "tests/seo_check.py"); check(rc == 0, "seo_check на копии с тестовыми типами: " + out[-400:])
    rc, out = run_py(site, "scripts/indexnow.py", "--new-only", "--known", site / "data" / "source" / "urls_published.json")
    check(rc == 0 and "новых адресов 0" in out, "indexnow --new-only: после публикации новых адресов нет: " + out[-200:])

    print("   база знаний бота: только по флагу типа")
    fixture(site, in_bot_kb=True); rc, out = build(site); check(rc == 0, "сборка in_bot_kb=true: " + out[-300:])
    kb2 = json.loads(read(P("data/kb.json")))
    check([e["article"] for e in kb2.get("products", [])] == ["BB-1"] and all(kb2[k] == kb[k] for k in kb), "in_bot_kb = true: в kb.json только товары этого типа, остальное без изменений")

    # ---------- в) защита индексации ----------
    print("в) защита индексации и редиректы")
    fixture(site); rc, out = build(site); check(rc == 0, "возврат к in_bot_kb=false")
    prods = json.loads(read(P("data/source/products/panel.json")))
    for q in prods["products"]:
        if q["article"] == "TP-100": q["status"] = "draft"
    write_json(P("data/source/products/panel.json"), prods)
    rc, out = build(site)
    check(rc != 0 and "/panels/tp-100.html" in out and "redirects.json" in out, "адрес без генерации и без редиректа должен ронять сборку: rc=%d %s" % (rc, out[-300:]))
    rc2, out2 = run_py(site, "tests/seo_check.py"); check(rc2 != 0 and "защита индексации" in out2, "seo_check должен падать на том же: " + out2[-300:])
    write_json(P("data/source/redirects.json"), {"redirects": [{"from": "/panels/tp-100.html", "to": "/panels/tp-200.html", "code": 301}]})
    rc, out = build(site); check(rc == 0, "с записью 301 сборка должна проходить: " + out[-400:])
    fb = read(P("panels/tp-100.html")) if P("panels/tp-100.html").exists() else ""
    check('rel="canonical" href="%s/panels/tp-200.html"' % SITE in fb and 'http-equiv="refresh" content="0; url=/panels/tp-200.html"' in fb and "generated:redirect" in fb, "запасная страница для Pages: canonical и meta refresh")
    cd = read(P("bot/deploy/redirects.caddy"))
    check("@redirect1 path /panels/tp-100.html" in cd and "redir @redirect1 /panels/tp-200.html 301" in cd, "фрагмент для Caddy: правило 301")
    check(SITE + "/panels/tp-100.html" not in read(P("sitemap.xml")), "адрес с редиректом не должен быть в sitemap.xml")
    rc, out = run_py(site, "tests/seo_check.py"); check(rc == 0, "seo_check с редиректом: " + out[-300:])
    write_json(P("data/source/redirects.json"), {"redirects": [{"from": "/panels/tp-100.html", "code": 410}]})
    rc, out = build(site)
    check(rc == 0 and not P("panels/tp-100.html").exists() and 'handle @redirect1 {\n\trespond "Страница удалена" 410\n}' in read(P("bot/deploy/redirects.caddy")).replace("\r\n", "\n"), "410: запасная страница удалена, правило Caddy в блоке handle (без него общий handle перехватывает и отдаёт 404): " + out[-200:])
    write_json(P("data/source/redirects.json"), {"redirects": [{"from": "/panels/tp-100.html", "to": "/panels/net-takoj.html", "code": 301}]})
    rc, out = build(site); check(rc != 0 and "net-takoj" in out, "цель 301, которой нет на сайте, должна ронять сборку")
    write_json(P("data/source/redirects.json"), {"redirects": [{"from": "/panels/tp-100.html", "code": 410}]})
    # станция: удалённая страница модели без редиректа
    up = json.loads(read(P("data/source/urls_published.json"))); up["urls"].append("/models/z999-999.html"); write_json(P("data/source/urls_published.json"), up)
    rc, out = build(site); check(rc != 0 and "/models/z999-999.html" in out, "адрес станции из списка опубликованных без страницы и без редиректа: сборка падает")
    write_json(P("data/source/redirects.json"), {"redirects": [{"from": "/panels/tp-100.html", "code": 410}, {"from": "/models/z999-999.html", "to": "/models/z800-1500.html", "code": 301}]})
    rc, out = build(site); check(rc == 0 and "z800-1500.html" in read(P("models/z999-999.html")), "301 для адреса станции: сборка проходит, запасная страница создана: " + out[-200:])

    # ---------- г) названия ----------
    print("г) запрещённые названия")
    for what, name in (("слово «электростанция» в названии товара", BAD_STATION_NAME), ("наименование станций в названии товара", BAD_STATION_PHRASE)):
        tmp3, site3 = copy_repo(); keep.append(tmp3)
        fixture(site3)
        prods = json.loads(read(site3 / "data" / "source" / "products" / "panel.json")); prods["products"][1]["name"] = name
        write_json(site3 / "data" / "source" / "products" / "panel.json", prods)
        rc, out = build(site3)
        check(rc != 0 and "TP-200" in out and "названия" in out.lower() + "названия", "%s должно останавливать сборку: rc=%d %s" % (what, rc, out[-200:]))
    tmp4, site4 = copy_repo(); keep.append(tmp4)
    fixture(site4)
    ptj = json.loads(read(site4 / "data" / "source" / "product_types.json")); ptj["types"]["panel"]["name_plural"] = BAD_STATION_NAME + "и"
    write_json(site4 / "data" / "source" / "product_types.json", ptj)
    rc, out = build(site4); check(rc != 0 and "panel" in out, "запрещённое название типа останавливает сборку: " + out[-200:])
    tmp5, site5 = copy_repo(); keep.append(tmp5)
    fixture(site5)
    ptj = json.loads(read(site5 / "data" / "source" / "product_types.json")); ptj["types"]["panel"]["folder"] = "models"
    write_json(site5 / "data" / "source" / "product_types.json", ptj)
    rc, out = build(site5); check(rc != 0 and "models" in out, "папка типа не должна совпадать с адресами станций (models): " + out[-200:])

    for t in keep: shutil.rmtree(t, ignore_errors=True)
    print("\nпроверок пройдено: %d, ошибок: %d" % (passed, len(errors)))
    if errors:
        for e in errors[:40]: print(" -", e)
        sys.exit(1)
    print("products_check: всё чисто")


if __name__ == "__main__":
    main()
