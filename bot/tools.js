"use strict";
/* Инструменты, которые вызывает модель. ВСЕ числа считает этот код через assets/calc.js (тот же модуль, что на сайте).
   Модель только выбирает инструмент и аргументы, а в ответе клиенту берёт числа из результатов. */

let C;
try { C = require("./calc.js"); } catch (_) { C = require("../assets/calc.js"); }

const LOAD_SYNONYMS = {
  "floor_pump": "floor_pump",
  "тёплый пол": "floor_pump",
  "теплый пол": "floor_pump",
  "водяной тёплый пол": "floor_pump",
  "водяной теплый пол": "floor_pump",
  "насос тёплого пола": "floor_pump",
  "насос теплого пола": "floor_pump",
  "циркуляционный насос": "floor_pump",
  "насос отопления": "floor_pump",
};

const declarations = [
  {
    name: "select_stations",
    description: "Подобрать станции под приборы клиента и нужное время работы. Считает код, не модель. Возвращает до 3 вариантов: минимально подходящая, с запасом по мощности, с запасом по времени; для каждого код, мощность, пик, ёмкость, цена с доставкой, часы работы и чего не хватает. Вызывай, когда известны приборы (и желательно часы автономии). В loads передай ВСЕ приборы клиента, по элементу на прибор.",
    parameters: {
      type: "object",
      properties: {
        loads: {
          type: "array",
          description: "Приборы. Для приборов из списка (list_loads) указывай id (например, boiler, floor_pump для тёплого пола, fridge, tv) и qty. Если прибора нет в списке — укажи watts (мощность при работе, Вт), avg (средняя, Вт) и start (пусковая, Вт; 0, если нет).",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "id прибора из списка (например boiler, floor_pump, fridge, router)" },
              qty: { type: "integer", description: "количество, по умолчанию 1" },
              name: { type: "string", description: "название своего прибора" },
              watts: { type: "number" }, avg: { type: "number" }, start: { type: "number" },
            },
          },
        },
        hours: { type: "number", description: "сколько часов нужна автономия (необязательно)" },
        body: { type: "string", enum: ["D", "L"], description: "D = тёмный корпус, L = светлый на колёсах; не указывай, если клиенту всё равно" },
      },
      required: ["loads"],
    },
  },
  {
    name: "get_station",
    description: "Данные одной модели по коду (например Z2800-3800-L) или по комбинации без суффикса (Z2800-3800): мощность, пик, ёмкость, цена с доставкой, предел одной розетки, зарядка, примеры времени работы.",
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
  },
  {
    name: "list_loads",
    description: "Список известных приборов: id, название, мощность при работе, средняя и пусковая (Вт).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "handoff_to_manager",
    description: "Передать клиента менеджеру: вопрос из списка «УТОЧНЯЕТСЯ», заказ, оплата, скидки, наличие, сомнения в ответе, просьба клиента.",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
  },
];

