#!/usr/bin/env python3
"""Общий порядок «после обновления цен или каталога». Запуск из корня: python scripts/build_all.py

1. scripts/update_charge_estimates.py -> data/charge.js (ориентировочные диапазоны времени зарядки; подтверждённые данные не трогает)
2. scripts/build_bot_kb.py  -> data/kb.json (база знаний чат-консультанта)
3. scripts/build_seo.py     -> index.html (SEO-блоки и FAQ), robots.txt, sitemap.xml

Цены сначала обновляются отдельно (scripts/import_prices.py), затем запускается этот скрипт.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = ["update_charge_estimates.py", "build_bot_kb.py", "build_seo.py"]

for name in STEPS:
    print("==> " + name)
    r = subprocess.run([sys.executable, str(HERE / name)], cwd=str(HERE.parent))
    if r.returncode:
        sys.exit("Шаг %s завершился с ошибкой (код %d)" % (name, r.returncode))
print("Готово.")
