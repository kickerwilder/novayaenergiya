#!/usr/bin/env python3
"""Проверка чата-консультанта в настоящем браузере (Playwright + Edge): python tests/chat_check.py
Нужны: pip install playwright и Edge (или --browser chromium). Бот и сеть подменяются (запросы к адресу бота перехватываются, наружу ничего не уходит).

Проверяется на страницах моделей (все 29: кнопка есть) и подробно на двух (с двумя версиями корпуса и с одной), а также на главной «как раньше»:
  1. кнопка «Подобрать станцию в чате», класс has-chat, одна кнопка; адрес бота задан в одном файле (assets/chat-launcher.js);
  2. chat.js грузится лениво на простое страницы, без нажатия;
  3. нажатие: чат открывается, цель chat_open; запрос уходит POST на адрес бота + /chat, в теле только messages (контекст страницы не добавляется);
  4. ответ бота: текст, карточки с ценой в том же формате, что на главной; кнопки «Позвонить» и «Написать на почту» при handoff, цель handoff_shown;
  5. «К карточке»: на главной карточка и версия корпуса на той же странице; на модели: своя модель переключает версию и прокручивает вверх,
     другая модель открывается на своей странице с нужной версией (#v=D или #v=L);
  6. бот недоступен: клиент видит сообщение с телефоном и почтой, поле ввода активно;
  7. вёрстка (тестовая копия с тестовым счётчиком, номер только в копии): кнопка чата, нижняя панель, «Наверх» и баннер cookie не перекрываются
     (телефон 360 и 390, десктоп 1300).
"""
import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import product_types as PT  # noqa: E402
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
spec = importlib.util.spec_from_file_location("consent_check", ROOT / "tests" / "consent_check.py")
cc = importlib.util.module_from_spec(spec); spec.loader.exec_module(cc)

BOT = "https://bot.novaya-energy.ru"
Q = "сколько проработает холодильник"
errors, passed = [], 0


def check(cond, msg):
    global passed
    if cond: passed += 1
    else: errors.append(msg); print("  FAIL:", msg)


def catalog():
    t = (ROOT / "data" / "catalog.js").read_text(encoding="utf-8")
    return json.loads(t[t.index("{"): t.rindex("}") + 1])["combos"]


