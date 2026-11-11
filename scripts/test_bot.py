#!/usr/bin/env python3
"""Тесты чат-консультанта против РЕАЛЬНЫХ локальных серверов бота (tests/bot_cases.json). Без внешних зависимостей.

Серверы запускаются отдельно (см. bot/README.md), с TEST_TRACE=1 (в ответ добавляется trace с результатами инструментов):
  main — обычный бот;  bad — PROXY_URL указывает в пустоту (недоступный провайдер);
  zero — KB_URL на копию базы знаний, где у Z2800-3800-L цена 0;  rate — как bad, но RATE_LIMIT=2.

Запуск:  python scripts/test_bot.py --main http://localhost:38701 --bad http://localhost:38702 \\
                                    --zero http://localhost:38703 --rate http://localhost:38704 [--only id] [--json out.json]

Автопроверка чисел: каждое число в ответе (цена, часы, Вт...) должно присутствовать в результатах инструментов,
в базе знаний (правила, FAQ, контакты) или в сообщении клиента. Целые 1–3 (счёт «1 вариант») не проверяются;
для значений в тысячах допускается пересчёт Вт → кВт.
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def nums(text):
    t = str(text)
    while True:
        t2 = re.sub(r"(?<=\d)[  ](?=\d{3}(?!\d))", "", t)
        if t2 == t:
            break
        t = t2
    return {float(x) for x in re.findall(r"\d+(?:[.,]\d+)?", t.replace(",", "."))}


def http(method, url, body=None, origin=None, timeout=45):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    if origin:
        req.add_header("origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")
    except Exception as e:  # недоступен сам сервер бота
        return 0, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--main", required=True)
    ap.add_argument("--bad")
    ap.add_argument("--zero")
    ap.add_argument("--rate")
    ap.add_argument("--origin", default="http://localhost:8765")
    ap.add_argument("--kb", default=str(ROOT / "data" / "kb.json"))
    ap.add_argument("--cases", default=str(ROOT / "tests" / "bot_cases.json"))
    ap.add_argument("--only")
    ap.add_argument("--json")
    ap.add_argument("--pause", type=float, default=0.4)
    a = ap.parse_args()
    targets = {"main": a.main, "bad": a.bad, "zero": a.zero, "rate": a.rate}

    kb = json.loads(Path(a.kb).read_text(encoding="utf-8"))
    st_by = {s["code"]: s for s in kb["stations"]}
    ld_by = {l["id"]: l for l in kb["loads"]}
    static_nums = set()
    for txt in kb["rules"] + kb["clarify"] + [f["q"] + " " + f["a"] for f in kb["faq"]] + [kb["contacts"]["phone"], kb["contacts"]["email"]]:
        static_nums |= nums(txt)
    cases = json.loads(Path(a.cases).read_text(encoding="utf-8"))
    if a.only:
        cases = [c for c in cases if c["id"] in a.only.split(",")]

    results = []
    for case in cases:
        base = targets.get(case["target"])
        if not base:
            results.append({"id": case["id"], "name": case["name"], "ok": None, "fails": ["пропущен: не задан сервер " + case["target"]], "ms": 0})
            continue
        t0 = time.time(); fails = []; status = 0; resp = {}; reply = ""; cards = []
        origin = case.get("origin", a.origin)
        if case.get("kind") == "health":
            status, raw = http("GET", base + "/health")
            try: resp = json.loads(raw)
            except Exception: resp = {}
            if not resp.get("ok"): fails.append("ответ /health без ok=true")
        else:
            msgs = case.get("messages") or [{"role": "user", "text": "x" * case.get("long", 1)}]
            if case.get("long"): msgs = [{"role": "user", "text": "Подберите станцию " + "для холодильника " * 40}][:1]; msgs[0]["text"] = (msgs[0]["text"] * 2)[:case["long"] + 50]
            reps = 3 if case.get("kind") == "rate" else 1
            for _ in range(reps):
                status, raw = http("POST", base + "/chat", {"messages": msgs}, origin)
                time.sleep(0.2)
            try: resp = json.loads(raw)
            except Exception: resp = {}; fails.append("ответ не JSON: " + raw[:80])
            reply = resp.get("reply", ""); cards = resp.get("cards", [])
        tools = (resp.get("trace") or {}).get("tools", [])

        def need(cond, msg):
            if not cond: fails.append(msg)

        for ch in case["checks"]:
            t = ch["t"]
            if t == "status": need(status == ch["v"], "HTTP %s, ожидался %s" % (status, ch["v"]))
            elif t == "handoff": need(bool(resp.get("handoff")) == ch["v"], "handoff=%s, ожидался %s" % (resp.get("handoff"), ch["v"]))
            elif t == "no_cards": need(not cards, "есть карточки: %s" % [c["code"] for c in cards])
            elif t == "tool_min":
                sels = [x for x in tools if x["name"] == "select_stations" and x["result"].get("summary")]
                sm = sels[-1]["result"]["summary"] if sels else {}
                need(sm.get("total_watts", 0) >= ch["watts"] and sm.get("avg_watts", 0) >= ch["avg"],
                     "в select_stations переданы не все приборы: сумма %s/%s Вт, ожидалось не меньше %s/%s" % (sm.get("total_watts"), sm.get("avg_watts"), ch["watts"], ch["avg"]))
            elif t == "cards_min": need(len(cards) >= ch["n"], "карточек %d, нужно не меньше %d" % (len(cards), ch["n"]))
            elif t == "tool_called": need(any(x["name"] == ch["name"] for x in tools), "не вызван инструмент " + ch["name"])
            elif t == "has": need(any(re.search(p, reply, re.I) for p in ch["re"]), "в ответе нет ни одного из: %s" % ch["re"])
            elif t == "has_all": need(all(re.search(p, reply, re.I) for p in ch["re"]), "в ответе нет всех из: %s" % ch["re"])
            elif t == "none":
                for p in ch["re"]:
                    m = re.search(p, reply, re.I)
                    need(not m, "в ответе запрещённое «%s»" % (m.group(0) if m else p))
            elif t == "contacts": need("978" in reply and "apv0050" in reply, "в ответе нет телефона и почты")
            elif t == "cyrillic": need(bool(re.search(r"[А-Яа-яЁё]", reply)), "ответ не на русском")
            elif t == "price":
                want = st_by[ch["code"]]["price_rub"]
                need(float(want) in nums(reply), "в ответе нет цены %s" % want)
                need(any(c["code"] == ch["code"] and c["price"] == want for c in cards), "нет карточки %s с ценой %s" % (ch["code"], want))
            elif t == "cards_fit":
                loads = [ld_by[i] for i in ch["loads"]]
                watts = sum(20 if l["watts"] is None else l["watts"] for l in loads)
                avg = sum((20 if l["watts"] is None else l["watts"]) if l["avg"] is None else l["avg"] for l in loads)
                start = max([l["start"] or 0 for l in loads] + [0])
                for c in cards:
                    s = st_by.get(c["code"])
                    if not s: fails.append("карточка с неизвестным кодом " + c["code"]); continue
                    hours = s["cap_wh"] * kb["eff"] / avg
                    need(s["power_w"] >= watts, "%s: мощность %d < нагрузки %d" % (c["code"], s["power_w"], watts))
                    need(s["peak_w"] >= start, "%s: пик %d < пусковой %d" % (c["code"], s["peak_w"], start))
                    need(hours >= ch["hours"], "%s: часов %.1f < %s" % (c["code"], hours, ch["hours"]))
                    need(c["price"] == s["price_rub"], "%s: цена в карточке %s, в каталоге %s" % (c["code"], c["price"], s["price_rub"]))
        if case.get("numbers", True) and reply:
            allowed = set(static_nums)
            for m in case.get("messages") or []: allowed |= nums(m["text"])
            for x in tools: allowed |= nums(json.dumps(x["result"], ensure_ascii=False))
            for v in list(allowed):
                if v >= 100 and v % 100 == 0: allowed.add(v / 1000)
            odd = sorted(v for v in nums(reply) if v not in allowed and not (v in (1.0, 2.0, 3.0)))
            if odd: fails.append("числа в ответе, которых нет в инструментах/базе: %s" % odd)
        results.append({"id": case["id"], "name": case["name"], "ok": not fails, "fails": fails, "ms": int((time.time() - t0) * 1000),
                        "reply": reply, "cards": [c["code"] for c in cards], "handoff": resp.get("handoff"), "status": status})
        time.sleep(a.pause)

    print("%-26s %-5s %6s  %s" % ("сценарий", "итог", "мс", "примечание"))
    for r in results:
        mark = "пропуск" if r["ok"] is None else ("PASS" if r["ok"] else "FAIL")
        print("%-26s %-5s %6d  %s" % (r["id"], mark, r["ms"], "; ".join(r["fails"])[:180]))
    done = [r for r in results if r["ok"] is not None]
    passed = sum(1 for r in done if r["ok"])
    print("\nИтого: %d из %d сценариев пройдено" % (passed, len(done)))
    if a.json:
        Path(a.json).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.exit(0 if passed == len(done) else 1)


if __name__ == "__main__":
    main()
