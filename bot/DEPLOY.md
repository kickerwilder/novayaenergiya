# Запуск на сервере (VPS, Москва, Ubuntu 24.04)

Один сервер, несколько сервисов. Здесь: чат-бот (Docker) и размещение сайта (Caddy). Секретов, паролей и адресов сервера в этом файле нет: подставляйте свои значения только на сервере.
Файл лежит в `bot/` и на сайт не публикуется (`_config.yml`, исключения деплоя, закрытые пути в Caddy).

> ### Замените на сервере (в репозиторий реальные значения не вносить)
>
> | Плейсхолдер в `/etc/caddy/Caddyfile` | Что подставить | Где в файле |
> | --- | --- | --- |
> | **`ВАШ_EMAIL`** | e-mail для уведомлений Let's Encrypt | первый блок `{ … }` |
> | **`ХЭШ_ПАРОЛЯ`** | вывод `caddy hash-password` (пароль тестового стенда) | блок `preview.novaya-energy.ru` |
>
> Проверка, что в действующих строках ничего не осталось (вывод пустой): `grep -nE '^[^#]*(ВАШ_EMAIL|ХЭШ_ПАРОЛЯ)' /etc/caddy/Caddyfile`
>
> Значения в угловых скобках и слово `ПАРОЛЬ` в командах ниже тоже подставляются только в своей консоли.

Перенос сайта на этот сервер: раздел 3 «Перенос сайта с GitHub Pages».

Что понадобится: Ubuntu 24.04 с доступом по SSH (пользователь с `sudo`), домен `novaya-energy.ru` с управлением DNS, ключ Google AI Studio, SOCKS5 или HTTP прокси для Gemini и Telegram (сервер в Москве, они напрямую недоступны), бот в Telegram (создаётся у @BotFather) и аккаунт менеджера, которому будут приходить обращения.

## 1. Подготовка сервера

```bash
sudo apt update && sudo apt install -y ca-certificates curl git ufw rsync
# Docker (официальный репозиторий) и плагин compose: https://docs.docker.com/engine/install/ubuntu/
# Caddy (официальный репозиторий): https://caddyserver.com/docs/install#debian-ubuntu-raspbian
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

Прокси нужен только боту (запросы к LLM и Telegram). На сервере его не включать глобально: `apt`, `git`, `curl` ходят напрямую. Порт бота 8787 снаружи не открывается (в `ufw` его нет): он слушает только `127.0.0.1`.

## 2. Бот

1. **Код.** Репозиторий (после перехода станет закрытым) клонируется на сервер по deploy-ключу с доступом «только чтение» (GitHub → Settings → Deploy keys):
   ```bash
   sudo mkdir -p /opt/novaya-bot && sudo chown "$USER": /opt/novaya-bot
   git clone git@github.com:kickerwilder/novayaenergiya.git /opt/novaya-bot/repo
   cd /opt/novaya-bot/repo/bot
   ```
2. **Настройки.** Создайте `bot/.env` по образцу `example.env` и заполните (файл в `.gitignore`, в чаты и в репозиторий не вставлять):
   ```bash
   cp example.env .env && chmod 600 .env && nano .env
   ```
   | Переменная | Что внести |
   | --- | --- |
   | `PROVIDER` | `gemini` (по умолчанию) или `openai`; смена провайдера: раздел 5 |
   | `PROVIDER_API_KEY` | ключ Google AI Studio (лучше отдельный проект и отдельный ключ); для другого провайдера ключ из его личного кабинета |
   | `PROXY_URL` | `http://ЛОГИН:ПАРОЛЬ@ХОСТ:ПОРТ` или `socks5://…`; рабочий вариант проверен с HTTP-прокси (`http://ЛОГИН:ПАРОЛЬ@ХОСТ:ПОРТ`); SOCKS5 у некоторых провайдеров зависает, тогда используйте HTTP; спецсимволы в логине и пароле кодируются в процентной записи (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`, `%` → `%25`, пробел → `%20`); только для LLM и Telegram; пусто = напрямую |
   | `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather |
   | `TELEGRAM_MANAGER_CHAT_ID` | chat id менеджера (см. шаг 4) |
   | `MODEL`, `FALLBACK_MODEL` | по образцу; менять при смене моделей Gemini или провайдера |
   | `LLM_USE_PROXY` | `1` (по умолчанию): к модели через `PROXY_URL`; `0`: к модели напрямую (прокси только для Telegram) |
   | `ALLOWED_ORIGINS` | `https://novaya-energy.ru,https://www.novaya-energy.ru` |
   | `ALLOW_LOCALHOST` | `0` на сервере |
   | `KB_URL` | пусто: бот читает `/srv/site/data/kb.json`, который деплой сайта обновляет вместе с сайтом (права: пункт 3.1). Запасной вариант: `https://novaya-energy.ru/data/kb.json` (бот скачивает базу с сайта напрямую, без `PROXY_URL`, кэш 5 минут) |
   | `DAILY_CAP`, `RATE_LIMIT`, `RATE_WINDOW_S` | лимиты (по умолчанию 500 в сутки, 20 запросов за 600 с на клиента) |

   Остальное (`PORT`, `HOST`, `TRUST_PROXY`) задаёт `docker-compose.yml`.