def main():
    from playwright.sync_api import sync_playwright
    combos = catalog()
    two = [c for c in combos if len(c["vers"]) == 2]
    one = [c for c in combos if len(c["vers"]) == 1]
    ids = {c["id"].lower() for c in combos}
    page_a = "z1600-5000"                                   # две версии корпуса
    page_b = next(c["id"].lower() for c in one)             # одна версия
    other = next(c for c in two if c["id"].lower() != page_a)
    other_id = other["id"].lower()
    check(page_a in ids and any(c["id"].lower() == page_a for c in two), "z1600-5000 должна иметь две версии (опорная страница проверки)")

    # --- 1. адрес бота в одном файле
    holders = [str(p.relative_to(ROOT)) for p in list(ROOT.glob("*.html")) + list(ROOT.glob("models/*.html")) + list(ROOT.glob("assets/*.js")) + list(ROOT.glob("data/*.js"))
               if "bot.novaya-energy.ru" in p.read_text(encoding="utf-8")]
    check(holders == ["assets\\chat-launcher.js"] or holders == ["assets/chat-launcher.js"], "адрес бота должен быть задан в одном файле (assets/chat-launcher.js), найден в: %s" % holders)
    models_html = {p.stem: p.read_text(encoding="utf-8") for p in (ROOT / "models").glob("*.html")}
    check(len(models_html) == 29 and all(t.count("chat-launcher.js") == 1 and 'addEventListener("load"' in t.split("chat-launcher.js")[0].split("<script>")[-1] and '<script src="../assets/chat-launcher.js"' not in t for t in models_html.values()), "на всех 29 страницах моделей запуск чата должен подгружаться один раз после события load (без блокировки отрисовки)")
    check(all("chat.js" not in t.replace("chat-launcher.js", "") for t in models_html.values()), "страницы моделей не должны подключать chat.js напрямую (он грузится лениво)")

    srv = cc.serve(ROOT); port = srv.server_address[1]
    SITE = "http://127.0.0.1:%d/" % port
    tmp, site = cc.make_copy(str(__import__("random").randint(10 ** 7, 10 ** 8 - 1)))
    srv2 = cc.serve(site); SITE2 = "http://127.0.0.1:%d/" % srv2.server_address[1]
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch(channel="msedge", args=["--no-proxy-server"])

            def new(viewport, mobile=False, mode="ok", reply=None):
                ctx = br.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
                st = {"posts": [], "chat_js": 0, "mode": mode}
                body = reply or {"reply": "Тестовый ответ консультанта.", "cards": [
                    {"code": "Z1600-5000-L", "article": "ZF16-2005.0", "title": "Станция 1 600 Вт · 5 кВт·ч", "power": 1600, "cap": 5000, "price": 48432, "hours": "≈ 11 ч", "note": "та же модель"},
                    {"code": other["vers"]["L"]["code"] if "L" in other["vers"] else other["vers"]["D"]["code"], "article": "ZF-TEST", "title": "Другая модель", "power": other["power"], "cap": other["cap"], "price": 1234567, "hours": None, "note": "другая модель"},
                ], "handoff": False}
                def bot(rt):
                    h = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS"}
                    if rt.request.method == "OPTIONS": return rt.fulfill(status=204, headers=h)
                    st["posts"].append({"url": rt.request.url, "data": rt.request.post_data, "ct": rt.request.headers.get("content-type")})
                    if st["mode"] == "down": return rt.abort("connectionrefused")
                    rt.fulfill(status=200, headers=h, content_type="application/json", body=json.dumps(body, ensure_ascii=False))
                ctx.route(BOT + "/**", bot)
                ctx.on("request", lambda r: st.__setitem__("chat_js", st["chat_js"] + 1) if r.url.endswith("/assets/chat.js") else None)
                ctx.add_init_script("window.__goals=[]; window.neGoal=function(n){window.__goals.push(n)};")
                return ctx, st

            panel_open = "(function(){var p=document.getElementById('chatPanel');return !!p&&!p.hidden&&getComputedStyle(p).display!=='none'})()"
            fab = lambda pg: pg.evaluate("(function(){var f=document.getElementById('chatFab');if(!f)return null;var b=f.getBoundingClientRect();return {text:f.innerText.trim(),vis:b.width>0&&getComputedStyle(f).display!=='none',n:document.querySelectorAll('#chatFab').length,has:document.body.classList.contains('has-chat')}})()")

            # --- все страницы моделей: кнопка есть
            print("кнопка на всех страницах моделей")
            ctx, st = new({"width": 1300, "height": 900})
            for pid in sorted(ids):
                pg = ctx.new_page(); pg.goto(SITE + "models/%s.html" % pid, wait_until="load")
                try: pg.wait_for_function("document.getElementById('chatFab')", timeout=5000)
                except Exception: pass
                f = fab(pg)
                check(f and f["text"] == "Подобрать станцию в чате" and f["vis"] and f["n"] == 1 and f["has"], "%s: кнопка чата не появилась или неверна: %s" % (pid, f))
                pg.close()
            for rel in PT.all_pages_rel():          # страницы новых типов товаров (пока типов нет, цикл пустой)
                pg = ctx.new_page(); pg.goto(SITE + rel, wait_until="load")
                try: pg.wait_for_function("document.getElementById('chatFab')", timeout=5000)
                except Exception: pass
                f = fab(pg)
                check(f and f["text"] == "Подобрать станцию в чате" and f["vis"] and f["n"] == 1 and f["has"], "%s: кнопка чата не появилась или неверна: %s" % (rel, f))
                pg.close()
            ctx.close()

            def flow(label, url, viewport, mobile, is_model):
                print(label)
                ctx, st = new(viewport, mobile); pg = ctx.new_page()
                pg.goto(url, wait_until="load")
                pg.wait_for_function("document.getElementById('chatFab')", timeout=5000)
                f = fab(pg)
                check(f and f["text"] == "Подобрать станцию в чате" and f["vis"] and f["n"] == 1 and f["has"], "%s: кнопка: %s" % (label, f))
                # ленивая загрузка на простое: без нажатия chat.js запрашивается (до 8 с), бот не трогается
                pg.wait_for_function("1", timeout=1000)
                for _ in range(40):
                    if st["chat_js"]: break
                    pg.wait_for_timeout(250)
                check(st["chat_js"] == 1 and not st["posts"], "%s: chat.js на простое должен загрузиться один раз без запросов к боту (chat.js: %d, запросов к боту: %d)" % (label, st["chat_js"], len(st["posts"])))
                pg.locator("#chatFab").click(); pg.wait_for_timeout(500)
                check(pg.evaluate(panel_open), "%s: чат не открылся" % label)
                check("chat_open" in pg.evaluate("window.__goals"), "%s: нет цели chat_open" % label)
                pg.locator("#chatPanel textarea, #chatPanel input[type=text]").first.fill(Q); pg.keyboard.press("Enter"); pg.wait_for_timeout(900)
                check(len(st["posts"]) == 1 and st["posts"][0]["url"] == BOT + "/chat", "%s: запрос должен уйти POST на %s/chat: %s" % (label, BOT, [p["url"] for p in st["posts"]]))
                if st["posts"]:
                    d = json.loads(st["posts"][0]["data"])
                    check(list(d.keys()) == ["messages"] and d["messages"][-1] == {"role": "user", "text": Q}, "%s: в теле запроса только messages (без контекста страницы): %s" % (label, list(d.keys())))
                    check("application/json" in (st["posts"][0]["ct"] or ""), "%s: content-type" % label)
                panel = pg.evaluate("document.getElementById('chatPanel').innerText")
                check("Тестовый ответ консультанта." in panel, "%s: ответ бота не показан" % label)
                price_texts = pg.evaluate("[].slice.call(document.querySelectorAll('#chatPanel .cc-p')).map(function(e){return e.textContent})")
                check(price_texts == ["48 432 ₽ с доставкой".replace(" ₽", " ₽"), "1 234 567 ₽ с доставкой"] or [re.sub(r"[   ]", " ", t) for t in price_texts] == ["48 432 ₽ с доставкой", "1 234 567 ₽ с доставкой"], "%s: формат цены в карточках: %r" % (label, price_texts))
                return ctx, st, pg, price_texts

            # --- главная «как раньше»
            ctx, st, pg, prices_main = flow("главная", SITE, {"width": 1300, "height": 900}, False, False)
            pg.locator(".chat-go").first.click(); pg.wait_for_timeout(1500)
            check(pg.evaluate("location.pathname") == "/" and pg.evaluate("!!document.querySelector('#card-Z1600-5000')"), "главная: «К карточке» должна оставаться на главной и находить карточку")
            vb = pg.evaluate("(function(){var b=document.querySelector('#card-Z1600-5000 .vbtn[data-v=\"L\"]');return b&&b.getAttribute('aria-pressed')})()")
            check(vb == "true", "главная: после «К карточке» должна быть выбрана версия L (aria-pressed): %s" % vb)
            ctx.close()

            # --- страницы моделей: подробно
            for pid, ctxlabel in ((page_a, "модель %s (две версии), десктоп" % page_a), (page_b, "модель %s (одна версия), десктоп" % page_b)):
                ctx, st, pg, prices_model = flow(ctxlabel, SITE + "models/%s.html" % pid, {"width": 1300, "height": 900}, False, True)
                check(prices_model == prices_main, "%s: формат цены должен совпадать с главной: %r и %r" % (ctxlabel, prices_model, prices_main))
                ctx.close()

            ctx, st, pg, _ = flow("модель %s, телефон 390" % page_a, SITE + "models/%s.html" % page_a, {"width": 390, "height": 844}, True, True)
            ctx.close()

            # «К карточке» на странице модели
            print("«К карточке» на странице модели")
            ctx, st, pg, _ = flow("модель %s (для К карточке)" % page_a, SITE + "models/%s.html" % page_a, {"width": 1300, "height": 900}, False, True)
            pg.evaluate("window.scrollTo(0, 800)"); pg.wait_for_timeout(300)
            pg.locator(".chat-go").first.click(); pg.wait_for_timeout(1200)       # Z1600-5000-L: своя модель
            check(pg.evaluate("location.pathname").endswith("/models/%s.html" % page_a), "своя модель: переход не нужен, страница та же")
            check(pg.evaluate("document.querySelector('.model-btn[data-target=\"L\"]').classList.contains('active')"), "своя модель: должна переключиться версия L")
            check(pg.evaluate("window.scrollY") < 40, "своя модель: страница должна прокрутиться к началу (scrollY=%s)" % pg.evaluate("window.scrollY"))
            pg.locator(".chat-go").nth(1).click(); pg.wait_for_load_state("load"); pg.wait_for_timeout(1200)   # другая модель
            want_v = "L" if "L" in other["vers"] else "D"
            check(pg.evaluate("location.pathname").endswith("/models/%s.html" % other_id) and pg.evaluate("location.hash") == "#v=" + want_v, "другая модель: адрес %s, получено %s%s" % ("/models/%s.html#v=%s" % (other_id, want_v), pg.evaluate("location.pathname"), pg.evaluate("location.hash")))
            check(pg.evaluate("(function(){var b=document.querySelector('.model-btn.active');return b?b.getAttribute('data-target'):null})()") == want_v, "другая модель: должна быть выбрана версия %s" % want_v)
            ctx.close()

            # --- бот недоступен и handoff
            for label, url, vp, mob in (("бот недоступен, модель", SITE + "models/%s.html" % page_a, {"width": 390, "height": 844}, True), ("бот недоступен, главная", SITE, {"width": 390, "height": 844}, True)):
                print(label)
                ctx, st = new(vp, mob, mode="down"); pg = ctx.new_page(); pg.goto(url, wait_until="load"); pg.wait_for_function("document.getElementById('chatFab')", timeout=5000)
                pg.locator("#chatFab").click(); pg.wait_for_timeout(500)
                pg.locator("#chatPanel textarea, #chatPanel input[type=text]").first.fill(Q); pg.keyboard.press("Enter"); pg.wait_for_timeout(1500)
                panel = pg.evaluate("document.getElementById('chatPanel').innerText")
                links = pg.evaluate("[].slice.call(document.querySelectorAll('#chatPanel a')).map(function(a){return a.getAttribute('href')})")
                check("Сейчас не могу ответить, позвоните +7 978 728-00-02 или напишите на apv0050@gmail.com" in panel, "%s: нет сообщения с контактами" % label)
                check("tel:+79787280002" in links and "mailto:apv0050@gmail.com" in links, "%s: нет ссылок на телефон и почту" % label)
                check(pg.evaluate("!document.querySelector('#chatPanel textarea, #chatPanel input[type=text]').disabled"), "%s: поле ввода должно оставаться активным" % label)
                check("handoff_shown" in pg.evaluate("window.__goals"), "%s: нет цели handoff_shown" % label)
                ctx.close()
            print("handoff в ответе бота")
            ctx, st = new({"width": 1300, "height": 900}, reply={"reply": "Уточните у менеджера: позвоните +7 978 728-00-02 или напишите на apv0050@gmail.com.", "cards": [], "handoff": True})
            pg = ctx.new_page(); pg.goto(SITE + "models/%s.html" % page_a, wait_until="load"); pg.wait_for_function("document.getElementById('chatFab')", timeout=5000)
            pg.locator("#chatFab").click(); pg.wait_for_timeout(500)
            pg.locator("#chatPanel textarea, #chatPanel input[type=text]").first.fill("какая мощность зарядного"); pg.keyboard.press("Enter"); pg.wait_for_timeout(900)
            btns = pg.evaluate("[].slice.call(document.querySelectorAll('#chatPanel .chat-handoff a')).map(function(a){return a.textContent})")
            check(btns == ["Позвонить", "Написать на почту"] and "handoff_shown" in pg.evaluate("window.__goals"), "handoff: кнопки и цель: %s" % btns)
            ctx.close()

            # --- вёрстка: баннер cookie (тестовая копия со счётчиком), кнопка чата, нижняя панель, «Наверх»
            print("вёрстка: баннер, нижняя панель, «Наверх», кнопка чата")
            RECT = """(function(){
              function r(e){var b=e.getBoundingClientRect();return {l:b.left,t:b.top,r:b.right,b:b.bottom}}
              function vis(e){var s=getComputedStyle(e),b=e.getBoundingClientRect();return b.width>0&&b.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&parseFloat(s.opacity)>0.05}
              var out=[]; [['чат','#chatFab'],['баннер','#cookieBanner'],['панель связи','.dock'],['наверх','.to-top']].forEach(function(x){var e=document.querySelector(x[1]); if(e&&vis(e)) out.push([x[0],r(e)])});
              return out})()"""
            inter = lambda a, b: not (a["r"] <= b["l"] or a["l"] >= b["r"] or a["b"] <= b["t"] or a["t"] >= b["b"])
            for w, h, mob in ((360, 740, True), (390, 844, True), (1300, 900, False)):
                for scroll in (0, 900):
                    ctx, st = new({"width": w, "height": h}, mob); pg = ctx.new_page()
                    pg.goto(SITE2 + "models/%s.html" % page_a, wait_until="load"); pg.wait_for_function("document.getElementById('chatFab')", timeout=5000); pg.wait_for_timeout(900)
                    pg.evaluate("window.scrollTo(0,%d)" % scroll); pg.wait_for_timeout(700)
                    items = pg.evaluate(RECT); names = [n for n, _ in items]
                    tag = "%dx%d прокрутка %d" % (w, h, scroll)
                    check("баннер" in names and "чат" in names, "%s: на копии со счётчиком должны быть видны баннер и кнопка чата: %s" % (tag, names))
                    if mob and scroll: check("панель связи" in names, "%s: нижняя панель должна быть видна" % tag)
                    if (not mob) and scroll: check("наверх" in names, "%s: кнопка «Наверх» должна быть видна" % tag)
                    for i in range(len(items)):
                        for j in range(i + 1, len(items)):
                            check(not inter(items[i][1], items[j][1]), "%s: «%s» перекрывает «%s»" % (tag, items[i][0], items[j][0]))
                    ctx.close()
            br.close()
    finally:
        srv.shutdown(); srv2.shutdown(); shutil.rmtree(tmp, ignore_errors=True)

    print("\nпроверок пройдено: %d, ошибок: %d" % (passed, len(errors)))
    if errors:
        for e in errors[:40]: print(" -", e)
        sys.exit(1)
    print("chat_check: всё чисто")


if __name__ == "__main__":
    main()
