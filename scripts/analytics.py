"""Коды верификации и согласие на аналитику из scripts/seo.json (значения пишет владелец; пустое значение = ничего не выводится).

Подключается из build_seo.py (главная, privacy.html, 404.html) и build_models.py (страницы моделей).
  - yandex_verification, google_verification: мета-теги только на главной;
  - ym_counter_id: если задан, на каждую страницу выводится ОДИН тег <script src="assets/consent.js" data-ym="ID">. Баннер выбора cookie, загрузка
    счётчика Яндекс.Метрики (только после «Принять»), цели и отзыв согласия живут в assets/consent.js; разметки баннера на страницах нет;
  - ссылка «Настройки cookie» в блоке legal-links подвала и структурированный текст раздела 6 политики: тоже только при заданном ym_counter_id.
    Если счётчик пуст, необязательных cookie нет: баннера, ссылки и текста про аналитику нет.
Цели (window.neGoal): phone_click, email_click, chat_open, handoff_shown. До согласия и после отказа window.neGoal ничего не делает.
"""
import html
import json
from pathlib import Path

PATH = Path(__file__).resolve().parent / "seo.json"

# Раздел 6 политики. Состав «необходимых данных» проверен на чистом профиле браузера (cookie нет, localStorage пуст до выбора;
# в sessionStorage: положение прокрутки и, после отправки сообщения, история чата).
PRIVACY_SECTION = """<h3>Необходимые данные</h3>
<p>Без вашего согласия сайт не устанавливает cookie. В хранилище браузера он записывает только то, что нужно для работы:</p>
<ul>
  <li>положение прокрутки страницы (sessionStorage, ключи <code>ne_y:…</code>): чтобы кнопка «Назад» возвращала вас на то же место; удаляется при закрытии вкладки;</li>
  <li>история диалога с консультантом в чате (sessionStorage, ключ <code>ne_chat_v1</code>): появляется после отправки первого сообщения; удаляется при закрытии вкладки;</li>
  <li>ваш выбор по cookie (localStorage, ключ <code>ne_cookie_choice</code>): «принято» или «отклонено» и дата выбора; хранится 12 месяцев, затем сайт спросит снова.</li>
</ul>
<h3>Аналитические cookie</h3>
<p>Сайт использует сервис веб-аналитики Яндекс.Метрика для статистики посещений: какие страницы открывают, как переходят по сайту и нажимают на телефон, почту и кнопки связи. Cookie Метрики устанавливаются только после того, как вы нажали «Принять». Пока вы не дали согласие, а также после нажатия «Отклонить», код счётчика не загружается и запросов к сервису нет.</p>
<p>Согласие добровольное. Отказ не ограничивает работу сайта: каталог, подбор, чат и контакты доступны в полном объёме.</p>
<p>Отозвать согласие можно в любой момент: нажмите «Настройки cookie» внизу страницы и выберите «Отклонить». Сайт удалит cookie Метрики на своём домене (имена начинаются с <code>_ym</code>, а также <code>mdd</code>) и перестанет загружать счётчик. Cookie, которые сервис сохраняет на собственных доменах Яндекса, сайт удалить не может: их можно удалить в настройках браузера. Данные, уже переданные сервису, обрабатываются по правилам Яндекс.Метрики и с нашего сайта удалены быть не могут.</p>"""


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


def consent_tag(seo, prefix=""):
    """Тег подключения баннера и счётчика. prefix: путь от страницы к корню сайта («» для корня, «../» для models/, «/» для 404.html)."""
    cid = seo["ym_counter_id"]
    if not cid:
        return ""
    return '<script src="%sassets/consent.js" data-ym="%s" data-privacy="%sprivacy.html" defer></script>' % (prefix, cid, prefix)


def settings_link(seo):
    """Ссылка «Настройки cookie» для блока legal-links (только при подключённом счётчике)."""
    if not seo["ym_counter_id"]:
        return ""
    return ' · <button type="button" class="link-btn" data-cookie-settings>Настройки cookie</button>'


def privacy_section(seo):
    """Структурированный текст раздела 6 политики (только при подключённом счётчике)."""
    return PRIVACY_SECTION if seo["ym_counter_id"] else ""