const isNum = (x) => typeof x === "number" && isFinite(x);
const clamp = (x, lo, hi, d) => (isNum(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d);
const adapt = (st) => ({ power: st.power_w, cap: st.cap_wh });
const byPrice = (a, b) => ((a.st.price_rub || 1e12) - (b.st.price_rub || 1e12)) || (a.st.power_w - b.st.power_w) || (a.st.cap_wh - b.st.cap_wh) || a.st.code.localeCompare(b.st.code);

function option(kind, e, S, hoursWanted, kb) {
  const st = e.st, notes = [];
  if (!e.fitsPower) notes.push("не хватает мощности: у станции " + st.power_w + " Вт, нагрузка " + S.t + " Вт");
  else if (!e.fitsPeak) notes.push("не хватает пиковой мощности: у станции пик " + st.peak_w + " Вт, пусковая нагрузка " + S.start + " Вт");
  if (e.fitsPower && e.fitsPeak && hoursWanted && !e.meetsTime) notes.push("мощности хватает, но времени работы меньше нужного (" + hoursWanted + " ч): нужна большая ёмкость");
  if (e.fitsPower && st.maxSocket_w && S.t > st.maxSocket_w) notes.push("нагрузка больше предела одной розетки (до " + st.maxSocket_w + " Вт): включайте приборы в разные розетки");
  if (S.avg > 0 && S.avg <= 100) notes.push("нагрузка малая: собственное потребление станции (до 50 Вт, по паспорту изделия) уменьшает реальное время");
  return {
    kind, code: st.code, title: st.title, body: st.bodyName, power_w: st.power_w, power_kw: st.power_w / 1000, peak_w: st.peak_w, cap_wh: st.cap_wh, cap_kwh: Math.round(st.cap_wh / 100) / 10,
    price_rub: st.price_rub, price_note: st.price_rub ? "цена с доставкой" : "цена по запросу",
    hours: Math.round(e.hours * 10) / 10, hours_text: C.hoursText(e.hours),
    fits_power: e.fitsPower, fits_peak: e.fitsPeak, meets_time: hoursWanted ? e.meetsTime : null, notes,
  };
}

function selectStations(args, kb) {
  const items = Array.isArray(args && args.loads) ? args.loads.slice(0, 20) : [];
  const errors = [], loads = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== "object") return;
    let base;
    const lookupKey = (it.id || it.name || "").toString().trim().toLowerCase();
    const resolvedId = LOAD_SYNONYMS[lookupKey] || it.id;
    if (resolvedId) {
      const l = kb.loads.find((x) => x.id === resolvedId || x.id.toLowerCase() === resolvedId.toLowerCase() || x.name.toLowerCase() === resolvedId.toLowerCase());
      if (l) {
        base = { name: l.name, watts: l.watts == null ? 20 : l.watts, avg: l.avg == null ? (l.watts == null ? 20 : l.watts) : l.avg, start: l.start || 0 };
      }
    }
    if (!base && it.id) {
      const l = kb.loads.find((x) => x.id === it.id);
      if (!l) { errors.push("неизвестный прибор: " + it.id); return; }
      base = { name: l.name, watts: l.watts == null ? 20 : l.watts, avg: l.avg == null ? (l.watts == null ? 20 : l.watts) : l.avg, start: l.start || 0 };
    } else if (!base && isNum(it.watts) && it.watts >= 0 && it.watts <= 30000) {
      base = { name: it.name || "прибор", watts: it.watts, avg: isNum(it.avg) ? it.avg : it.watts, start: isNum(it.start) ? it.start : 0 };
    } else if (!base) { errors.push("прибор без id и без watts"); return; }
    const q = clamp(it.qty, 1, 20, 1);
    loads.push({ key: "l" + i, name: base.name, watts: base.watts * q, avg: base.avg * q, start: base.start });
  });
  if (!loads.length) return { ok: false, error: "нет ни одного распознанного прибора", details: errors };
  const sel = {}; loads.forEach((l) => { sel[l.key] = true; });
  const S = C.selection(loads, sel);
  const hoursWanted = isNum(args.hours) && args.hours > 0 ? Math.min(args.hours, 720) : null;
  const body = args.body === "D" || args.body === "L" ? args.body : null;

  const list = kb.stations.filter((st) => !body || st.body === body).map((st) => {
    const c = adapt(st), hours = S.avg > 0 ? c.cap * kb.eff / S.avg : Infinity;
    return {
      st, hours,
      fitsPower: c.power >= S.t, fitsPeak: C.peakOf(c) >= S.start, fits: C.fits(c, S),
      meetsTime: hoursWanted ? hours >= hoursWanted : true,
    };
  });
  const ok = list.filter((e) => e.fits && e.meetsTime).sort(byPrice);
  const options = [], used = new Set();
  const add = (kind, e) => { if (e && !used.has(e.st.code)) { used.add(e.st.code); options.push(option(kind, e, S, hoursWanted, kb)); } };
  const problems = [];

  if (ok.length) {
    add("минимально подходящая", ok[0]);
    add("с запасом по мощности", ok.find((e) => !used.has(e.st.code) && e.st.power_w >= S.t * 1.3));
    const baseHours = hoursWanted || options[0].hours;
    add("с запасом по времени", ok.find((e) => !used.has(e.st.code) && e.hours >= baseHours * 1.5));
  } else {
    const fitsOnly = list.filter((e) => e.fits);
    if (fitsOnly.length) {
      /* мощности хватает, а нужного времени нет ни у одной модели: показываем самую ёмкую (из них дешевле) */
      const best = fitsOnly.slice().sort((a, b) => (b.st.cap_wh - a.st.cap_wh) || byPrice(a, b))[0];
      add("максимум по времени", best);
      problems.push("ни одна станция не даёт нужных " + hoursWanted + " ч; максимум около " + (Math.round(best.hours * 10) / 10) + " ч у модели " + best.st.code + ". Можно предложить две станции или уменьшить нагрузку.");
    } else {
      const bestPower = list.slice().sort((a, b) => (b.st.power_w - a.st.power_w) || (b.st.cap_wh - a.st.cap_wh) || byPrice(a, b))[0];
      if (bestPower) add("самая мощная из доступных", bestPower);
      problems.push(bestPower && !bestPower.fitsPower
        ? "ни одна станция не выдаёт нужной мощности (" + S.t + " Вт); максимум " + bestPower.st.power_w + " Вт"
        : "ни одна станция не проходит по пусковой нагрузке (" + S.start + " Вт)");
    }
  }
  return {
    ok: true,
    summary: { total_watts: S.t, avg_watts: S.avg, max_start_w: S.start, hours_wanted: hoursWanted, body: body },
    options, problems, errors,
    reminder: "Называй клиенту только числа из этого результата.",
  };
}

