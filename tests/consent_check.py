#!/usr/bin/env python3
"""Проверка согласия на аналитические cookie в настоящем браузере (Playwright + Edge/Chromium): python tests/consent_check.py

Нужны: pip install playwright и установленный Edge (или Chromium: --browser chromium). В репозитории ничего не меняется:
проверка копирует сайт во временную папку, вписывает ТЕСТОВЫЙ ym_counter_id только в копию, собирает копию (scripts/build_all.py) и открывает её.
Сервис mc.yandex.ru подменяется заглушкой (tag.js ставит cookie _ym_uid, _ym_d, mdd на домене и _ym_visorc на хосте и записывает вызовы ym()),
поэтому проверка не зависит от сети и ничего не отправляет в Яндекс. Домены novaya-energy.ru и www.novaya-energy.ru направляются на локальный сервер.

Проверяется (чистый профиль на каждый сценарий):
  1. счётчик пуст (настоящий репозиторий): нет баннера, нет consent.js, нет ссылки «Настройки cookie»;
  2. до выбора и после «Отклонить»: нет запросов к mc.yandex.ru, нет cookie _ym*, neGoal ничего не делает; баннер на главной, моделях, privacy.html, 404.html;
  3. «Принять»: счётчик загружается, cookie _ym* есть, цели phone_click и email_click доходят; выбор сохраняется (ne_cookie_choice), баннера после перезагрузки нет;
  4. отзыв («Настройки cookie» -> «Отклонить»): страница перезагружается, cookie _ym* удалены (с www и без), запросов к mc.yandex.ru после перезагрузки нет;
  5. старый ключ ne_cookie_consent согласием не считается; выбор старше 12 месяцев снова спрашивается;
  6. кнопки «Принять» и «Отклонить» одинаковы (класс, размер, вес, цвета) и обе на одном экране; на телефоне (360 и 390) баннер не перекрывает
     кнопки связи (dock) и кнопку чата, не выходит за экран, кнопки не меньше 44 px;
  7. клавиатура: первая табуляция попадает на баннер; «Настройки cookie» ставит фокус на баннер, Esc закрывает и возвращает фокус на ссылку.
"""
import argparse
import http.server
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_ID = str(random.randint(10 ** 7, 10 ** 8 - 1))   # случайный тестовый номер счётчика: нигде не хранится, вписывается только во временную копию
EXPECTED_TEXT = ("Мы используем cookie сервиса Яндекс.Метрика для статистики посещений. Пока вы не дали согласие, они не устанавливаются. "
                 "Подробнее в Политике обработки персональных данных.")
errors, passed = [], 0
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def check(cond, msg):
    global passed
    if cond: passed += 1
    else: errors.append(msg); print("  FAIL:", msg)


