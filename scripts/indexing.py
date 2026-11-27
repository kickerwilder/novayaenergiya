"""Единственный переключатель индексации основного сайта.

INDEXABLE = True (сайт рабочий и открыт поисковикам): метатега robots на публичных страницах нет.
INDEXABLE = False: на всех публичных страницах (главная, privacy.html, страницы моделей и страницы типов товаров) появляется
<meta name="robots" content="noindex,nofollow">.

Закрывать сайт только по решению владельца: поисковики уберут страницы из выдачи. Порядок (подробно: bot/DEPLOY.md, пункт 3.12):
INDEXABLE = False, python scripts/build_all.py, коммит, выкладка и заголовок X-Robots-Tag "noindex, nofollow" в блоке novaya-energy.ru
в bot/deploy/Caddyfile. Пока INDEXABLE = True, этого заголовка на основном домене быть не должно (проверяют tests/seo_check.py и smoke-тест).
python scripts/build_all.py --indexable: разовая сборка без метатега, когда константа False (при True флаг ничего не меняет).

404.html всегда с noindex (от переключателя не зависит). robots.txt всегда без Disallow: роботы должны открыть страницу, чтобы прочитать метатег.
Поддомены bot и preview закрыты заголовком X-Robots-Tag в Caddyfile всегда.
"""
import os

INDEXABLE = True

ENV = "NE_INDEXABLE"   # выставляет build_all.py --indexable на время сборки
ROBOTS_META = '<meta name="robots" content="noindex,nofollow">'


def indexable():
    return INDEXABLE or os.environ.get(ENV) == "1"


def robots_meta():
    """Строка метатега для <head> или пустая строка, если индексация открыта."""
    return "" if indexable() else ROBOTS_META