3. **Проверка прокси** (значения из `.env` в консоль не выводятся). Обе команды должны вернуть HTTP-код, а не ошибку соединения (для `api.telegram.org` обычно `302`, `200` или `404`, для Gemini `404`):
   ```bash
   set -a; . ./.env; set +a
   # для socks5:// в curl используйте socks5h:// (DNS-имя разрешает прокси)
   P="${PROXY_URL/#socks5:\/\//socks5h://}"
   curl -sS -m 15 -x "$P" -o /dev/null -w "telegram: %{http_code}\n" https://api.telegram.org/
   curl -sS -m 15 -x "$P" -o /dev/null -w "gemini:   %{http_code}\n" https://generativelanguage.googleapis.com/
   unset PROVIDER_API_KEY TELEGRAM_BOT_TOKEN PROXY_URL P
   ```
   Если оба запроса возвращают код, прокси годится. Если нет: проверьте логин, пароль (спецсимволы кодируются), порт, что прокси допускает HTTPS (CONNECT) и что выходной адрес прокси не заблокирован; если `socks5://` зависает, переключитесь на `http://`.
   То же делает `node proxy_check.js` (в папке `bot/`): он печатает только схему прокси (`http` или `socks5`) и итог по каждому адресу, без логина, пароля и хоста; `node proxy_check.js --gemini` добавляет 10 запросов «Ответь ОК» к Gemini API.
4. **Chat id менеджера.** Менеджер открывает вашего бота в Telegram и пишет ему любое сообщение (например, `/start`). Затем (вебхук не используется, бот опрашивает `getUpdates` через `PROXY_URL`):
   ```bash
   docker compose run --rm bot node tg_chat_id.js
   ```
   Скрипт печатает id и название чатов (тексты сообщений не выводит). Впишите нужный id в `TELEGRAM_MANAGER_CHAT_ID`. Если скрипт отвечает ошибкой, убедитесь, что у бота не включён вебхук.
5. **Запуск.** Перед первым запуском создайте каталог сайта с правами из пункта 3.1: если `/srv/site/data` нет, Docker создаст его от root, и деплой не сможет в него писать, а при пустом каталоге у бота не будет базы знаний (тогда временно задайте `KB_URL`).
   ```bash
   docker compose up -d --build
   curl -s http://127.0.0.1:8787/health        # {"ok":true}
   docker compose ps                            # состояние healthy
   docker compose logs --tail 50 bot            # в логах нет текстов диалогов и контактов клиентов
   ```
6. **Caddy и поддомен бота.** Нужен Caddy 2.8 или новее. В DNS создайте A-запись `bot.novaya-energy.ru` на адрес сервера. Затем:
   ```bash
   sudo cp /opt/novaya-bot/repo/bot/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile        # e-mail вместо ВАШ_EMAIL; пока основной домен смотрит на GitHub, закомментируйте блоки www.novaya-energy.ru и novaya-energy.ru (пункт 3.2)
   caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```
   Проверка снаружи:
   ```bash
   curl -s https://bot.novaya-energy.ru/health                                   # {"ok":true}
   curl -sI https://bot.novaya-energy.ru/ | grep -i x-robots-tag                  # noindex, nofollow
   curl -s https://bot.novaya-energy.ru/robots.txt                                # Disallow: /
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://bot.novaya-energy.ru/chat \
        -H 'content-type: application/json' -H 'Origin: https://evil.example' -d '{"messages":[{"role":"user","text":"привет"}]}'   # 403
   ```
7. **Подключение чата к сайту.** В `assets/chat-launcher.js` задайте адрес бота: `var CHAT_URL = "https://bot.novaya-energy.ru";` (постоянная вверху файла; один адрес для главной и всех страниц моделей), закоммитьте и выложите сайт. При пустом значении кнопка чата на сайте не показывается. Если бот недоступен (сеть, таймаут, ошибка), виджет показывает контакты менеджера вместо ошибки.
8. **Проверка уведомления.** Задайте на сайте вопрос, на который бот отправит к менеджеру (например, «Какая мощность зарядного устройства у ZF28-2003.8?»): менеджеру придёт сообщение с сутью вопроса (телефоны, e-mail и ФИО заменены метками) и временем, один раз на диалог.

Обновление бота: `cd /opt/novaya-bot/repo && git pull && cd bot && docker compose up -d --build`. Смена ключа или прокси: правка `.env` и `docker compose up -d`.

## 3. Перенос сайта с GitHub Pages

