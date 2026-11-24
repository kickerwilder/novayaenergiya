/* Запуск чата-консультанта на любой странице сайта: кнопка создаётся сразу, сам виджет (assets/chat.js) подгружается лениво
   (на простое страницы или по нажатию), затем NEchat.init. Единственное место, где задан адрес бота (CHAT_URL): главная и страницы моделей
   используют этот файл. Пустое значение CHAT_URL: чата на сайте нет. Для локальной проверки без правки файла: страница с ?chat=local (порт 8787)
   или ?chat=local:ПОРТ.
   Подключение:
     главная:  <script src="assets/chat-launcher.js"></script>, затем app.js вызывает NEchatLaunch({goToCode, fmtPrice}) со своими функциями;
     модели:   короткий скрипт на странице подгружает этот файл после события load (не конкурирует с картинкой первого экрана за канал) с атрибутом
               data-auto: чат запускается сам, с функциями по умолчанию.
   Функции страницы, которые нужны виджету:
     goToCode(code)  кнопка «К карточке» в ответе бота (code вида Z2800-3800-L);
     fmtPrice(n)     формат цены в карточке ответа.
   По умолчанию (страницы моделей): goToCode открывает страницу этой модели (models/z2800-3800.html#v=L: выбирается нужная версия корпуса); если
   клиент уже на странице этой модели, переключается версия корпуса и страница прокручивается к началу. fmtPrice даёт тот же вид, что на главной
   («39 043 ₽», пробел неразрывный). Запросы к боту и тексты виджета на страницах одинаковые: контекст страницы в запрос не добавляется. */
(function () {
  "use strict";
  var CHAT_URL = "https://bot.novaya-energy.ru";

  var sc = document.currentScript;
  var DIR = sc && sc.src ? sc.src.replace(/[^\/]*$/, "") : "";      /* адрес папки assets/ */
  var ROOT = DIR.replace(/assets\/$/, "");                          /* корень сайта */
  window.neGoal = window.neGoal || function () {};                  /* цели аналитики: без счётчика ничего не делает */

  var nf = new Intl.NumberFormat("ru-RU");
  function defaultFmtPrice(p) { return nf.format(p) + " ₽"; }

  function defaultGoToCode(code) {
    var id = String(code).replace(/-[DL]$/, "").toLowerCase(), ver = String(code).slice(-1);
    if (!/^z\d+-\d+$/.test(id)) return;
    var here = /\/models\/([^\/.]+)(?:\.html)?\/?$/.exec(location.pathname);
    if (here && here[1] === id) {
      var b = document.querySelector('.model-btn[data-target="' + ver + '"]');
      if (b && !b.classList.contains("active")) b.click();
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (_) { window.scrollTo(0, 0); }
      return;
    }
    location.href = ROOT + "models/" + id + ".html#v=" + ver;
  }

  function launch(opts) {
    opts = opts || {};
    if (document.getElementById("chatFab")) return;
    var url = CHAT_URL, m = /[?&]chat=local(?::(\d+))?(?:&|$)/.exec(location.search);
    if (m) url = "http://localhost:" + (m[1] || "8787");
    if (!url) return;
    document.body.classList.add("has-chat");
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "chat-fab"; btn.id = "chatFab"; btn.setAttribute("aria-haspopup", "dialog"); btn.setAttribute("aria-expanded", "false"); btn.setAttribute("aria-controls", "chatPanel");
    var logo = (document.querySelector('link[rel="icon"][type="image/svg+xml"]') || {}).href || "";
    var icon = logo ? '<img class="chat-fab-ic" src="' + logo + '" width="28" height="28" alt="">' : '<svg class="chat-fab-ic" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="currentColor"/></svg>';
    btn.innerHTML = icon + '<span>Подобрать станцию в чате</span>';
    document.body.appendChild(btn);
    var waiting = null;
    function load(cb) {
      if (window.NEchat) { cb(); return; }
      if (waiting) { waiting.push(cb); return; }
      waiting = [cb];
      var s = document.createElement("script"); s.src = DIR + "chat.js";
      s.onload = function () { window.NEchat.init({ url: url, button: btn, goToCode: opts.goToCode || defaultGoToCode, fmtPrice: opts.fmtPrice || defaultFmtPrice, logo: logo }); var q = waiting; waiting = null; q.forEach(function (f) { f(); }); };
      s.onerror = function () { waiting = null; btn.hidden = true; };
      document.head.appendChild(s);
    }
    btn.addEventListener("click", function () { window.neGoal("chat_open"); load(function () { window.NEchat.toggle(); }); });
    if ("requestIdleCallback" in window) requestIdleCallback(function () { load(function () {}); }, { timeout: 8000 });
    else setTimeout(function () { load(function () {}); }, 5000);
  }

  window.NEchatLaunch = launch;
  if (sc && sc.hasAttribute("data-auto")) {
    if (document.body) launch(); else document.addEventListener("DOMContentLoaded", function () { launch(); });
  }
})();
