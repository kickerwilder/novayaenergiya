"""Коды верификации и веб-аналитика из scripts/seo.json (значения пишет владелец; пустое значение = ничего не выводится).

Подключается из build_seo.py (главная, privacy.html) и build_models.py (страницы моделей).
  - yandex_verification, google_verification: мета-теги только на главной;
  - ym_counter_id: код Яндекс.Метрики (асинхронно, без Вебвизора, clickmap и trackLinks) на всех страницах + цели;
  - абзац про веб-аналитику в privacy.html, только если счётчик подключён.
Цели (window.neGoal): phone_click (клик по tel:), email_click (клик по mailto:), chat_open и handoff_shown (вызываются из app.js и chat.js).
Без счётчика window.neGoal ничего не делает (заглушка в assets/app.js и assets/chat.js).
"""
import html
import json
from pathlib import Path

PATH = Path(__file__).resolve().parent / "seo.json"

PRIVACY_PARAGRAPH = ("Сайт использует сервис веб-аналитики Яндекс.Метрика, который использует файлы cookie для сбора статистики посещений. "
                     "Отключить cookie можно в настройках браузера.")


def load():
    d = json.loads(PATH.read_text(encoding="utf-8"))
    for k in ("yandex_verification", "google_verification", "ym_counter_id", "indexnow_key"):
        d[k] = str(d.get(k, "")).strip()
    cid = d["ym_counter_id"]
    if cid and not cid.isdigit():
        raise SystemExit("scripts/seo.json: ym_counter_id должен состоять из цифр, получено %r" % cid)
    return d


def verification_lines(seo):
    """Мета-теги верификации (только непустые)."""
    out = []
    if seo["yandex_verification"]:
        out.append('<meta name="yandex-verification" content="%s">' % html.escape(seo["yandex_verification"], quote=True))
    if seo["google_verification"]:
        out.append('<meta name="google-site-verification" content="%s">' % html.escape(seo["google_verification"], quote=True))
    return out


def metrika_snippet(seo):
    """Код счётчика и цели; пустая строка, если счётчика нет."""
    cid = seo["ym_counter_id"]
    if not cid:
        return ""
    return (
        '<script>\n'
        '(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();'
        'for(var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return}}'
        'k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})'
        '(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");\n'
        'ym(%(id)s,"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,webvisor:false});\n'
        'window.neGoal=function(n){try{ym(%(id)s,"reachGoal",n)}catch(e){}};\n'
        'document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a)return;'
        'var h=a.getAttribute("href")||"";if(h.indexOf("tel:")===0)neGoal("phone_click");else if(h.indexOf("mailto:")===0)neGoal("email_click")});\n'
        '</script>' % {"id": cid}
    )


def privacy_paragraph(seo):
    """Абзац для privacy.html (только при подключённом счётчике)."""
    return "<p>%s</p>" % html.escape(PRIVACY_PARAGRAPH, quote=False) if seo["ym_counter_id"] else ""
