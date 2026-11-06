#!/usr/bin/env python3
"""Импорт цен из CSV или XLSX в data/prices.js.

    python scripts/import_prices.py цены.csv
    python scripts/import_prices.py "путь\к\таблице.xlsx"      # таблица владельца, см. ниже
    python scripts/import_prices.py цены.csv --check        # только отчёт, файл не пишется

Файл: две колонки «код» и «цена». Заголовок необязателен; если он есть, колонки
находятся по словам «код/артикул/code» и «цена/price/руб».
Цена: 129900, «129 900», «129900 ₽», «129 900,00». Неоднозначные записи вроде
«129.900» не угадываются, а попадают в отчёт.

Список допустимых кодов берётся из data/catalog.js (42 версии), а не из файла цен.
Таблица владельца (.xlsx) читается напрямую. Какой лист, какая строка заголовков и какие
колонки нужны, берётся из файла настроек (по умолчанию ../prices/import_config.json
рядом с репозиторием, другой путь: --config). Он лежит вне репозитория; образец
формата: scripts/import_config.example.json. Колонки ищутся по ИМЕНИ заголовка.
Файл открывается с data_only=True (берутся сохранённые значения формул). Цена
округляется ВВЕРХ до целого рубля через Decimal (ROUND_CEILING): 36803,412 -> 36804,
74342,04 -> 74343. Перед округлением число приводится к 6 знакам, чтобы «шум» float
(77281.84400000001) не давал лишний рубль. Если в колонках кода или цены есть пустые
значения или нет нужной колонки, скрипт останавливается с понятной ошибкой и ничего
не записывает.

Запись в data/prices.js выполняется только если проблем нет. Если нужно загрузить
неполный файл, добавьте --allow-partial: коды без корректной цены сохранят
прежнее значение из data/prices.js.

Коды выхода: 0 — файл записан (или --check прошёл без проблем), 1 — есть проблемы.
"""
import argparse
import csv
import json
import re
import sys
from decimal import ROUND_CEILING, ROUND_HALF_EVEN, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog.js"
PRICES = ROOT / "data" / "prices.js"

HEADER_CODE = ("код", "артикул", "code", "sku", "модель")
HEADER_PRICE = ("цена", "price", "руб", "стоимость")
CONFIG = ROOT.parent / "prices" / "import_config.json"
CONFIG_KEYS = ("sheet", "header_row", "code_column", "price_column")
DASHES = "‐‑‒–—−"


def catalog_codes(path):
    text = path.read_text(encoding="utf-8")
    data = json.loads(text[text.index("{") : text.rindex("}") + 1])
    codes = [v["code"] for c in data["combos"] for v in c["vers"].values()]
    if len(codes) != 42 or len(set(codes)) != 42:
        sys.exit("В %s не 42 уникальных кода (найдено %d). Импорт остановлен." % (path, len(codes)))
    return sorted(codes)


def current_prices(path):
    if not path.exists():
        return {}
    return {m.group(1): int(m.group(2)) for m in re.finditer(r'"([^"]+)"\s*:\s*(\d+)', path.read_text(encoding="utf-8"))}


def norm_code(raw):
    s = str(raw).strip().upper().replace(" ", "")
    for d in DASHES:
        s = s.replace(d, "-")
    return re.sub(r"\s+", "", s)