/* зарядка: диапазоны и «ориентировочно» для basis range/estimate, точное время для passport; текст готовит calc.js */
function chargeFacts(ch) {
  if (!ch || ch.basis === "none") return { basis: "none", text: "время зарядки уточняется" };
  const t = { kind: ch.basis, estimate: ch.basis !== "passport", t80: ch.t80_h, t100: ch.t100_h };
  const x = C.chargeText(t);
  return {
    basis: ch.basis, approximate: x.approx,
    to_80_percent: x.t80, to_100_percent: x.t100,
    t80_h: ch.t80_h, t100_h: ch.t100_h,
    note: x.approx ? "ориентировочно, по аналогичным моделям; точное время уточним при заказе" : "подтверждённое время",
  };
}

function stationFacts(st, kb) {
  const c = adapt(st);
  const examples = ["router", "laptop", "fridge", "kettle"].map((id) => kb.loads.find((l) => l.id === id)).filter(Boolean).map((l) => ({
    load: l.name,
    result: (c.power < l.watts || (l.start && C.peakOf(c) < l.start)) ? "не потянет" : C.hoursText(c.cap * kb.eff / l.avg),
  }));
  return {
    code: st.code, title: st.title, body: st.bodyName, group: st.group,
    power_w: st.power_w, power_kw: st.power_w / 1000, peak_w: st.peak_w, cap_wh: st.cap_wh, cap_kwh: Math.round(st.cap_wh / 100) / 10,
    price_rub: st.price_rub, price_note: st.price_rub ? "цена с доставкой" : "цена по запросу",
    max_socket_w: st.maxSocket_w,
    sockets_catalog: st.sockets_catalog, sockets_note: "по каталогу; точное число и тип розеток уточняются у менеджера",
    dc_output: st.dc_output,
    charge: chargeFacts(st.charge),
    temp_charge: st.temp_charge, temp_discharge: st.temp_discharge,
    runtime_examples: examples,
  };
}

function getStation(args, kb) {
  const raw = String((args && args.code) || "").trim().toUpperCase().replace(/\s+/g, "");
  let found = kb.stations.filter((s) => s.code.toUpperCase() === raw);
  if (!found.length) found = kb.stations.filter((s) => s.combo.toUpperCase() === raw);
  if (!found.length) return { ok: false, error: "нет такой модели", hint: "код вида Z{мощность}-{ёмкость}-{D|L}, например Z2800-3800-L" };
  return { ok: true, stations: found.map((s) => stationFacts(s, kb)) };
}

function listLoads(_args, kb) {
  return { ok: true, loads: kb.loads.map((l) => ({ id: l.id, name: l.name, watts: l.watts, avg: l.avg, start: l.start })) };
}

function execute(name, args, kb) {
  switch (name) {
    case "select_stations": return selectStations(args || {}, kb);
    case "get_station": return getStation(args || {}, kb);
    case "list_loads": return listLoads(args || {}, kb);
    case "handoff_to_manager": return { ok: true, contacts: kb.contacts };
    default: return { ok: false, error: "неизвестный инструмент" };
  }
}

module.exports = { declarations, execute };
