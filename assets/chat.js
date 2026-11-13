/* Виджет чата-консультанта. Подгружается лениво из app.js (по простою страницы или по первому нажатию на кнопку).
   Ответы приходят от бэкенда бота: {reply, cards, handoff}. Цифры считает код бота, виджет их только показывает. */
(function () {
  "use strict";
  var cfg = null, panel, logEl, form, input, sendBtn, quickEl, closeBtn, built = false, busy = false, opened = false;
  var msgs = [];      /* что отправляется боту: [{role, text}] */
  var ui = [];        /* что показано в ленте (для восстановления из sessionStorage) */
  var HISTORY_MAX = 12, ASSISTANT_MAX = 800;   /* в историю уходят последние 12 сообщений; ответы бота обрезаются до 800 символов */
  var PHONE = "+7 978 728-00-02", EMAIL = "apv0050@gmail.com", KEY = "ne_chat_v1";
  var WELCOME = "Здравствуйте! Я ИИ-консультант НОВОЙ ЭНЕРДЖИ. Подскажу, какая станция подойдёт под ваши приборы и на сколько часов её хватит. Напишите, что нужно питать, и сколько часов автономии нужно.";
  var QUICK = ["Подобрать под мои приборы", "Хватит ли на холодильник и котёл?", "Как заряжается станция?", "Сроки и гарантия"];
  var QUICK_TEXT = { "Подобрать под мои приборы": "Хочу подобрать станцию под мои приборы" };
  var mqMobile = window.matchMedia && window.matchMedia("(max-width: 760px)");

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function store(write) {
    try {
      if (write) sessionStorage.setItem(KEY, JSON.stringify({ msgs: msgs, ui: ui.slice(-40) }));
      else { var raw = sessionStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; }
    } catch (e) { return null; }
  }

  /* телефон и почта в ответе становятся ссылками; остальное — текст (без HTML) */
  function fill(node, text) {
    String(text).split(/(\+7 978 728-00-02|apv0050@gmail\.com)/).forEach(function (part) {
      if (part === PHONE) { var a = el("a", null, part); a.href = "tel:+79787280002"; node.appendChild(a); }
      else if (part === EMAIL) { var m = el("a", null, part); m.href = "mailto:" + EMAIL; node.appendChild(m); }
      else if (part) node.appendChild(document.createTextNode(part));
    });
  }
  function scrollDown() { logEl.scrollTop = logEl.scrollHeight; }

  function addBubble(role, text) {
    var b = el("div", "chat-m " + (role === "user" ? "chat-user" : "chat-bot"));
    String(text).split(/\n+/).forEach(function (line, i) { var p = el("p"); fill(p, line); b.appendChild(p); });
    logEl.appendChild(b); scrollDown();
    return b;
  }
  function priceText(c) { return c.price > 0 ? cfg.fmtPrice(c.price) + " с доставкой" : "цена по запросу"; }
  function addCards(cards) {
    if (!cards || !cards.length) return;
    var wrap = el("div", "chat-cards");
    cards.forEach(function (c) {
      var card = el("div", "chat-card");
      card.appendChild(el("b", "cc-t", c.title + " · " + c.code));
      card.appendChild(el("span", "cc-s", c.power.toLocaleString("ru-RU") + " Вт · " + (c.cap / 1000).toLocaleString("ru-RU") + " кВт·ч" + (c.hours ? " · " + c.hours : "")));
      card.appendChild(el("span", "cc-p", priceText(c)));
      if (c.note) card.appendChild(el("span", "cc-n", c.note));
      var go = el("button", "chat-go", "К карточке"); go.type = "button";
      go.addEventListener("click", function () {
        if (mqMobile && mqMobile.matches) close(true);
        cfg.goToCode(c.code);
      });
      card.appendChild(go);
      wrap.appendChild(card);
    });
    logEl.appendChild(wrap); scrollDown();
  }
  function addHandoff() {
    var row = el("div", "chat-handoff");
    var tel = el("a", "btn primary sm", "Позвонить"); tel.href = "tel:+79787280002";
    var mail = el("a", "btn sm", "Написать на почту"); mail.href = "mailto:" + EMAIL;
    row.appendChild(tel); row.appendChild(mail);
    logEl.appendChild(row); scrollDown();
  }
  function render(item) {
    addBubble(item.role, item.text);
    if (item.role === "bot") { addCards(item.cards); if (item.handoff) addHandoff(); }
  }

  function setBusy(v) {
    busy = v; sendBtn.disabled = v; input.disabled = v;
    var t = logEl.querySelector(".chat-typing");
    if (v && !t) { t = el("div", "chat-typing", "Консультант печатает"); t.setAttribute("role", "status"); logEl.appendChild(t); scrollDown(); }
    if (!v && t) t.parentNode.removeChild(t);
    if (!v && opened) input.focus();
  }

  function send(text) {
    text = String(text || "").trim();
    if (!text || busy) return;
    if (text.length > 500) text = text.slice(0, 500);
    quickEl.hidden = true;
    var u = { role: "user", text: text };
    ui.push(u); render(u);
    msgs.push({ role: "user", text: text });
    if (msgs.length > HISTORY_MAX) msgs = msgs.slice(-HISTORY_MAX);
    input.value = ""; resize();
    setBusy(true);
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000);
    fetch(cfg.url.replace(/\/+$/, "") + "/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: payload() }),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) { return r.json(); }).then(function (d) {
      clearTimeout(timer);
      var item = { role: "bot", text: String(d.reply || ""), cards: d.cards || [], handoff: !!d.handoff };
      if (!item.text) throw new Error("empty");
      msgs.push({ role: "assistant", text: item.text }); ui.push(item); store(true);
      setBusy(false); render(item);
    }).catch(function () {
      clearTimeout(timer);
      var item = { role: "bot", text: "Сейчас не могу ответить, позвоните " + PHONE + " или напишите на " + EMAIL, cards: [], handoff: true };
      msgs.pop(); ui.push(item); store(true);   /* сообщение клиента не попадает в историю, если ответа не было */
      setBusy(false); render(item);
    });
  }

  /* что уходит на сервер: только role и text, последние сообщения; длинные ответы бота обрезаются (карточек и служебных данных нет) */
  function payload() {
    return msgs.slice(-HISTORY_MAX).map(function (m) {
      return { role: m.role, text: m.role === "assistant" ? String(m.text).slice(0, ASSISTANT_MAX) : String(m.text) };
    });
  }

  function resize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 96) + "px"; }

  function build() {
    if (built) return; built = true;
    panel = el("div", "chat"); panel.id = "chatPanel"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Чат с консультантом"); panel.hidden = true;
    var hd = el("div", "chat-hd"); hd.appendChild(el("b", null, "Консультант НОВАЯ ЭНЕРДЖИ"));
    closeBtn = el("button", "chat-x", "×"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", "Закрыть чат");
    closeBtn.addEventListener("click", function () { close(true); });
    hd.appendChild(closeBtn); panel.appendChild(hd);
    panel.appendChild(el("p", "chat-note", "Отвечает ИИ-консультант, расчёт справочный — точный подтвердит менеджер. Не указывайте в чате персональные данные."));
    logEl = el("div", "chat-log"); logEl.setAttribute("role", "log"); logEl.setAttribute("aria-live", "polite"); logEl.setAttribute("aria-label", "Переписка");
    panel.appendChild(logEl);
    quickEl = el("div", "chat-quick");
    QUICK.forEach(function (q) {
      var b = el("button", "chat-q", q); b.type = "button";
      b.addEventListener("click", function () { send(QUICK_TEXT[q] || q); });
      quickEl.appendChild(b);
    });
    panel.appendChild(quickEl);
    form = el("form", "chat-form");
    input = el("textarea"); input.rows = 1; input.maxLength = 500; input.setAttribute("aria-label", "Ваше сообщение"); input.placeholder = "Напишите, что нужно питать";
    input.addEventListener("input", resize);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); } });
    sendBtn = el("button", "chat-send", "Отправить"); sendBtn.type = "submit";
    form.appendChild(input); form.appendChild(sendBtn);
    form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value); });
    panel.appendChild(form);
    var legalEl = el("div", "chat-legal");
    legalEl.innerHTML = 'Отправляя сообщение, вы соглашаетесь с <a href="privacy.html" target="_blank" rel="noopener">Политикой обработки персональных данных</a>';
    panel.appendChild(legalEl);
    document.body.appendChild(panel);

    var saved = store(false);
    if (saved && saved.ui && saved.ui.length) {
      msgs = (saved.msgs || []).slice(-HISTORY_MAX); ui = saved.ui;
      ui.forEach(render); quickEl.hidden = true;
    } else { addBubble("bot", WELCOME); }

    /* Esc закрывает; Tab не уходит за пределы панели */
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        var f = panel.querySelectorAll("button:not([disabled]),a[href],textarea:not([disabled])");
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && opened) { e.preventDefault(); close(true); } });
  }

  function open() {
    build();
    if (opened) { input.focus(); return; }
    opened = true; panel.hidden = false;
    cfg.button.setAttribute("aria-expanded", "true");
    requestAnimationFrame(function () { panel.classList.add("on"); input.focus(); scrollDown(); });
  }
  function close(returnFocus) {
    if (!opened) return;
    opened = false; panel.classList.remove("on"); panel.hidden = true;
    cfg.button.setAttribute("aria-expanded", "false");
    if (returnFocus && getComputedStyle(cfg.button).display !== "none") cfg.button.focus();
  }
  function toggle() { if (opened) close(true); else open(); }

  window.NEchat = {
    init: function (c) { cfg = c; },
    open: open, close: close, toggle: toggle
  };
})();
