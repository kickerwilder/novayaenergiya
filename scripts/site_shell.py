"""Общая оболочка страниц сайта на глубине одной папки (models/*.html, <тип>/*.html): шапка, подвал, нижняя панель, кнопка «Наверх», запуск чата.
Вынесена из scripts/build_models.py без изменения разметки (страницы моделей после выноса побайтно прежние); те же блоки используют страницы новых типов товаров
(scripts/build_product_types.py). Пути с «../»: страница лежит в папке первого уровня.
"""
import html
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import naming as nm  # noqa: E402

NAMING = nm.load()  # наименования сайта (data/naming.json): подпись в шапке

SITE_NAME = "НОВАЯ ЭНЕРДЖИ"
PHONE = "+79787280002"
PHONE_TEXT = "+7 978 728-00-02"
EMAIL = "apv0050@gmail.com"


def esc(x):
    return html.escape(str(x), quote=True)


def head_tail():
    """Иконки, предзагрузка шрифтов, стили (конец <head>, кроме JSON-LD)."""
    return """<link rel="icon" href="../favicon.svg?v=2" type="image/svg+xml">
<link rel="icon" href="../favicon.ico?v=2" sizes="48x48">
<link rel="apple-touch-icon" href="../apple-touch-icon.png?v=2">
<link rel="preload" href="../fonts/geologica-700-cyr.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="../fonts/onest-400-cyr.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="../assets/styles.css">"""


def header(nav_extra=""):
    """Шапка с навигацией; nav_extra: дополнительные пункты после «Каталог» (разделы типов товаров; пусто, пока нет опубликованных товаров)."""
    return f"""<header class="bar" id="top">
  <div class="wrap bar-in">
    <a class="brand" href="../index.html" aria-label="{esc(SITE_NAME)} — на главную"><img class="brand-logo" src="../favicon.svg?v=2" width="36" height="36" alt=""><span class="brand-t"><span class="brand-n">{esc(SITE_NAME)}</span><span class="brand-s">{esc(NAMING['tagline'])}</span></span></a>
    <nav class="nav" aria-label="Разделы страницы">
      <a href="../index.html#catalog">Каталог</a>{nav_extra}
      <a href="../index.html#picker">Подбор</a>
      <a href="../index.html#faq">Вопросы</a>
      <a href="../index.html#contacts">Контакты</a>
    </nav>
    <div class="bar-c">
      <a class="tel" href="tel:{PHONE}">{PHONE_TEXT}</a>
      <a class="mail" href="mailto:{EMAIL}">{EMAIL}</a>
      <a class="btn sm primary" href="mailto:{EMAIL}">Написать</a>
    </div>
  </div>
</header>"""


def footer(cookie_link="", note=""):
    """Подвал с реквизитами; note: дополнительная строка перед копирайтом (для станций: про расчёт времени работы и доставку)."""
    return f"""<footer class="foot">
    <p class="foot-brand"><img class="foot-logo" src="../favicon.svg?v=2" width="32" height="32" alt="">{esc(SITE_NAME)}</p>
    <p class="req"><a href="tel:{PHONE}">{PHONE_TEXT}</a> · <a href="mailto:{EMAIL}">{EMAIL}</a></p>
    <div class="foot-legal">
      <p class="legal-seller"><strong>ИП Воробьёв Александр Павлович</strong> · ИНН 910208709968 · ОГРНИП 326911200011729<br>Республика Крым, г. Симферополь, Евпаторийское шоссе, д. 5Б, офис 1</p>
      <p class="legal-offer">Информация о ценах, характеристиках и комплектации носит информационный характер и не является публичной офертой, определяемой положениями ст. 437 ГК РФ. Точные параметры и комплектацию подтверждаем при оформлении заказа.</p>
      <p class="legal-links"><a href="../privacy.html">Политика обработки персональных данных</a> · <a href="../index.html#contacts">Реквизиты и контакты</a>{cookie_link}</p>
    </div>
{note}    <p class="copy">© 2026 НОВАЯ ЭНЕРДЖИ. Все права защищены.</p>
  </footer>"""


def tail(consent=""):
    """Нижняя панель «Позвонить | Написать», тег согласия на cookie (если есть), «Наверх» и отложенный запуск чата."""
    return f"""<div class="dock" role="group" aria-label="Связаться">
  <a class="btn primary" href="tel:{PHONE}">Позвонить</a>
  <a class="btn" href="mailto:{EMAIL}">Написать</a>
</div>
{consent}<button type="button" class="to-top" id="toTop" aria-label="Наверх" title="Наверх">↑</button>
<script>window.addEventListener("load",function(){{var s=document.createElement("script");s.src="../assets/chat-launcher.js";s.setAttribute("data-auto","");document.head.appendChild(s)}})</script>
"""