Сайт переезжает с GitHub Pages на сервер: статические файлы в `/srv/site`, раздаёт Caddy (`bot/deploy/Caddyfile`). Канонический адрес `https://novaya-energy.ru/` (без `www`), `www` редиректит на него; адреса страниц не меняются. Внутренние пути (`data/source`, `data/naming.json`, `README.md`, `SKILL.md`, `.claude`, `.github`, `scripts`, `tests`, `bot`, `.git`, `_config.yml`, `CNAME`) в выкладку не попадают и в Caddy закрыты (404).

**Сайт открыт для индексации, и при переезде это не меняется:** в страницах нет метатега `noindex` (`INDEXABLE = True` в `scripts/indexing.py`), на основном домене в `Caddyfile` нет заголовка `X-Robots-Tag`. Адреса страниц, `robots.txt` и `sitemap.xml` те же. Закрыты всегда: поддомен `bot` и тестовый стенд `preview` (заголовок `X-Robots-Tag`, стенд ещё и паролем), страница 404 (метатег). Проверки индексации и поисковые кабинеты: пункт 3.12.

До пункта 3.9 GitHub Pages остаётся включённым: это путь отката.

Порядок: 3.1 сервер → 3.2 тестовый стенд → 3.3 секреты → 3.4 ручная выкладка → 3.5 TTL → 3.6 переключение DNS → 3.7 проверки → 3.8 откат (если нужен) → 3.9 отключение Pages → 3.10 автодеплой → 3.11 HSTS на год → 3.12 индексация и поисковые кабинеты.

Что делает выкладка (`.github/workflows/deploy.yml`): проверяет, что закоммиченная сборка актуальна; складывает файлы сайта без внутренних путей в `_site`; сохраняет копию сборки; копирует `_site/` в `/srv/site/` командой `rsync -az --delete`; проверяет сайт по HTTPS (smoke-тест). На сервер пишет только этот `rsync`, назначение `/srv/site/` задано в команде. `--delete` удаляет только то, что лежит внутри `/srv/site` и чего нет в сборке (в том числе положенное туда вручную: не храните там ничего своего). Вне `/srv/site` ничего не меняется.

### 3.1. Сервер: пользователь деплоя и права

```bash
sudo apt install -y rsync
sudo adduser --disabled-password --gecos "" deploy
sudo mkdir -p /srv/site/data
sudo chown -R deploy:caddy /srv/site                        # -R исправляет и каталог data, если его раньше создал Docker от root
sudo find /srv/site -type d -exec chmod 755 {} +
sudo find /srv/site -type f -exec chmod 644 {} +
sudo -u deploy mkdir -p -m 700 /home/deploy/.ssh
sudo -u deploy ssh-keygen -t ed25519 -f /home/deploy/.ssh/id_deploy -N "" -C "github-deploy"
sudo -u deploy sh -c 'cat /home/deploy/.ssh/id_deploy.pub >> /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys'
```

Это публичная статика, поэтому читать её могут все: каталоги `755`, файлы `644`. Так файлы читают и Caddy (пользователь `caddy`), и бот в контейнере (непривилегированный пользователь, не входит в группу `caddy`), которому нужен `/srv/site/data/kb.json`. Писать может только `deploy` (без sudo и без пароля). Выкладка сама держит эти права (`rsync --chmod=D755,F644`). Дополнительная защита по желанию: ограничить ключ в `authorized_keys` командой `rrsync`.

Проверка:
```bash
stat -c '%a %U:%G %n' /srv /srv/site /srv/site/data         # /srv/site и data: 755 deploy:caddy; у /srv должно быть право входа для всех
sudo -u nobody ls /srv/site/data > /dev/null && echo "чтение: ok"
sudo -u nobody test -w /srv/site && echo "ПЛОХО: пишет посторонний" || echo "запись посторонним закрыта: ok"
```

Если бот уже работает, посмотрите, откуда он сейчас берёт базу знаний (команда печатает только число): `grep -c '^KB_URL=http' /opt/novaya-bot/repo/bot/.env` (`1` — скачивает по адресу, `0` — читает `/srv/site/data/kb.json`). После изменения прав и каталога перезапустите контейнер: `cd /opt/novaya-bot/repo/bot && docker compose up -d --force-recreate`.

**Запасной вариант**, если бот не читает файл из тома: в `bot/.env` задайте `KB_URL=https://novaya-energy.ru/data/kb.json` и выполните `docker compose up -d`. Бот будет скачивать базу с сайта напрямую (не через `PROXY_URL`), кэш 5 минут; при временном сбое работает на прошлой копии.

### 3.2. Тестовый стенд preview.novaya-energy.ru

