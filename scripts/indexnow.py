#!/usr/bin/env python3
"""Уведомление поисковиков об адресах сайта по протоколу IndexNow (Яндекс и Bing). Запуск из корня репозитория:

    python scripts/indexnow.py            только показать, что будет отправлено (ничего не отправляется)
    python scripts/indexnow.py --send     отправить адреса из sitemap.xml

Не запускать, пока сайт не опубликован на боевом адресе: перед отправкой скрипт проверяет, что файл ключа
https://<домен>/<ключ>.txt отдаётся и содержит ключ; если нет, отправка не выполняется.

Ключ лежит в scripts/seo.json (indexnow_key), файл <ключ>.txt в корне сайта. Ключ публичный по замыслу протокола (его читает поисковик),
секретом не является. Адреса берутся только из sitemap.xml (канонические страницы). Запускать после публикации заметных изменений:
новые или переписанные страницы, обновлённые цены и данные.
"""
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENDPOINTS = ["https://yandex.com/indexnow", "https://www.bing.com/indexnow"]


def main():
    send = "--send" in sys.argv[1:]
    key = json.loads((ROOT / "scripts" / "seo.json").read_text(encoding="utf-8")).get("indexnow_key", "").strip()
    if not re.fullmatch(r"[0-9a-f]{8,128}", key):
        sys.exit("scripts/seo.json: indexnow_key пуст или имеет неверный вид")
    key_file = ROOT / (key + ".txt")
    if not key_file.exists() or key_file.read_text(encoding="utf-8").strip() != key:
        sys.exit("В корне нет файла %s.txt с ключом внутри" % key)
    urls = re.findall(r"<loc>(.*?)</loc>", (ROOT / "sitemap.xml").read_text(encoding="utf-8"))
    if not urls:
        sys.exit("В sitemap.xml нет адресов")
    m = re.match(r"(https://[^/]+)/", urls[0])
    if not m:
        sys.exit("Адрес в sitemap.xml должен начинаться с https://")
    origin = m.group(1)
    host = origin.split("://", 1)[1]
    if any(not u.startswith(origin + "/") for u in urls):
        sys.exit("В sitemap.xml адреса с разными доменами")
    key_url = "%s/%s.txt" % (origin, key)
    body = {"host": host, "key": key, "keyLocation": key_url, "urlList": urls}

    print("Домен: %s; адресов: %d; файл ключа: %s" % (host, len(urls), key_url))
    if not send:
        print("Режим просмотра: ничего не отправлено. Для отправки: python scripts/indexnow.py --send")
        for u in urls[:3]:
            print("  ", u)
        print("   …")
        return

    try:
        got = urllib.request.urlopen(urllib.request.Request(key_url, headers={"Cache-Control": "no-cache"}), timeout=20).read().decode("utf-8").strip()
    except Exception as e:
        sys.exit("Файл ключа %s не отдаётся (%s): сайт ещё не опубликован? Отправка отменена." % (key_url, type(e).__name__))
    if got != key:
        sys.exit("Файл ключа по адресу %s содержит другой текст. Отправка отменена." % key_url)

    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    failed = 0
    for ep in ENDPOINTS:
        req = urllib.request.Request(ep, data=data, method="POST", headers={"Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print("%s -> %d" % (ep, r.status))
        except urllib.error.HTTPError as e:
            failed += 1
            print("%s -> %d (%s)" % (ep, e.code, "ключ не найден или неверен" if e.code in (403, 422) else "ошибка"))
        except Exception as e:
            failed += 1
            print("%s -> нет связи (%s)" % (ep, type(e).__name__))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