class Handler(http.server.SimpleHTTPRequestHandler):
    """Статика; несуществующий адрес отдаёт 404.html со статусом 404."""
    def log_message(self, *a): pass

    def do_GET(self):
        p = Path(self.translate_path(self.path.split("?")[0]))
        if p.is_dir(): p = p / "index.html"
        if not p.is_file():
            body = (Path(self.directory) / "404.html").read_bytes()
            self.send_response(404); self.send_header("Content-Type", "text/html; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body); return
        super().do_GET()


def serve(directory):
    h = lambda *a, **k: Handler(*a, directory=str(directory), **k)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def make_copy(counter_id):
    tmp = Path(tempfile.mkdtemp(prefix="ne_consent_"))
    dst = tmp / "site"
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__", "*.mp4"))
    seo_path = dst / "scripts" / "seo.json"
    seo = json.loads(seo_path.read_text(encoding="utf-8")); seo["ym_counter_id"] = counter_id
    seo_path.write_text(json.dumps(seo, ensure_ascii=False, indent=2), encoding="utf-8")
    r = subprocess.run([sys.executable, str(dst / "scripts" / "build_all.py")], cwd=str(dst), capture_output=True, text=True, encoding="utf-8", errors="replace",
                       env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    if r.returncode: sys.exit("сборка копии не удалась:\n" + r.stdout[-800:] + r.stderr[-800:])
    return tmp, dst


STUB_TAG = """(function(){var q=(window.ym&&window.ym.a)||[];window.__ymCalls=[];function rec(a){window.__ymCalls.push(Array.prototype.slice.call(a))}
q.forEach(rec);window.ym=function(){rec(arguments)};
var host=location.hostname.replace(/^www\\./,"");
document.cookie="_ym_uid=1234567890; path=/; domain=."+host+"; max-age=31536000";
document.cookie="_ym_d=1700000000; path=/; domain=."+host+"; max-age=31536000";
document.cookie="_ym_visorc=b; path=/; max-age=1800";
document.cookie="mdd=1; path=/; domain=."+host+"; max-age=31536000";})();"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="msedge", help="msedge (по умолчанию) или chromium")
    a = ap.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("нужен playwright: pip install playwright")

    # ---- 1. счётчик пуст: настоящее состояние репозитория
    seo = json.loads((ROOT / "scripts" / "seo.json").read_text(encoding="utf-8"))
    print("1. пустой счётчик (репозиторий): ym_counter_id = %r" % seo["ym_counter_id"])
    if seo["ym_counter_id"]:
        errors.append("в репозитории задан ym_counter_id (%r): в коммите он должен быть пустым" % seo["ym_counter_id"])
    pages = ["index.html", "privacy.html", "404.html"] + sorted(str(p.relative_to(ROOT)).replace("\\", "/") for p in (ROOT / "models").glob("*.html"))
    for rel in pages:
        t = (ROOT / rel).read_text(encoding="utf-8")
        check("consent.js" not in t and "cookie-banner" not in t and "data-cookie-settings" not in t and "mc.yandex.ru" not in t, "%s: при пустом счётчике на странице есть баннер/скрипт согласия/Метрика" % rel)
    priv_repo = (ROOT / "privacy.html").read_text(encoding="utf-8")
    check("Яндекс.Метрик" not in priv_repo and "Яндекс" not in priv_repo, "privacy.html: текст про Метрику или Яндекс при пустом счётчике")
    check("Сайт сам не устанавливает файлы cookie" in priv_repo and "sessionStorage" in priv_repo and "удаляются при закрытии вкладки" in priv_repo, "privacy.html: нет точного первого абзаца раздела 6 (показывается всегда)")
    check("выбор варианта корпуса" not in priv_repo and "localStorage" not in priv_repo, "privacy.html: остался неточный прежний абзац (выбор корпуса, localStorage) при пустом счётчике")
    check("<!--YMP5:BEGIN--><!--YMP5:END-->" in priv_repo and "<!--YMP:BEGIN--><!--YMP:END-->" in priv_repo, "privacy.html: при пустом счётчике маркеры должны стоять вплотную (ничего не выводится)")
    check(re.search(r"ne_cookie_consent", "".join((ROOT / f).read_text(encoding="utf-8") for f in ("assets/app.js", "index.html"))) is None, "остался старый ключ ne_cookie_consent")

    tmp, site = make_copy(TEST_ID)
    srv = serve(site); port = srv.server_address[1]
    print("   копия с тестовым счётчиком %s: http://novaya-energy.ru:%d/" % (TEST_ID, port))
    try:
        for rel in pages:
            t = (site / rel).read_text(encoding="utf-8")
            check(t.count('data-ym="%s"' % TEST_ID) == 1 and "assets/consent.js" in t, "%s (копия): нет тега consent.js с тестовым счётчиком" % rel)
            if rel not in ("404.html",): check("data-cookie-settings" in t, "%s (копия): нет ссылки «Настройки cookie»" % rel)
        priv_copy = (site / "privacy.html").read_text(encoding="utf-8")
        check("Аналитические cookie" in priv_copy and "Необходимые данные" in priv_copy, "privacy.html (копия): нет структурированного текста раздела 6")
        sec5 = priv_copy.split("<h2>5.")[1].split("<h2 id=\"cookies\">")[0]
        check("Яндекс.Метрика (ООО «Яндекс») для статистики посещений" in sec5 and "При вашем согласии на аналитические cookie" in sec5, "privacy.html (копия): в разделе 5 нет фразы о передаче данных Яндекс.Метрике")
        sec6 = priv_copy.split("<h2 id=\"cookies\">")[1].split("<h2>7.")[0]
        check(sec6.count("sessionStorage") == 2 and "ne_y:" not in sec6 and "ne_chat_v1" not in sec6 and "ne_cookie_choice" in sec6, "privacy.html (копия): раздел 6: повтор про sessionStorage не убран или нет ключа выбора")

        with sync_playwright() as pw:
            br = pw.chromium.launch(channel=None if a.browser == "chromium" else a.browser,
                                    args=["--no-proxy-server", "--host-resolver-rules=MAP novaya-energy.ru 127.0.0.1, MAP www.novaya-energy.ru 127.0.0.1"])   # без системного прокси: домены подменены на локальный сервер
            URL = "http://novaya-energy.ru:%d/" % port
            WWW = "http://www.novaya-energy.ru:%d/" % port

            def new(viewport=None, mobile=False, chat=False):
                ctx = br.new_context(viewport=viewport or {"width": 1300, "height": 900}, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
                st = {"ym_requests": [], "tag_requests": 0}
                def on_req(r):
                    if "mc.yandex.ru" in r.url:
                        st["ym_requests"].append(r.url)
                        if r.url.endswith("/tag.js"): st["tag_requests"] += 1
                ctx.on("request", on_req)
                def route(rt):
                    if rt.request.url.endswith("/tag.js"): rt.fulfill(status=200, content_type="text/javascript", body=STUB_TAG)
                    else: rt.fulfill(status=204, body="")
                ctx.route("https://mc.yandex.ru/**", route)
                if chat:
                    def bot(rt):
                        h = {"access-control-allow-origin": "*", "access-control-allow-headers": "*"}
                        rt.fulfill(status=204, headers=h) if rt.request.method == "OPTIONS" else rt.fulfill(status=200, headers=h, content_type="application/json", body='{"reply":"x","cards":[],"handoff":false}')
                    ctx.route("http://localhost:8787/**", bot)
                return ctx, st

            ym_cookies = lambda ctx: sorted(c["name"] for c in ctx.cookies() if c["name"].startswith("_ym") or c["name"] == "mdd")
            choice = lambda pg: pg.evaluate("localStorage.getItem('ne_cookie_choice')")
            shown = lambda pg: pg.evaluate("(function(){var b=document.getElementById('cookieBanner');return !!b&&!b.hidden&&getComputedStyle(b).display!=='none'})()")

            # ---- 2. до выбора и после «Отклонить»
            print("2. до выбора и после «Отклонить»")
            for rel in ["", "models/z1600-5000.html", "privacy.html", "net-takoy-adres"]:
                ctx, st = new(); pg = ctx.new_page(); pg.goto(URL + rel, wait_until="load"); pg.wait_for_timeout(700)
                check(shown(pg), "%s: баннер не показан до выбора" % (rel or "/"))
                if shown(pg): check(pg.locator("#cookieBanner .cookie-text").inner_text().strip() == EXPECTED_TEXT, "%s: текст баннера не совпадает с заданным" % (rel or "/"))
                check(not st["ym_requests"] and not ym_cookies(ctx), "%s: до выбора есть запросы к mc.yandex.ru или cookie _ym*: %s %s" % (rel or "/", st["ym_requests"][:2], ym_cookies(ctx)))
                check(pg.evaluate("typeof window.ym") == "undefined", "%s: до выбора определён window.ym" % (rel or "/"))
                pg.evaluate("window.neGoal('phone_click')"); pg.wait_for_timeout(100)
                check(not st["ym_requests"], "%s: neGoal до согласия что-то отправил" % (rel or "/"))
                check(pg.evaluate("document.cookie.indexOf('_ym')") == -1, "%s: cookie с _ym до выбора" % (rel or "/"))
                check(choice(pg) is None, "%s: до выбора уже записан ne_cookie_choice" % (rel or "/"))
                check(pg.evaluate("document.querySelectorAll('.cookie-banner').length") == 1, "%s: баннеров не один" % (rel or "/"))
                pg.locator("[data-cookie-choice=declined]").click(); pg.wait_for_timeout(300)
                c = json.loads(choice(pg) or "{}")
                check(c.get("choice") == "declined" and re.match(r"\d{4}-\d\d-\d\dT", c.get("date", "")), "%s: после «Отклонить» неверная запись выбора: %s" % (rel or "/", c))
                check(not shown(pg), "%s: баннер остался после «Отклонить»" % (rel or "/"))
                pg.reload(wait_until="load"); pg.wait_for_timeout(500)
                check(not shown(pg) and not st["ym_requests"] and not ym_cookies(ctx), "%s: после отказа и перезагрузки баннер/запросы/cookie" % (rel or "/"))
                ctx.close()
            # сайт полностью работает без выбора: каталог есть, ссылки кликабельны, баннер ничего не блокирует
            ctx, st = new(); pg = ctx.new_page(); pg.goto(URL, wait_until="load"); pg.wait_for_timeout(500)
            check(pg.locator("#list .card, #list article").count() > 0 or pg.locator("a[href*='models/']").count() > 0, "без выбора каталог не отрисован")
            ctx.close()

            # ---- 3. «Принять»
            print("3. «Принять»")
            for rel in ["", "models/z1600-5000.html", "net-takoy-adres"]:
                ctx, st = new(); pg = ctx.new_page(); pg.goto(URL + rel, wait_until="load"); pg.wait_for_timeout(500)
                pg.locator("[data-cookie-choice=accepted]").click(); pg.wait_for_timeout(700)
                check(st["tag_requests"] == 1, "%s: после «Принять» tag.js запрошен %d раз" % (rel or "/", st["tag_requests"]))
                check(ym_cookies(ctx) == ["_ym_d", "_ym_uid", "_ym_visorc", "mdd"], "%s: после «Принять» нет ожидаемых cookie Метрики: %s" % (rel or "/", ym_cookies(ctx)))
                init = [x for x in pg.evaluate("window.__ymCalls") if x[1] == "init"]
                check(len(init) == 1 and str(init[0][0]) == TEST_ID and init[0][2].get("webvisor") is False and init[0][2].get("clickmap") is True and init[0][2].get("trackLinks") is True, "%s: параметры init неверны: %s" % (rel or "/", init))
                c = json.loads(choice(pg) or "{}"); check(c.get("choice") == "accepted", "%s: выбор не сохранён как accepted" % (rel or "/"))
                check(not shown(pg), "%s: баннер остался после «Принять»" % (rel or "/"))
                if rel == "":
                    pg.evaluate("document.querySelector('.dock a[href^=tel]') && document.querySelector('.dock a[href^=tel]').addEventListener('click', e => e.preventDefault())")
                    pg.evaluate("(function(){var a=document.querySelector('a[href^=\"mailto:\"]');a.addEventListener('click',function(e){e.preventDefault()});a.click();var t=document.querySelector('a[href^=\"tel:\"]');t.addEventListener('click',function(e){e.preventDefault()});t.click();})()")
                    goals = [x[2] for x in pg.evaluate("window.__ymCalls") if x[1] == "reachGoal"]
                    check("email_click" in goals and "phone_click" in goals, "цели phone_click/email_click не дошли: %s" % goals)
                    pg.evaluate("window.neGoal('chat_open')"); pg.evaluate("window.neGoal('handoff_shown')")
                    goals = [x[2] for x in pg.evaluate("window.__ymCalls") if x[1] == "reachGoal"]
                    check("chat_open" in goals and "handoff_shown" in goals, "цели chat_open/handoff_shown не дошли: %s" % goals)
                pg.reload(wait_until="load"); pg.wait_for_timeout(700)
                check(not shown(pg), "%s: после согласия и перезагрузки показан баннер" % (rel or "/"))
                check(st["tag_requests"] == 2, "%s: после перезагрузки со сохранённым согласием счётчик не загрузился (запросов tag.js: %d)" % (rel or "/", st["tag_requests"]))
                ctx.close()

            # ---- 4. отзыв согласия
            print("4. отзыв согласия")
            for base in (URL, WWW):
                ctx, st = new(); pg = ctx.new_page(); pg.goto(base, wait_until="load"); pg.wait_for_timeout(400)
                pg.locator("[data-cookie-choice=accepted]").click(); pg.wait_for_timeout(600)
                before = ym_cookies(ctx)
                check(len(before) == 4, "%s: перед отзывом нет четырёх cookie Метрики: %s" % (base, before))
                pg.evaluate("window.__marker = 1; sessionStorage.setItem('_ymTest','1')")
                tags_before = st["tag_requests"]
                pg.locator("[data-cookie-settings]").scroll_into_view_if_needed(); pg.locator("[data-cookie-settings]").click(); pg.wait_for_timeout(300)
                check(shown(pg), "%s: «Настройки cookie» не открыли баннер" % base)
                check(pg.evaluate("document.activeElement && document.activeElement.id") == "cookieBanner", "%s: фокус не на баннере после открытия из подвала" % base)
                with pg.expect_navigation(wait_until="load", timeout=8000):
                    pg.locator("[data-cookie-choice=declined]").click()
                pg.wait_for_timeout(700)
                check(pg.evaluate("window.__marker") is None, "%s: страница не перезагружена после отзыва" % base)
                check(ym_cookies(ctx) == [], "%s: после отзыва остались cookie Метрики (_ym*, mdd): %s" % (base, ym_cookies(ctx)))
                check(pg.evaluate("sessionStorage.getItem('_ymTest')") is None, "%s: не удалены _ym-данные в sessionStorage" % base)
                check(st["tag_requests"] == tags_before, "%s: после отзыва счётчик снова загружен" % base)
                check(json.loads(choice(pg) or "{}").get("choice") == "declined", "%s: после отзыва выбор не declined" % base)
                check(pg.evaluate("typeof window.ym") == "undefined", "%s: после отзыва и перезагрузки определён window.ym" % base)
                ctx.close()

            # ---- 5. старый ключ и срок 12 месяцев
            print("5. старый ключ и срок хранения")
            ctx, st = new(); pg = ctx.new_page(); pg.goto(URL, wait_until="load")
            pg.evaluate("localStorage.setItem('ne_cookie_consent','1')"); pg.reload(wait_until="load"); pg.wait_for_timeout(500)
            check(shown(pg) and st["tag_requests"] == 0, "старый ne_cookie_consent принят за согласие на Метрику")
            ctx.close()
            import datetime
            old = (datetime.datetime.utcnow() - datetime.timedelta(days=400)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            fresh = (datetime.datetime.utcnow() - datetime.timedelta(days=330)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            for label, date, expect_shown in (("старше 12 месяцев", old, True), ("моложе 12 месяцев", fresh, False)):
                ctx, st = new(); pg = ctx.new_page(); pg.goto(URL, wait_until="load")
                pg.evaluate("localStorage.setItem('ne_cookie_choice', JSON.stringify({choice:'accepted', date:'%s'}))" % date); pg.reload(wait_until="load"); pg.wait_for_timeout(600)
                check(shown(pg) == expect_shown, "выбор %s: баннер показан=%s, ожидалось %s" % (label, shown(pg), expect_shown))
                check((st["tag_requests"] == 0) == expect_shown, "выбор %s: счётчик загружен неверно (tag.js: %d)" % (label, st["tag_requests"]))
                ctx.close()
            ctx, st = new(); pg = ctx.new_page(); pg.goto(URL, wait_until="load")
            pg.evaluate("localStorage.setItem('ne_cookie_choice', 'мусор')"); pg.reload(wait_until="load"); pg.wait_for_timeout(500)
            check(shown(pg) and st["tag_requests"] == 0, "повреждённая запись выбора не сбросила баннер")
            ctx.close()

            # ---- 6. вид: одинаковые кнопки, телефон
            print("6. вид и расположение")
            for w, h, mobile in ((1300, 900, False), (900, 700, False), (390, 844, True), (360, 740, True)):
                for chat in (False, True):
                    ctx, st = new({"width": w, "height": h}, mobile, chat); pg = ctx.new_page()
                    pg.goto(URL + ("?chat=local:8787" if chat else ""), wait_until="load"); pg.wait_for_timeout(900)
                    tag = "%dx%d%s" % (w, h, " +чат" if chat else "")
                    info = pg.evaluate("""(function(){
                      function r(e){var b=e.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom,w:b.width,h:b.height}}
                      var ban=document.getElementById('cookieBanner'), a=ban.querySelector('[data-cookie-choice=accepted]'), d=ban.querySelector('[data-cookie-choice=declined]');
                      var cs=function(e){var s=getComputedStyle(e);return [s.fontWeight,s.fontSize,s.color,s.backgroundColor,s.borderColor,s.borderWidth,s.minHeight,s.paddingLeft].join('|')};
                      var others=[].slice.call(document.querySelectorAll('.dock a, .dock, #chatFab, .to-top')).filter(function(e){var b=e.getBoundingClientRect();return b.width>0&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'}).map(function(e){return [e.className||e.tagName, r(e)]});
                      return {ban:r(ban), a:r(a), d:r(d), ca:a.className, cd:d.className, sa:cs(a), sd:cs(d), others:others, vw:innerWidth, vh:innerHeight, aria:ban.getAttribute('aria-label'), pre:ban.querySelectorAll('input:checked,[aria-pressed=true]').length};
                    })()""")
                    check(info["ca"] == info["cd"] and info["sa"] == info["sd"], "%s: кнопки «Принять» и «Отклонить» различаются (класс/стиль): %s | %s" % (tag, info["sa"], info["sd"]))
                    check(abs(info["a"]["w"] - info["d"]["w"]) < 1.5 and abs(info["a"]["h"] - info["d"]["h"]) < 1.5, "%s: размеры кнопок разные" % tag)
                    check(info["a"]["h"] >= 44 and info["d"]["h"] >= 44, "%s: кнопка ниже 44 px (%.0f)" % (tag, info["a"]["h"]))
                    ban = info["ban"]
                    check(ban["l"] >= 0 and ban["r"] <= info["vw"] + 0.5 and ban["t"] >= 0 and ban["b"] <= info["vh"] + 0.5, "%s: баннер выходит за экран: %s" % (tag, ban))
                    check(info["a"]["b"] <= info["vh"] and info["d"]["b"] <= info["vh"], "%s: кнопки выбора не на одном экране" % tag)
                    check(info["pre"] == 0 and info["aria"], "%s: предзаполненный выбор или нет aria-label" % tag)
                    for name, o in info["others"]:
                        inter = not (o["r"] <= ban["l"] or o["l"] >= ban["r"] or o["b"] <= ban["t"] or o["t"] >= ban["b"])
                        check(not inter, "%s: баннер перекрывает «%s» (%s)" % (tag, name, {k: round(v) for k, v in o.items()}))
                    if chat: check(any("chat-fab" in n for n, _ in info["others"]), "%s: кнопка чата не найдена (проверка перекрытия не имеет смысла)" % tag)
                    if mobile: check(any("dock" in n.lower() for n, _ in info["others"]), "%s: dock не найден" % tag)
                    ctx.close()

            # ---- 7. клавиатура
            print("7. клавиатура")
            ctx, st = new(); pg = ctx.new_page(); pg.goto(URL, wait_until="load"); pg.wait_for_timeout(500)
            pg.keyboard.press("Tab"); first = pg.evaluate("document.activeElement.getAttribute('data-cookie-choice') || document.activeElement.closest('#cookieBanner') && 'link'")
            check(first == "link" or first == "accepted", "первая табуляция не попала на баннер: %s" % first)
            pg.keyboard.press("Tab"); pg.keyboard.press("Tab")
            check(pg.evaluate("document.activeElement.getAttribute('data-cookie-choice')") == "declined", "по Tab нельзя дойти до «Отклонить» внутри баннера")
            ol = pg.evaluate("getComputedStyle(document.activeElement).outlineStyle + '|' + getComputedStyle(document.activeElement).outlineWidth")
            check(ol.startswith("solid") and not ol.endswith("|0px"), "у кнопки в фокусе нет видимой рамки: %s" % ol)
            pg.keyboard.press("Enter"); pg.wait_for_timeout(400)
            check(json.loads(choice(pg) or "{}").get("choice") == "declined" and not shown(pg), "Enter на «Отклонить» не сработал")
            link = pg.locator("[data-cookie-settings]"); link.focus(); pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
            check(shown(pg) and pg.evaluate("document.activeElement.id") == "cookieBanner", "Enter на «Настройки cookie» не открыл баннер с фокусом")
            pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
            check(not shown(pg) and pg.evaluate("document.activeElement.hasAttribute('data-cookie-settings')"), "Esc не закрыл баннер и не вернул фокус на ссылку")
            check(json.loads(choice(pg) or "{}").get("choice") == "declined", "Esc изменил сохранённый выбор")
            ctx.close()
            br.close()
    finally:
        srv.shutdown(); shutil.rmtree(tmp, ignore_errors=True)

    print("\nпроверок пройдено: %d, ошибок: %d" % (passed, len(errors)))
    if errors:
        for e in errors[:40]: print(" -", e)
        sys.exit(1)
    print("consent_check: всё чисто")


if __name__ == "__main__":
    main()
