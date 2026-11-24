#!/usr/bin/env python3
"""Общий порядок «после обновления цен или каталога». Запуск из корня: python scripts/build_all.py

0. scripts/build_naming.py -> data/naming.js, названия карточек в data/catalog.js, маркеры наименований в HTML (источник слов: data/naming.json)
0а. scripts/add_dc_voltage.py -> поле dcV (напряжение DC) у версий в data/catalog.js из data/source/station_specs.json (для карточки: зарядка от авто)
1. scripts/update_charge_estimates.py -> data/charge.js (ориентировочные диапазоны времени зарядки; подтверждённые данные не трогает)
2. scripts/build_bot_kb.py  -> data/kb.json (база знаний чат-консультанта)
3. scripts/build_models.py  -> models/*.html (29 страниц моделей)
3а. scripts/build_product_types.py -> страницы новых типов товаров (пока в data/source/product_types.json нет типов, ничего не создаёт), редиректы, защита адресов
4. scripts/build_seo.py     -> index.html (SEO-блоки и FAQ), robots.txt, sitemap.xml (станции и опубликованные товары всех типов)

Цены сначала обновляются отдельно (scripts/import_prices.py), затем запускается этот скрипт.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = ["build_naming.py", "add_dc_voltage.py", "update_charge_estimates.py", "build_bot_kb.py", "build_models.py", "build_product_types.py", "build_seo.py"]

for name in STEPS:
    print("==> " + name)
    r = subprocess.run([sys.executable, str(HERE / name)], cwd=str(HERE.parent))
    if r.returncode:
        sys.exit("Шаг %s завершился с ошибкой (код %d)" % (name, r.returncode))
print("Готово.")