def parse_price(raw):
    """Возвращает (целое или None, причина ошибки или None)."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None, "пусто"
    if isinstance(raw, bool):
        return None, "не число"
    if isinstance(raw, (int, float)):
        if raw != int(raw):
            return None, "дробное число %r" % raw
        n = int(raw)
        return (n, None) if n >= 0 else (None, "отрицательная цена")
    s = str(raw).strip().lower()
    s = re.sub(r"(₽|руб\.?|р\.?|rub)", "", s)
    s = re.sub(r"[\s   ]", "", s)
    if not s:
        return None, "нет цифр"
    if re.fullmatch(r"-\d+([.,]\d+)?", s):
        return None, "отрицательная цена"
    if re.fullmatch(r"\d+", s):
        return int(s), None
    m = re.fullmatch(r"(\d+)[.,](\d{1,2})", s)
    if m:
        if int(m.group(2)) != 0:
            return None, "копейки: %r (нужны целые рубли)" % raw
        return int(m.group(1)), None
    if re.fullmatch(r"\d{1,3}([.,]\d{3})+", s):
        return None, "неоднозначно: %r (точка или запятая как разделитель тысяч?)" % raw
    return None, "не число: %r" % raw


def read_csv(path):
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        sys.exit("Не удалось определить кодировку CSV: сохраните как UTF-8.")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t")
    except csv.Error:
        dialect = csv.excel
    return [row for row in csv.reader(text.splitlines(), dialect)]


def ceil_rub(value):
    """Округление ВВЕРХ до целого рубля через Decimal, без float-арифметики."""
    d = Decimal(repr(value)) if isinstance(value, float) else Decimal(value)
    d = d.quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN)  # убрать шум float
    return int(d.to_integral_value(rounding=ROUND_CEILING))


def _norm_header(v):
    return re.sub(r"\s+", " ", str(v or "")).strip().lower()


def load_config(path):
    if not path.exists():
        sys.exit("ОШИБКА: не найден файл настроек: %s\n"
                 "Создайте его по образцу scripts/import_config.example.json "
                 "или укажите путь ключом --config." % path)
    try:
        cfg = json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError as e:
        sys.exit("ОШИБКА: файл настроек %s не является корректным JSON: %s" % (path, e))
    missing = [k for k in CONFIG_KEYS if k not in cfg]
    if missing:
        sys.exit("ОШИБКА: в файле настроек %s нет ключей: %s" % (path, ", ".join(missing)))
    if not isinstance(cfg["header_row"], int) or cfg["header_row"] < 1:
        sys.exit("ОШИБКА: header_row в файле настроек должен быть целым числом от 1.")
    return cfg


def read_xlsx(path, cfg):
    """Читает таблицу владельца. Возвращает (строки листа с 1-й строки, индекс первой строки данных, ci, pi).
    Цены в строках уже округлены вверх до целых рублей."""
    sheet, header_row = cfg["sheet"], cfg["header_row"]
    code_col, price_col = cfg["code_column"], cfg["price_column"]
    try:
        import openpyxl
    except ImportError:
        sys.exit("Для .xlsx нужен пакет openpyxl (pip install openpyxl). "
                 "Или сохраните файл как CSV (UTF-8) и запустите скрипт ещё раз.")
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    if sheet not in wb.sheetnames:
        sys.exit("ОШИБКА: в файле нет листа «%s». Есть листы: %s." % (sheet, ", ".join(wb.sheetnames)))
    rows = [list(r) for r in wb[sheet].iter_rows(values_only=True)]
    if len(rows) < header_row:
        sys.exit("ОШИБКА: на листе «%s» меньше %d строк, заголовки не найдены." % (sheet, header_row))
    header = [_norm_header(c) for c in rows[header_row - 1]]
    cols = {}
    for label, name in (("кода", code_col), ("цены", price_col)):
        want = _norm_header(name)
        if want not in header:
            shown = ", ".join("«%s»" % str(c).strip() for c in rows[header_row - 1] if c)
            sys.exit("ОШИБКА: в строке %d листа «%s» нет колонки %s «%s».\nНайдены заголовки: %s"
                     % (header_row, sheet, label, name, shown or "(строка пуста)"))
        cols[label] = header.index(want)
    ci, pi = cols["кода"], cols["цены"]

    empties = []
    for n, row in enumerate(rows[header_row:], start=header_row + 1):
        code = row[ci] if len(row) > ci else None
        price = row[pi] if len(row) > pi else None
        code_empty = code is None or str(code).strip() == ""
        price_empty = price is None or (isinstance(price, str) and not price.strip())
        if code_empty and price_empty:
            continue  # строка целиком пуста в этих колонках: конец таблицы или разделитель
        if code_empty:
            empties.append("строка %d: пустой «%s» (цена %r)" % (n, code_col, price))
        elif price_empty:
            empties.append("строка %d: %s — пустая «%s»" % (n, str(code).strip(), price_col))
    if empties:
        sys.exit("ОШИБКА: в таблице есть пустые значения, цены не импортированы (%d):\n  - %s\n"
                 "Заполните их в таблице (формулы должны быть пересчитаны и сохранены в Excel) и повторите."
                 % (len(empties), "\n  - ".join(empties)))

    for row in rows[header_row:]:
        v = row[pi] if len(row) > pi else None
        if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
            row[pi] = ceil_rub(v)
    return rows, header_row, ci, pi


def pick_columns(rows):
    """Возвращает (индекс_кода, индекс_цены, номер_первой_строки_данных)."""
    for first in rows[:1]:
        cells = [str(c or "").strip().lower() for c in first]
        ci = next((i for i, c in enumerate(cells) if any(h in c for h in HEADER_CODE)), None)
        pi = next((i for i, c in enumerate(cells) if any(h in c for h in HEADER_PRICE)), None)
        if ci is not None and pi is not None and ci != pi:
            return ci, pi, 1
    return 0, 1, 0


def render(prices):
    lines = [
        "/* Цены. Меняются скриптом: python scripts/import_prices.py <файл.csv|файл.xlsx>",
        '   "КОД": число рублей. 0 = «Цена по запросу».',
        "   -D = тёмный корпус, -L = светлый корпус на колёсах. */",
        "const PRICES = {",
    ]
    keys = sorted(prices)
    for i, k in enumerate(keys):
        lines.append('  "%s": %d%s' % (k, prices[k], "," if i < len(keys) - 1 else ""))
    lines.append("};")
    return "\n".join(lines) + "\n"


def main():
    for stream in (sys.stdout, sys.stderr):  # консоль Windows (cp1251) не знает «₽»
        stream.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="CSV или XLSX с колонками «код» и «цена»")
    ap.add_argument("--config", default=str(CONFIG), help="файл настроек для XLSX (по умолчанию ../prices/import_config.json)")
    ap.add_argument("--out", default=str(PRICES), help="куда писать (по умолчанию data/prices.js)")
    ap.add_argument("--catalog", default=str(CATALOG), help="каталог с кодами (по умолчанию data/catalog.js)")
    ap.add_argument("--check", action="store_true", help="только отчёт, ничего не записывать")
    ap.add_argument("--allow-partial", action="store_true",
                    help="записать, даже если есть проблемы; проблемные коды сохранят прежнее значение")
    args = ap.parse_args()

    src = Path(args.file)
    if not src.exists():
        sys.exit("Файл не найден: %s" % src)
    expected = catalog_codes(Path(args.catalog))
    out = Path(args.out)
    old = current_prices(out)

    ext = src.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        rows, start, ci, pi = read_xlsx(src, load_config(Path(args.config)))
    elif ext in (".csv", ".txt", ".tsv"):
        rows = read_csv(src)
        if not rows:
            sys.exit("Файл пуст.")
        ci, pi, start = pick_columns(rows)
    else:
        sys.exit("Поддерживаются .csv и .xlsx, получено: %s" % ext)

    found, problems, zero, extra, dups = {}, [], [], [], []
    for n, row in enumerate(rows[start:], start=start + 1):
        if not row or all(c is None or str(c).strip() == "" for c in row):
            continue
        if len(row) <= max(ci, pi):
            problems.append("строка %d: нет колонки цены: %r" % (n, row))
            continue
        code = norm_code(row[ci])
        if not code:
            problems.append("строка %d: пустой код" % n)
            continue
        price, why = parse_price(row[pi])
        if code not in expected:
            extra.append("строка %d: лишний код %s (цена %r)" % (n, code, row[pi]))
            continue
        if why:
            problems.append("строка %d: %s — %s" % (n, code, why))
            continue
        if code in found and found[code] != price:
            dups.append("строка %d: %s повторяется с другой ценой (%d и %d)" % (n, code, found[code], price))
            continue
        found[code] = price
        if price == 0:
            zero.append(code)

    bad_codes = {re.match(r"строка \d+: (\S+)", p).group(1) for p in problems + dups if re.match(r"строка \d+: (Z\S+)", p)}
    missing = [c for c in expected if c not in found and c not in bad_codes]

    print("Файл: %s" % src)
    print("Ожидается кодов: %d, получено корректных цен: %d" % (len(expected), len(found)))
    for title, items in (
        ("НЕ НАЙДЕНЫ в файле (%d)" % len(missing), missing),
        ("ЛИШНИЕ коды, их нет в каталоге (%d)" % len(extra), extra),
        ("ПРОБЛЕМНЫЕ цены (%d)" % len(problems), problems),
        ("ПОВТОРЫ с разными ценами (%d)" % len(dups), dups),
        ("НУЛЕВЫЕ цены, на сайте будет «Цена по запросу» (%d)" % len(zero), zero),
    ):
        if items:
            print("\n%s:" % title)
            for it in items:
                print("  - " + it)

    blocking = bool(missing or extra or problems or dups)
    if args.check:
        print("\nРежим --check: файл не записывался.")
        sys.exit(1 if blocking else 0)
    if blocking and not args.allow_partial:
        print("\nФайл %s НЕ записан: исправьте проблемы выше или запустите с --allow-partial." % out)
        sys.exit(1)

    result = {c: found.get(c, old.get(c, 0)) for c in expected}
    kept = [c for c in expected if c not in found]
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(render(result))
    # самопроверка записанного
    back = current_prices(out)
    assert back == result and len(back) == 42, "после записи данные не совпали"
    print("\nЗаписано %s: 42 цены, из них ненулевых %d." % (out, sum(1 for v in result.values() if v > 0)))
    if kept:
        print("Прежнее значение сохранено для %d кодов: %s" % (len(kept), ", ".join(kept)))
    sys.exit(1 if blocking else 0)


if __name__ == "__main__":
    main()