1. В DNS создайте A-запись `preview.novaya-energy.ru` на сервер (TTL 300).
2. Обновите конфигурацию Caddy (нужна версия 2.8 или новее: `caddy version`):
   ```bash
   sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
   sudo cp /opt/novaya-bot/repo/bot/deploy/Caddyfile /etc/caddy/Caddyfile
   caddy hash-password                  # спросит пароль для стенда и напечатает хэш
   sudo nano /etc/caddy/Caddyfile
   ```
   В файле:
   - впишите e-mail вместо `ВАШ_EMAIL`;
   - **пока DNS основного домена смотрит на GitHub**, закомментируйте блоки `www.novaya-energy.ru { … }` и `novaya-energy.ru { … }` (иначе Caddy будет безуспешно запрашивать для них сертификаты и может упереться в лимиты Let's Encrypt); блок `bot.novaya-energy.ru` не трогайте;
   - раскомментируйте блок `preview.novaya-energy.ru` и вставьте хэш вместо `ХЭШ_ПАРОЛЯ`.
3. Примените:
   ```bash
   grep -nE '^[^#]*(ВАШ_EMAIL|ХЭШ_ПАРОЛЯ)' /etc/caddy/Caddyfile      # пусто
   sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   curl -s -o /dev/null -w "%{http_code}\n" https://preview.novaya-energy.ru/     # 401: пароль спрашивается
   curl -s https://bot.novaya-energy.ru/health                                    # {"ok":true}: бот не задет
   ```

### 3.3. Секреты GitHub Actions (5 штук)

Где: репозиторий на GitHub → Settings → Secrets and variables → Actions → вкладка Secrets → New repository secret. Значения вписываются только туда: не в репозиторий, не в чаты.

| Имя | Что внести |
| --- | --- |
| `DEPLOY_SSH_KEY` | закрытый ключ целиком, вместе с первой и последней строками: `sudo cat /home/deploy/.ssh/id_deploy` |
| `DEPLOY_KNOWN_HOSTS` | вывод `ssh-keyscan -t ed25519 <адрес-сервера>` (если порт не 22, добавьте `-p ПОРТ`); адрес тот же, что в `DEPLOY_HOST`. Отпечаток сверьте на сервере: `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` и `ssh-keyscan -t ed25519 <адрес-сервера> \| ssh-keygen -lf -` |
| `DEPLOY_HOST` | адрес сервера (не `novaya-energy.ru`: до переключения он ведёт на GitHub) |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PORT` | порт SSH (`22`, если не меняли) |

После того как ключ внесён в секрет, удалите закрытую половину с сервера и её копии у себя: `sudo shred -u /home/deploy/.ssh/id_deploy` (в `authorized_keys` остаётся открытая). Порт SSH должен быть открыт для всех адресов: у запусков GitHub Actions адреса меняются.

### 3.4. Ручная выкладка и проверка стенда

1. GitHub → Actions → **deploy-site** → Run workflow, ветка `main`, **флажок smoke-теста снимите**: домен ещё ведёт на GitHub, и тест это обнаружит и завершится ошибкой.
2. На сервере:
   ```bash
   stat -c '%a %U:%G %n' /srv/site /srv/site/data /srv/site/data/kb.json /srv/site/index.html     # 755, 755, 644, 644
   cd /opt/novaya-bot/repo/bot && docker compose exec bot node -e "JSON.parse(require('fs').readFileSync('/app/data/kb.json','utf8')); console.log('kb.json читается')"
   ```
3. Стенд (подставьте пароль стенда; в историю команд он попадёт, поэтому после проверки смените его или уберите блок):
   ```bash
   B=https://preview.novaya-energy.ru; A="-u preview:ПАРОЛЬ"
   for p in "" privacy.html models/z1600-5000.html data/kb.json data/catalog.js assets/app.js sitemap.xml robots.txt; do curl -s $A -o /dev/null -w "%{http_code}  /$p\n" "$B/$p"; done      # все 200
   for p in data/source/station_specs.json data/source/product_types.json data/naming.json README.md SKILL.md scripts/build_seo.py tests/bot_cases.json bot/DEPLOY.md .git/config .github/workflows/deploy.yml _config.yml CNAME net-takoj-stranicy; do curl -s $A -o /dev/null -w "%{http_code}  /$p\n" "$B/$p"; done   # все 404
   curl -s $A "$B/" | grep -c 'name="robots"'                                    # 0: страницы открытого сайта без метатега (стенд закрыт паролем и заголовком)
   curl -sI $A "$B/" | grep -iE "^(HTTP|x-robots-tag|strict-transport|cache-control|etag|content-type-options|x-frame)"     # no-cache, max-age=300; x-robots-tag: noindex, nofollow (только на стенде)
   curl -sI $A "$B/assets/app.js" | grep -i "^cache-control"                     # public, max-age=300, must-revalidate
   curl -sI $A "$B/img/hero.mp4" | grep -i "^cache-control"                      # public, max-age=2592000
   curl -s $A -o /dev/null -D - -r 0-99 "$B/img/hero.mp4" | grep -iE "^(HTTP|content-range|accept-ranges)"     # 206, bytes 0-99/…
   ```
4. Откройте стенд в браузере (компьютер и телефон): главная, каталог, страница модели, видео, «Назад». Чат на стенде отвечать не будет (покажет контакты менеджера): адреса `preview` нет в `ALLOWED_ORIGINS`. Это ожидаемо, чат проверяется после переключения.

Если какой-то код или заголовок отличается, DNS не переключайте: разберитесь (`journalctl -u caddy`).

### 3.5. Снижение TTL до 300

**За 1–2 суток до переключения** (не меньше прежнего TTL):

1. Запишите **все** текущие записи и их TTL в файл вне репозитория: без них откат займёт больше времени.
   ```bash
   dig novaya-energy.ru A +noall +answer; dig novaya-energy.ru AAAA +noall +answer
   dig www.novaya-energy.ru CNAME +noall +answer; dig www.novaya-energy.ru A +noall +answer; dig www.novaya-energy.ru AAAA +noall +answer
   dig +short CAA novaya-energy.ru      # если записи CAA есть, среди них должен быть letsencrypt.org
   ```
   Снимите также снимок экрана раздела DNS у провайдера.
2. У записей `novaya-energy.ru` и `www` поставьте TTL 300, значения не меняйте.
3. Проверка (через время прежнего TTL): `dig novaya-energy.ru A +noall +answer` — во втором столбце не больше 300.

### 3.6. Переключение A-записей

Выбирайте время с малой посещаемостью. Перед переключением ещё раз запустите **deploy-site** (smoke-тест снят), чтобы на сервере лежала актуальная версия.

1. В DNS **удалите все записи GitHub**: все A-записи `novaya-energy.ru`, **все AAAA-записи (IPv6)** и запись `www` (обычно это CNAME на `*.github.io` или такие же A и AAAA).
2. Создайте: `novaya-energy.ru` A → адрес сервера; `www` A → адрес сервера (или CNAME → `novaya-energy.ru`). AAAA добавляйте только если у сервера есть рабочий IPv6 и порты 80 и 443 по нему открыты; иначе AAAA не должно быть совсем, иначе часть посетителей и Let's Encrypt пойдут не туда.
3. Сразу после этого на сервере раскомментируйте блоки `www.novaya-energy.ru` и `novaya-energy.ru` и примените:
   ```bash
   sudo nano /etc/caddy/Caddyfile
   sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   journalctl -u caddy -f               # дождитесь «certificate obtained successfully» для обоих имён
   ```
   Пока сертификат не выпущен (обычно до минуты после обновления DNS), HTTPS на основном домене отвечает ошибкой. Если выпуск не прошёл, потому что DNS ещё не обновился, Caddy повторяет попытки сам; ускорить: `sudo systemctl restart caddy`.
4. Редирект `www` → основной домен делает Caddy (блок `www.novaya-energy.ru`), в DNS для этого ничего не нужно.

### 3.7. Проверки после переключения

С сервера или своего компьютера, затем из мобильной сети:
```bash
dig +short A novaya-energy.ru; dig +short AAAA novaya-energy.ru; dig +short www.novaya-energy.ru      # только новые значения
curl -sI https://novaya-energy.ru/ | grep -iE "^(HTTP|server|x-robots-tag|strict-transport|cache-control|etag)"
#   200; строки server с GitHub.com нет; строки x-robots-tag НЕТ; max-age=300; no-cache
for p in "" privacy.html models/z1600-5000.html sitemap.xml robots.txt data/kb.json; do printf "%s  /%s\n" "$(curl -sI "https://novaya-energy.ru/$p" | grep -ci '^x-robots-tag')" "$p"; done     # везде 0
echo | openssl s_client -connect novaya-energy.ru:443 -servername novaya-energy.ru 2>/dev/null | openssl x509 -noout -issuer -subject -dates     # Let's Encrypt, срок не истёк
curl -sI https://www.novaya-energy.ru/models/z800-1500.html | grep -iE "^(HTTP|location)"      # 301, Location: https://novaya-energy.ru/models/z800-1500.html
curl -sI http://novaya-energy.ru/ | grep -iE "^(HTTP|location)"                                # 308 на https
curl -s https://novaya-energy.ru/robots.txt                                                    # Allow: /, Sitemap; без Disallow
curl -s https://novaya-energy.ru/sitemap.xml | grep -c "<loc>"                                 # 31
curl -s -o /dev/null -w "%{http_code}\n" https://novaya-energy.ru/net-takoj-stranicy           # 404
curl -s https://novaya-energy.ru/ | grep -c 'name="robots"'                                    # 0 (открыт для индексации)
curl -s https://novaya-energy.ru/models/z1600-5000.html | grep -c 'name="robots"'              # 0
curl -s https://novaya-energy.ru/net-takoj-stranicy | grep -o '<meta name="robots"[^>]*>'      # noindex: только у страницы 404
curl -sI https://bot.novaya-energy.ru/ | grep -i x-robots-tag                                  # noindex, nofollow: бот закрыт
curl -s -o /dev/null -D - -r 0-99 https://novaya-energy.ru/img/hero.mp4 | grep -iE "^(HTTP|content-range|accept-ranges)"   # 206
curl -s https://bot.novaya-energy.ru/health                                                    # {"ok":true}
```
- Запустите **deploy-site** с включённым smoke-тестом: он должен пройти.
- В браузере: главная, страница модели, видео; **чат** на главной и на странице модели отвечает (если 403: проверьте `ALLOWED_ORIGINS`, раздел 4). Ответы модели приходят только при действующем `PROVIDER_API_KEY`: если ключ не активен, виджет показывает контакты менеджера. К переносу это не относится и поводом для отката не является: проверьте тогда только, что чат открывается и запрос доходит до `bot.novaya-energy.ru`; после замены или активации ключа выполните `docker compose up -d`.
- Уберите блок `preview.novaya-energy.ru` из `/etc/caddy/Caddyfile` (`reload`) и удалите A-запись `preview`.

**С этого момента push в `main` сам боевой сайт не обновляет:** до пункта 3.10 после каждого изменения запускайте deploy-site вручную.

### 3.8. Откат за 5 минут

Пока GitHub Pages включён и в его настройках указан домен:
1. В DNS удалите новые записи `novaya-energy.ru` и `www` и верните записи GitHub из пункта 3.5 (все A, все AAAA, `www`) с TTL 300. Если запись о них потерялась, стандартные значения есть в документации GitHub «Managing a custom domain for your GitHub Pages site».
2. Подождите до 5 минут и проверьте: `curl -sI https://novaya-energy.ru/ | grep -i "^server"` → `GitHub.com`.
3. Сервер не трогайте: бот продолжает работать. Если чат не читает базу знаний, задайте `KB_URL` (пункт 3.1).

GitHub Pages публикует `main`, поэтому там та же версия сайта, тоже открытая для индексации. Адреса страниц не меняются.

### 3.9. Отключение GitHub Pages

Только после нескольких дней работы без замечаний: после этого быстрого отката нет.
1. Убедитесь, что в DNS не осталось ни одной записи на GitHub (`dig` из пункта 3.7). Это обязательно: домен, который ведёт на GitHub, но не привязан к репозиторию, может занять посторонний.
2. GitHub → Settings → Pages: удалите Custom domain и отключите публикацию. При удалении домена GitHub может сам сделать коммит, убирающий файл `CNAME`: после этого выполните `git pull`.
3. Верните TTL записей к прежнему значению. Только теперь, если нужно, делайте репозиторий закрытым (бесплатный GitHub Pages для закрытого репозитория не работает).

### 3.10. Включение автодеплоя

В `.github/workflows/deploy.yml` снимите комментарий с двух строк `push:` и `branches: [main]`, закоммитьте. После этого каждый push в `main` выкладывает сайт и запускает smoke-тест. Проверка: Actions → последний запуск **deploy-site** зелёный.

### 3.11. Через неделю: HSTS на год

Если неделя прошла без проблем с HTTPS, в `bot/deploy/Caddyfile` и в `/etc/caddy/Caddyfile` замените `max-age=300` на `max-age=31536000` в строке `Strict-Transport-Security`:
```bash
sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -sI https://novaya-energy.ru/ | grep -i strict-transport-security      # max-age=31536000
```
Быстро отменить это нельзя: браузеры будут требовать HTTPS целый год. `includeSubDomains` добавляйте только потом и только убедившись, что **все** поддомены работают по HTTPS.

### 3.12. Индексация и поисковые кабинеты

Сайт открыт, поэтому после переезда нужно убедиться, что он таким и остался, и сообщить поисковикам, что всё на месте. Адреса не менялись, переадресации настраивать не нужно.

- [ ] Проверки из пункта 3.7 про `x-robots-tag` и `name="robots"` дали ожидаемое: на основном домене запретов нет; `robots.txt` с `Allow: /`; в `sitemap.xml` 31 адрес.
- [ ] Яндекс Вебмастер и Google Search Console: сайт добавлен и подтверждён (если ещё нет: коды `yandex_verification`, `google_verification` в `scripts/seo.json` вписывает владелец, затем `python scripts/build_all.py`, коммит и выкладка). Проверка главной и одной страницы модели в «Проверке ответа сервера» (Яндекс) и «Проверке URL» (Google): код 200, индексирование разрешено.
- [ ] В оба кабинета отправлен (или проверен) `https://novaya-energy.ru/sitemap.xml`.
- [ ] Первые две недели после переезда смотрите в кабинетах ошибки обхода (коды 5xx, 404, недоступный `robots.txt`).
- [ ] IndexNow — только по команде владельца: `python scripts/indexnow.py` (показывает, что уйдёт), затем `python scripts/indexnow.py --send`. Для самого переезда отправлять ничего не требуется: адреса и тексты те же.
- [ ] Метрика — только вместе с согласием на cookie: `ym_counter_id` в `scripts/seo.json`, `build_all.py`, `python tests/consent_check.py`, выкладка. Проверка в браузере: появился баннер, счётчик загружается только после «Принять», в политике есть раздел про аналитику.

**Если сайт нужно временно закрыть** (только по решению владельца: поисковики уберут страницы из выдачи, а возвращаются они не сразу):
1. `INDEXABLE = False` в `scripts/indexing.py`; строка `header X-Robots-Tag "noindex, nofollow"` в блоке `novaya-energy.ru` в `bot/deploy/Caddyfile` **и** в `/etc/caddy/Caddyfile` на сервере (`validate`, `reload`).
2. `python scripts/build_all.py`, `python tests/seo_check.py` (сверяет страницы и `Caddyfile` с константой), коммит, выкладка; smoke-тест проверит `noindex` на главной.
3. `robots.txt` не трогайте и `Disallow` не добавляйте: иначе поисковик не прочитает `noindex`. Открыть обратно: те же шаги в обратную сторону.

### 3.13. Копия сборки для аварийного размещения в другом месте

- Каждая выкладка сохраняет артефакт `site-build` (zip готовых файлов сайта, 30 дней): Actions → нужный запуск → Artifacts. Его можно распаковать в любой статический хостинг (Caddy/nginx, объектное хранилище, GitHub Pages), структура уже без внутренних путей.
- Дополнительно на сервере (раз в неделю, `crontab -e` пользователя `deploy`): `tar czf ~/site-$(date +%F).tgz -C /srv/site . && find ~ -name 'site-*.tgz' -mtime +30 -delete`, и копирование архива на другое хранилище (rclone/scp; настройки подключения хранятся только на сервере).
- Аварийное переключение: развернуть копию на другом сервере или хостинге, переключить A-записи (TTL 300 с), проверить по списку из 3.7.

## 4. Если что-то не работает

| Симптом | Куда смотреть |
| --- | --- |
| `/health` не отвечает | `docker compose ps`, `docker compose logs bot`; порт `127.0.0.1:8787` |
| Бот отвечает «Сейчас не могу ответить…» | в логах `chat_error: …`: `http 429/503` — лимит или сбой провайдера модели (перед этим `llm_retry` и `llm_fail`); `timeout`/`network` — прокси или адрес провайдера; `config` — при `PROVIDER=openai` не заданы `MODEL` или `PROVIDER_BASE_URL` |
| Бот не запускается, в логе `config_error: …` | исправьте названную переменную в `.env` (значение в сообщении не печатается) |
| Уведомления в Telegram не приходят | в логах `tg_error: …`; проверка прокси (шаг 2.3), токен, chat id; бот не должен быть заблокирован менеджером |
| 403 в чате с сайта | `ALLOWED_ORIGINS` в `.env` (должны быть оба адреса сайта) |
| Чат перестал отвечать после переноса сайта, в логе `EACCES` или `ENOENT` про `kb.json` | права и каталог из пункта 3.1, затем `docker compose up -d --force-recreate`; запасной вариант `KB_URL` |
| 502 на `bot.novaya-energy.ru` | контейнер не запущен или порт не `127.0.0.1:8787` |
| Сертификат не выпускается | A-запись домена указывает на сервер? порты 80 и 443 открыты? `journalctl -u caddy` |

## 5. Смена провайдера модели

По умолчанию бот работает на Gemini. Чтобы перейти на другой провайдер с OpenAI-совместимым API (`chat/completions`), код не меняется: меняются переменные в `bot/.env`, и сервис перезапускается. Адрес API, ключ и точные названия моделей берутся из личного кабинета провайдера; в репозиторий и в чаты их не вставлять.

### 5.1. Какие переменные менять

| Переменная | Gemini (по умолчанию) | OpenAI-совместимый провайдер |
| --- | --- | --- |
| `PROVIDER` | `gemini` (можно не задавать) | `openai` |
| `PROVIDER_API_KEY` | ключ Google AI Studio | ключ из личного кабинета провайдера |
| `PROVIDER_BASE_URL` | не нужна (адрес Gemini задан в коде) | адрес API из личного кабинета; бот добавляет `/chat/completions` |
| `MODEL` | модель Gemini (по образцу в `example.env`) | точное название модели из личного кабинета |
| `FALLBACK_MODEL` | запасная модель Gemini | название запасной модели из личного кабинета (необязательно) |
| `PROVIDER_EXTRA_BODY` | обычно пусто | необязательно: JSON с дополнительными полями запроса, например отключение режима рассуждений у выбранной модели (имя поля и значение смотрите в документации провайдера) |
| `PROVIDER_EXTRA_HEADERS` | обычно пусто | необязательно: JSON с заголовками, которые требует провайдер |
| `LLM_USE_PROXY` | `1`: к Gemini через `PROXY_URL` | `1` или `0`: `0`, если провайдер доступен с сервера напрямую (`PROXY_URL` тогда нужен только для Telegram) |

Остальные настройки (`ALLOWED_ORIGINS`, лимиты, Telegram) не меняются. Для обоих провайдеров действует одно и то же: при ответе 429 или 5xx бот один раз повторяет запрос (пауза из `Retry-After`, но не дольше `RETRY_MAX_WAIT_MS`, по умолчанию 3 секунды; без заголовка пауза `RETRY_PAUSE_MS`, по умолчанию 1 секунда), затем переходит на `FALLBACK_MODEL`, затем клиент видит сообщение «Сейчас не могу ответить» с телефоном и почтой. Всё это укладывается в общий бюджет `TIMEOUT_MS` (20 секунд), долгих повторов нет. Если в `PROVIDER_EXTRA_BODY` или `PROVIDER_EXTRA_HEADERS` записан некорректный JSON, бот при запуске напечатает имя неверной переменной (значение не печатается) и не запустится.

В логе после каждого вызова модели остаётся одна строка только со счётчиками: `llm_usage {"provider":…,"model":…,"prompt_tokens":…,"completion_tokens":…,"finish":…,"ms":…}` (`finish` — причина остановки: `STOP`, `MAX_TOKENS`…; если провайдер не прислал счётчики или причину, пишется «нет данных», бот при этом работает). Тексты диалогов, рассуждения модели, ключи, заголовки и ответы провайдера в лог не попадают.

Модель с режимом рассуждений: если ответы пустые или обрываются (в логе `chat_error: length` или `"finish":"MAX_TOKENS"` в `llm_usage`), отключите рассуждения через `PROVIDER_EXTRA_BODY` (имя поля и значение из документации провайдера) и при необходимости увеличьте `MAX_OUTPUT_TOKENS` (по умолчанию 600 токенов ответа).

### 5.2. Порядок смены

1. Выберите модель, прогнав кейсы (раздел 5.3), не меняя боевой `.env`.
2. Сохраните копию `bot/.env` (`cp .env .env.gemini`, права `600`), затем в `.env` замените переменные по таблице выше.
3. Перезапустите: `cd /opt/novaya-bot/repo/bot && docker compose up -d`. В логе (`docker compose logs bot`) не должно быть `config_error`; при запуске печатается `provider=openai model=…`.
4. Проверка: `curl -s http://127.0.0.1:8787/health`, затем несколько вопросов в чате на сайте. В логе должны появиться строки `llm_usage` с токенами.
5. Первые дни следите за логом: частые `llm_retry` и `llm_fail` означают лимиты провайдера (`http 429`) или сбои (`http 5xx`), `timeout` и `network` означают недоступность адреса или прокси, `length`, `empty`, `bad_args` и `bad_json` означают, что модель вернула пустой, обрезанный или некорректный ответ (бот в таком случае переходит к запасной модели).

### 5.3. Выбор модели: eval_cases.js

Скрипт `bot/tools/eval_cases.js` прогоняет `tests/bot_cases.json` на выбранных провайдере и модели и печатает таблицу: кейс, прошёл или нет, число попыток, время, токены на входе и выходе, стоимость. В боевом запуске он не участвует; ключ он берёт из `bot/.env` или окружения и не печатает. Уведомления в Telegram на время прогона выключены.

```bash
cd /opt/novaya-bot/repo/bot        # на сервере или на своём компьютере, где есть репозиторий и выполнен npm ci
node tools/eval_cases.js --provider openai --model НАЗВАНИЕ_ИЗ_КАБИНЕТА --delay-ms 2000 --price-in ЦЕНА_ВХОД --price-out ЦЕНА_ВЫХОД
```

- `--price-in` и `--price-out`: цена за миллион входных и выходных токенов из тарифов провайдера (в той валюте, в которой нужна стоимость); без них стоимость не считается.
- `--delay-ms`: пауза между кейсами (по умолчанию 1500 мс). Если провайдер отвечает 429, кейс повторяется (`--retries`, по умолчанию 3, пауза `--retry-wait-ms` растёт с номером попытки); кейс, на который так и не получен ответ модели, помечается «НЕ ПРОВЕРЕН», а не «FAIL».
- `--fallback НАЗВАНИЕ` или `--no-fallback` меняют запасную модель только на время прогона, `--only id1,id2` запускает выбранные кейсы, `--json файл` сохраняет результат.
- Кейсы, которым нужны отдельные серверы (недоступный провайдер, лимитер, нулевая цена), скрипт пропускает: они от модели не зависят и проверяются через `scripts/test_bot.py`.
- Сравнивайте не только число пройденных кейсов, но и стоимость и время ответа. Часть кейсов проверяет формулировки и нестабильна у любой модели, поэтому запускайте прогон два-три раза и смотрите на кейсы, которые падают устойчиво.

### 5.4. Как вернуться на Gemini

1. Верните сохранённый файл: `cp .env.gemini .env`. Или в `.env` задайте `PROVIDER=gemini`, ключ Google AI Studio, `MODEL`, `FALLBACK_MODEL` и уберите `PROVIDER_BASE_URL`, `PROVIDER_EXTRA_BODY`, `PROVIDER_EXTRA_HEADERS`.
2. Для Gemini с сервера в Москве проверьте `LLM_USE_PROXY=1` и `PROXY_URL`.
3. `docker compose up -d`, затем проверка из пункта 5.2.
