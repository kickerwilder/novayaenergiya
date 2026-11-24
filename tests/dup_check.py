#!/usr/bin/env python3
"""Оценка дублей текста на 29 страницах моделей: python tests/dup_check.py [--strict] [--blocks]

Метод (тот же, что в SEO-аудите): из <body> каждой страницы убираются скрипты и стили, текст разбивается на слова, из слов строятся фразы по 5 слов.
  - доля общего текста страницы: часть её различных 5-словных фраз, которые встречаются минимум на половине страниц (шаблонный текст);
  - попарное сходство: коэффициент Жаккара по множествам 5-словных фраз;
  - слов на странице (в среднем), по блокам (--blocks): доля общего текста и объём.
Цель: средняя доля общего текста не выше ~35 %, максимум попарного сходства не выше ~55 %. Без --strict скрипт только печатает отчёт (код 0);
с --strict код возврата 1, если цель не достигнута (пороги можно задать --max-share и --max-pair, в процентах).
--content-only: не считать каркас сайта (шапку, подвал с реквизитами, нижнюю панель), одинаковый на всех страницах; --dir папка: другая папка со страницами
(например, распакованная прежняя версия для сравнения до и после).
"""
import argparse
import collections
import glob
import html
import itertools
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SH = 5
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def words(h):
    h = html.unescape(re.sub(r"<[^>]+>", " ", h))
    return re.findall(r"[\w\-,.%·]+", h.lower())


CONTENT_ONLY = False


def body_of(t):
    b = re.sub(r"<script.*?</script>|<style.*?</style>", "", t.split("<body>")[1], flags=re.S)
    if CONTENT_ONLY:   # без каркаса сайта: шапка, подвал с реквизитами и нижняя панель одинаковы на всех страницах и от текста модели не зависят
        b = re.sub(r'<header class="bar".*?</header>|<footer class="foot".*?</footer>|<div class="dock".*?</div>', "", b, flags=re.S)
    return b


def shingles(ws):
    return [tuple(ws[i:i + SH]) for i in range(len(ws) - SH + 1)]


def blocks(t):
    """Крупные блоки страницы по заголовкам разделов (для отчёта --blocks)."""
    body = body_of(t)
    main = body.split('<div class="wrap">', 1)[1]
    parts = re.split(r'(?=<section class="model-sec|<div class="model-header"|<footer class="foot")', main)
    out = collections.OrderedDict()
    for p in parts:
        m = re.search(r"<h[12][^>]*>(.*?)</h[12]>", p, re.S)
        name = re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else ("шапка и крошки" if "breadcrumbs" in p[:300] else "подвал")
        name = re.sub(r"\(.*?\)", "", name).strip()
        name = re.sub(r"\d[\d\s,]*", "N ", name).strip()      # название блока без чисел модели
        out[name] = out.get(name, "") + p
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--blocks", action="store_true")
    ap.add_argument("--max-share", type=float, default=35.0)
    ap.add_argument("--max-pair", type=float, default=55.0)
    ap.add_argument("--dir", default=str(ROOT / "models"))
    ap.add_argument("--content-only", action="store_true", help="не считать шапку, подвал и нижнюю панель (каркас сайта)")
    a = ap.parse_args()
    global CONTENT_ONLY
    CONTENT_ONLY = a.content_only

    pages = sorted(glob.glob(str(Path(a.dir) / "*.html")))
    texts = {p: Path(p).read_text(encoding="utf-8") for p in pages}
    n = len(pages)
    allw = {p: words(body_of(texts[p])) for p in pages}
    sh = {p: shingles(w) for p, w in allw.items()}
    sets = {p: set(s) for p, s in sh.items()}
    cnt = collections.Counter(s for p in pages for s in sets[p])
    tmpl = {p: sum(1 for s in sets[p] if cnt[s] >= n * 0.5) / max(1, len(sets[p])) for p in pages}
    share = [100 * v for v in tmpl.values()]
    jac = sorted(((len(sets[x] & sets[y]) / len(sets[x] | sets[y]), x, y) for x, y in itertools.combinations(pages, 2)), reverse=True)
    avg_pair = 100 * sum(j[0] for j in jac) / len(jac)
    name = lambda p: Path(p).stem
    print("страниц: %d | слов на странице (в среднем): %d (мин %d, макс %d)" % (n, round(sum(len(w) for w in allw.values()) / n), min(len(w) for w in allw.values()), max(len(w) for w in allw.values())))
    print("доля общего текста (5-словные фразы, которые есть минимум на половине страниц): среднее %.0f %%, мин %.0f %%, макс %.0f %%" % (sum(share) / n, min(share), max(share)))
    print("попарное сходство (Жаккар по фразам): среднее %.0f %%, максимум %.0f %%" % (avg_pair, 100 * jac[0][0]))
    for j, x, y in jac[:3]:
        print("   самая похожая пара: %.0f %%  %s ~ %s" % (100 * j, name(x), name(y)))
    uniq = sum(sum(1 for s in sets[p] if cnt[s] <= 2) for p in pages) / n
    print("уникальных фраз (есть максимум на 2 страницах), в среднем на страницу: %d из %d" % (uniq, sum(len(s) for s in sets.values()) / n))
    if a.blocks:
        blk = collections.OrderedDict(); wc = collections.defaultdict(list)
        for p in pages:
            for bname, h in blocks(texts[p]).items():
                ws = words(h); s2 = set(shingles(ws))
                if s2: blk.setdefault(bname, []).append(sum(1 for s in s2 if cnt[s] >= n * 0.5) / len(s2))
                wc[bname].append(len(ws))
        print("по блокам (доля общего текста / слов на страницу / на скольких страницах есть):")
        for b in blk: print("   %-58s %3.0f %% / %4d / %d" % (b[:58], 100 * sum(blk[b]) / len(blk[b]), round(sum(wc[b]) / len(wc[b])), len(wc[b])))
    ok = sum(share) / n <= a.max_share and 100 * jac[0][0] <= a.max_pair
    print("цель (доля общего текста ≤ %.0f %%, максимум попарного сходства ≤ %.0f %%): %s" % (a.max_share, a.max_pair, "достигнута" if ok else "не достигнута"))
    if a.strict and not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
