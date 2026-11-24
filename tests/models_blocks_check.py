#!/usr/bin/env python3
"""Проверка новых текстовых блоков страниц моделей (scripts/build_models.py): python tests/models_blocks_check.py

Блоки: «Чем отличаются два корпуса», «Зарядка и стоимость 1 Вт·ч» / «Стоимость 1 Вт·ч», «Что и сколько часов», «Частые вопросы об этой модели».
Правила:
  1) вопрос FAQ называется по тому, что реально в ответе: «весит» только если в ответе есть вес (кг), «габарит» только если есть размеры (см);
  2) время зарядки в новом блоке только для версий с basis passport и estimate (диапазоны range остаются в прежних местах страницы);
     у страниц без такого времени блок называется «Стоимость 1 Вт·ч»;
  3) числа XT90 версий, у которых они помечены unconfirmed (dc_connectors), в новых блоках не выводятся (в прежних частях страницы остаются);
  4) вес, который помечен unconfirmed, в новых блоках не выводится;
  5) конкретно z4000-10000: нет «весит», нет килограммов, есть габариты обоих корпусов.
"""
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import build_models as B  # noqa: E402

errors, passed = [], 0


def check(cond, msg):
    global passed
    if cond: passed += 1
    else: errors.append(msg); print("  FAIL:", msg)


def text(s):
    return html.unescape(re.sub(r"<[^>]+>", " ", s))


def new_sections(page_html):
    """Только новые блоки уникализации: {заголовок: html секции}."""
    out = {}
    for m in re.finditer(r'<section class="model-sec[^"]*">(.*?)</section>', page_html, re.S):
        h = re.search(r"<h2>(.*?)</h2>", m.group(1))
        title = re.sub(r"<[^>]+>", "", h.group(1)) if h else ""
        if re.match(r"(Чем отличаются|Зарядка и стоимость|Стоимость 1 Вт|Что и сколько|Частые вопросы об этой модели)", title):
            out[title] = m.group(1)
    return out


data, prices, charge = B.load_data()
for c in data["combos"]:
    cid = c["id"].lower()
    page = (ROOT / "models" / f"{cid}.html").read_text(encoding="utf-8")
    secs = new_sections(page)
    codes = [v["code"] for v in c["vers"].values()]
    bases = {k: (charge.get(v["code"]) or {}).get("basis") for k, v in c["vers"].items()}
    # 1) вопросы FAQ соответствуют ответам
    faq = secs.get("Частые вопросы об этой модели", "")
    for q, a in re.findall(r"<summary>(.*?)</summary><p>(.*?)</p>", faq, re.S):
        q, a = html.unescape(q), text(a)
        if "весит" in q: check("кг" in a, f"{cid}: вопрос «{q}» про вес, а в ответе нет веса")
        if "габарит" in q: check("см" in a, f"{cid}: вопрос «{q}» про габариты, а в ответе нет размеров")
        if "весит" not in q: check(not re.search(r"\bвес\s+\d", a, re.I), f"{cid}: в ответе на «{q}» есть вес, а вопрос про него не говорит")
        if "габарит" not in q and "весит" in q: check("размеры" not in a, f"{cid}: в ответе на «{q}» есть размеры, а вопрос про них не говорит")
    # 2) время зарядки только для passport и estimate
    cs = secs.get("Зарядка и стоимость 1 Вт·ч") or secs.get("Стоимость 1 Вт·ч") or ""
    has_time = "Время зарядки" in cs
    want_time = any(b in ("passport", "estimate") for b in bases.values())
    check(has_time == want_time, f"{cid}: время зарядки в новом блоке {'есть' if has_time else 'нет'}, а по charge.js должно быть {'есть' if want_time else 'нет'} ({bases})")
    check(("Зарядка и стоимость 1 Вт·ч" in secs) == want_time and ("Стоимость 1 Вт·ч" in secs or "Зарядка и стоимость 1 Вт·ч" in secs), f"{cid}: заголовок блока не соответствует содержимому")
    check(not re.search(r"\d–\d[\d,]* ч", text(cs)), f"{cid}: диапазон времени зарядки попал в новый блок")
    # 3, 4) спорные поля не попадают в новые блоки
    blob = " ".join(text(x) for x in secs.values())
    for k, v in c["vers"].items():
        code = v["code"]
        sp = B.SPECS[code]
        if not B.spec_ok(code, "dc_connectors") and sp.get("dc_connectors"):
            check("XT90" not in blob, f"{cid}: XT90 в новых блоках при unconfirmed dc_connectors ({code})")
        if not B.spec_ok(code, "weight_kg") and sp.get("weight_kg"):
            check(not re.search(rf"вес\w*\s+{re.escape(B.fnum(sp['weight_kg']))}\s*кг", blob), f"{cid}: вес {sp['weight_kg']} кг в новых блоках при unconfirmed weight ({code})")

# 5) z4000-10000
page = (ROOT / "models" / "z4000-10000.html").read_text(encoding="utf-8")
faq = new_sections(page).get("Частые вопросы об этой модели", "")
qs = [html.unescape(q) for q in re.findall(r"<summary>(.*?)</summary>", faq)]
check(qs and "весит" not in qs[0] and "габарит" in qs[0], f"z4000-10000: первый вопрос FAQ должен быть про габариты без «весит»: {qs[:1]}")
first = text(re.search(r"<details>.*?</details>", faq, re.S).group(0)) if faq else ""
check("кг" not in first and "59 × 31 × 35" in first and "51 × 31 × 35" in first, "z4000-10000: ответ про габариты без веса, с размерами обоих корпусов")
check(not any("весит" in q for q in qs), "z4000-10000: в FAQ нет вопросов «весит»")
check("<h2>Стоимость 1 Вт·ч</h2>" in page, "z4000-10000: блок называется «Стоимость 1 Вт·ч» (оба корпуса с диапазоном времени зарядки)")
# 6) шесть версий помечены в данных
spec = json.loads((ROOT / "data" / "source" / "station_specs.json").read_text(encoding="utf-8"))["stations"]
for code in ("Z2800-6200-L", "Z4000-6200-L", "Z4000-8600-L", "Z4000-10000-L", "Z5000-8600-L", "Z5000-10000-L"):
    u = [x for x in spec[code]["unconfirmed"] if x["field"] == "dc_connectors"]
    check(len(u) == 1 and "не согласуется" in u[0]["note"], f"{code}: нет единственной пометки unconfirmed dc_connectors")
# 7) в новых блоках нет запрещённых слов
for f in sorted((ROOT / "models").glob("*.html")):
    blob = " ".join(text(x) for x in new_sections(f.read_text(encoding="utf-8")).values())
    check(not re.search(r"постав[щ]ик|Е[А]С\b|электро[с]танц|деклара[ц]", blob, re.I), f"{f.name}: запрещённое слово в новых блоках")

print(f"\nпроверок пройдено: {passed}, ошибок: {len(errors)}")
if errors:
    sys.exit(1)
print("models_blocks_check: всё чисто")
