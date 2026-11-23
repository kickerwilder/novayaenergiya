/* Согласие на аналитические cookie и запуск Яндекс.Метрики.
   Подключается тегом <script src=".../consent.js" data-ym="ID счётчика" data-privacy="адрес политики" defer>, который build_all.py выводит
   на все страницы ТОЛЬКО при непустом ym_counter_id (scripts/seo.json). Без тега баннера нет, необязательных cookie нет.
   Единственный источник текста и разметки баннера — этот файл.
   Правила:
   - код счётчика (mc.yandex.ru) загружается только после «Принять»; до выбора и после «Отклонить» запросов к Яндексу нет, cookie _ym* не ставятся,
     window.neGoal ничего не делает;
   - выбор хранится в localStorage под ключом ne_cookie_choice: {"choice":"accepted"|"declined","date":ISO}, срок 12 месяцев, затем спрашиваем снова;
     прежний ключ ne_cookie_consent согласием не считается;
   - ссылка «Настройки cookie» ([data-cookie-settings] в подвале) открывает баннер заново; «Отклонить» после «Принять» удаляет cookie Метрики
     на нашем домене (с www и без: имена _ym* и mdd, настоящий tag.js ставит и cookie mdd) и данные _ym* в localStorage/sessionStorage, после чего перезагружает
     страницу, чтобы счётчика на ней не осталось. Cookie на доменах Яндекса (yandexuid и др.) сайт удалить не может;
   - сайт полностью работает и без выбора. */
(function () {
  "use strict";
  var sc = document.currentScript;
  if (!sc) return;
  var ID = sc.getAttribute("data-ym") || "";
  var PRIVACY = sc.getAttribute("data-privacy") || "privacy.html";
  if (!/^\d+$/.test(ID)) return;

  var KEY = "ne_cookie_choice";
  var TEXT_BEFORE = "Мы используем cookie сервиса Яндекс.Метрика для статистики посещений. Пока вы не дали согласие, они не устанавливаются. Подробнее в ";
  var TEXT_LINK = "Политике обработки персональных данных";
  var banner = null, openedFromSettings = false, loaded = false, clickBound = false;

  /* ---------- сохранённый выбор ---------- */
  function readChoice() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c || (c.choice !== "accepted" && c.choice !== "declined")) return null;
      var d = new Date(c.date);
      if (isNaN(d.getTime())) return null;
      var until = new Date(d.getTime()); until.setMonth(until.getMonth() + 12);
      return Date.now() < until.getTime() ? c : null;
    } catch (e) { return null; }
  }
  function writeChoice(choice) {
    try { localStorage.setItem(KEY, JSON.stringify({ choice: choice, date: new Date().toISOString() })); } catch (e) {}
  }

  /* ---------- Метрика (грузится только после согласия) ---------- */
  function loadMetrika() {
    if (loaded) return;
    loaded = true;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (var j = 0; j < document.scripts.length; j++) { if (document.scripts[j].src === r) return; }
      k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
    window.ym(Number(ID), "init", { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false });
    if (!clickBound) {
      clickBound = true;
      document.addEventListener("click", function (e) {
        var a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        var h = a.getAttribute("href") || "";
        if (h.indexOf("tel:") === 0) window.neGoal("phone_click");
        else if (h.indexOf("mailto:") === 0) window.neGoal("email_click");
      });
    }
  }
  /* цели: до согласия и после отказа ничего не делает */
  window.neGoal = function (name) {
    if (!loaded || typeof window.ym !== "function") return;
    try { window.ym(Number(ID), "reachGoal", name); } catch (e) {}
  };

  /* ---------- удаление cookie и данных Метрики на нашем домене ---------- */
  function domainsToTry() {
    var out = [""], parts = location.hostname.split(".");
    if (!/^\d+(\.\d+){3}$/.test(location.hostname)) {
      for (var i = 0; i < parts.length - 1; i++) { var d = parts.slice(i).join("."); out.push(d, "." + d); }
    }
    return out;
  }
  function ymCookieNames() {
    return (document.cookie || "").split(";").map(function (s) { return s.split("=")[0].trim(); }).filter(function (n) { return n.indexOf("_ym") === 0 || n === "mdd"; });
  }
  function deleteYmData() {
    var names = ymCookieNames(), doms = domainsToTry();
    names.forEach(function (n) {
      doms.forEach(function (d) {
        document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; path=/" + (d ? "; domain=" + d : "");
      });
    });
    [window.localStorage, window.sessionStorage].forEach(function (st) {
      try {
        Object.keys(st).filter(function (k) { return k.indexOf("_ym") === 0; }).forEach(function (k) { st.removeItem(k); });
      } catch (e) {}
    });
    return names.length;
  }

  /* ---------- баннер ---------- */
  function build() {
    if (banner) return banner;
    banner = document.createElement("div");
    banner.className = "cookie-banner";
    banner.id = "cookieBanner";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Согласие на cookie");
    banner.tabIndex = -1;
    banner.hidden = true;
    var p = document.createElement("p");
    p.className = "cookie-text";
    p.appendChild(document.createTextNode(TEXT_BEFORE));
    var a = document.createElement("a"); a.href = PRIVACY; a.textContent = TEXT_LINK;
    p.appendChild(a); p.appendChild(document.createTextNode("."));
    var row = document.createElement("div"); row.className = "cookie-actions";
    /* обе кнопки одинаковые: тот же класс, размер, вес и контраст; без выбора по умолчанию */
    [["accepted", "Принять"], ["declined", "Отклонить"]].forEach(function (x) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.setAttribute("data-cookie-choice", x[0]); b.textContent = x[1];
      b.addEventListener("click", function () { choose(x[0]); });
      row.appendChild(b);
    });
    banner.appendChild(p); banner.appendChild(row);
    banner.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && openedFromSettings) { e.preventDefault(); hide(true); }
    });
    /* первым в документе: клавиатура и скринридер доходят до выбора сразу; на раскладку не влияет (position:fixed) */
    document.body.insertBefore(banner, document.body.firstChild);
    return banner;
  }
  function show(fromSettings) {
    build();
    openedFromSettings = !!fromSettings;
    banner.hidden = false;
    if (fromSettings) { try { banner.focus(); } catch (e) {} }
  }
  function hide(restoreFocus) {
    if (!banner) return;
    banner.hidden = true;
    if (restoreFocus) { var s = document.querySelector("[data-cookie-settings]"); if (s) s.focus(); }
  }
  function choose(choice) {
    var before = readChoice();
    var hadMetrika = loaded || (before && before.choice === "accepted");
    writeChoice(choice);
    var fromSettings = openedFromSettings;
    if (choice === "accepted") {
      hide(fromSettings);
      loadMetrika();
    } else {
      var removed = deleteYmData();
      hide(fromSettings);
      if (hadMetrika || removed) { location.reload(); }   /* счётчик убираем перезагрузкой страницы */
    }
  }

  /* ---------- запуск ---------- */
  function start() {
    var c = readChoice();
    if (c && c.choice === "accepted") loadMetrika();
    else if (c && c.choice === "declined") deleteYmData();   /* на случай cookie, оставшихся от прежнего согласия */
    else show(false);
    document.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-cookie-settings]");
      if (t) { e.preventDefault(); show(true); }
    });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
