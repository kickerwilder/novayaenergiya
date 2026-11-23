# Запуск на сервере (VPS, Москва, Ubuntu 24.04)

Один сервер, несколько сервисов. Здесь: чат-бот (Docker) и размещение сайта (Caddy). Секретов, паролей и адресов сервера в этом файле нет: подставляйте свои значения только на сервере.
Файл лежит в `bot/` и на сайт не публикуется (`_config.yml`, исключения деплоя, закрытые пути в Caddy).

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
   sudo mkdir -p /opt/novaya && sudo chown "$USER": /opt/novaya
   git clone git@github.com:kickerwilder/novayaenergiya.git /opt/novaya/repo
   cd /opt/novaya/repo/bot
   ```
2. **Настройки.** Создайте `bot/.env` по образцу `example.env` и заполните (файл в `.gitignore`, в чаты и в репозиторий не вставлять):
   ```bash
   cp example.env .env && chmod 600 .env && nano .env
   ```
   | Переменная | Что внести |
   | --- | --- |
   | `PROVIDER` | `gemini` (по умолчанию) или `openai`; смена провайдера: раздел 5 |
   | `PROVIDER_API_KEY` | ключ Google AI Studio (лучше отдельный проект и отдельный ключ); для другого провайдера ключ из его личного кабинета |
   | `PROXY_URL` | `socks5://ЛОГИН:ПАРОЛЬ@ХОСТ:ПОРТ` или `http://…`; только для LLM и Telegram; пусто = напрямую |
   | `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather |
   | `TELEGRAM_MANAGER_CHAT_ID` | chat id менеджера (см. шаг 4) |
   | `MODEL`, `FALLBACK_MODEL` | по образцу; менять при смене моделей Gemini или провайдера |
   | `LLM_USE_PROXY` | `1` (по умолчанию): к модели через `PROXY_URL`; `0`: к модели напрямую (прокси только для Telegram) |
   | `ALLOWED_ORIGINS` | `https://novaya-energy.ru,https://www.novaya-energy.ru` |
   | `ALLOW_LOCALHOST` | `0` на сервере |
   | `KB_URL` | пусто: бот читает `/srv/site/data/kb.json`, который деплой сайта обновляет вместе с сайтом |
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
   Если оба запроса возвращают код, прокси годится. Если нет: проверьте логин, пароль, порт, что прокси допускает HTTPS (CONNECT) и что выходной адрес прокси не заблокирован.
4. **Chat id менеджера.** Менеджер открывает вашего бота в Telegram и пишет ему любое сообщение (например, `/start`). Затем (вебхук не используется, бот опрашивает `getUpdates` через `PROXY_URL`):
   ```bash
   docker compose run --rm bot node tg_chat_id.js
   ```
   Скрипт печатает id и название чатов (тексты сообщений не выводит). Впишите нужный id в `TELEGRAM_MANAGER_CHAT_ID`. Если скрипт отвечает ошибкой, убедитесь, что у бота не включён вебхук.
5. **Запуск.**
   ```bash
   docker compose up -d --build
   curl -s http://127.0.0.1:8787/health        # {"ok":true}
   docker compose ps                            # состояние healthy
   docker compose logs --tail 50 bot            # в логах нет текстов диалогов и контактов клиентов
   ```
6. **Caddy и поддомен бота.** В DNS создайте A-запись `bot.novaya-energy.ru` на адрес сервера. Затем:
   ```bash
   sudo cp /opt/novaya/repo/bot/deploy/Caddyfile /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile        # впишите e-mail в блок {} (для Let's Encrypt)
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
7. **Подключение чата к сайту.** В `assets/app.js` задайте адрес бота: `const CHAT_URL = "https://bot.novaya-energy.ru";` (постоянная вверху файла), закоммитьте и выложите сайт. До этого кнопка чата на сайте не показывается. Если бот недоступен (сеть, таймаут, ошибка), виджет показывает контакты менеджера вместо ошибки.
8. **Проверка уведомления.** Задайте на сайте вопрос, на который бот отправит к менеджеру (например, «Какая мощность зарядного устройства у ZF28-2003.8?»): менеджеру придёт сообщение с сутью вопроса (телефоны, e-mail и ФИО заменены метками) и временем, один раз на диалог.

Обновление бота: `cd /opt/novaya/repo && git pull && cd bot && docker compose up -d --build`. Смена ключа или прокси: правка `.env` и `docker compose up -d`.

## 3. Размещение сайта на сервере

Сайт переезжает с GitHub Pages на сервер: статические файлы в `/srv/site`, раздаёт Caddy (конфигурация в `bot/deploy/Caddyfile`, блок `novaya-energy.ru`). Канонический адрес `https://novaya-energy.ru/` (без `www`), `www` редиректит на него; адреса страниц не меняются. Внутренние пути (`data/source`, `data/naming.json`, `README.md`, `SKILL.md`, `.claude`, `scripts`, `tests`, `bot`, `.git`) закрыты (404) и в выкладку не попадают.

### 3.1. Каталог и пользователь для деплоя

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo mkdir -p /srv/site && sudo chown deploy:caddy /srv/site && sudo chmod 2750 /srv/site
sudo -u deploy ssh-keygen -t ed25519 -f /home/deploy/.ssh/id_deploy -N "" -C "github-deploy"   # ключ: пара создаётся на сервере
sudo -u deploy sh -c 'cat /home/deploy/.ssh/id_deploy.pub >> /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys'
```
Пользователь `deploy` без sudo и без пароля; пишет только в `/srv/site`, группа `caddy` читает. (Дополнительная защита, по желанию: ограничить ключ в `authorized_keys` командой `rrsync`.) Бот читает `/srv/site/data/kb.json` (том в `docker-compose.yml`), поэтому каталог должен быть читаемым для Docker.

### 3.2. Secrets репозитория и первая выкладка

В GitHub → Settings → Secrets and variables → Actions создайте: `DEPLOY_SSH_KEY` (содержимое закрытого ключа `/home/deploy/.ssh/id_deploy`, затем удалите его копии вне сервера), `DEPLOY_KNOWN_HOSTS` (вывод `ssh-keyscan -t ed25519 <адрес-сервера>`), `DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), `DEPLOY_PORT` (если не 22).
Запуск: Actions → deploy-site → Run workflow. Workflow `.github/workflows/deploy.yml` запускается только вручную; автозапуск по пушу в `main` включается снятием комментария в файле, когда решите. Каждый запуск сохраняет копию сборки (артефакт `site-build`, хранится 30 дней).

### 3.3. Проверка сайта на временном адресе

1. В DNS создайте A-запись `preview.novaya-energy.ru` на сервер.
2. В `/etc/caddy/Caddyfile` раскомментируйте блок `preview.novaya-energy.ru`, подставьте хэш пароля (`caddy hash-password`), `caddy validate` и `sudo systemctl reload caddy`.
3. Проверьте (с паролем `-u preview:ПАРОЛЬ`): главная, `privacy.html`, `models/z1600-5000.html`, `data/kb.json`, `sitemap.xml` отдают 200; закрытые пути возвращают 404:
   ```bash
   B=https://preview.novaya-energy.ru; A="-u preview:ПАРОЛЬ"
   for p in "" privacy.html models/z1600-5000.html data/kb.json data/catalog.js assets/app.js sitemap.xml robots.txt; do curl -s $A -o /dev/null -w "%{http_code}  /$p\n" "$B/$p"; done
   for p in data/source/station_specs.json data/naming.json README.md SKILL.md scripts/build_seo.py tests/bot_cases.json bot/DEPLOY.md .git/config .claude/skills/novayaenergiya-site/SKILL.md nonexistent-page; do curl -s $A -o /dev/null -w "%{http_code}  /$p\n" "$B/$p"; done   # все 404
   curl -s $A -I "$B/nonexistent-page" | head -1                                  # HTTP/2 404 (тело — наша страница 404.html)
   curl -s $A -I -r 0-99 "$B/img/hero.mp4" | head -3                              # HTTP/2 206, Accept-Ranges: bytes
   curl -s $A -I "$B/" | grep -iE "content-encoding|cache-control|x-content-type|referrer|x-frame"
   ```
4. Откройте preview в браузере (десктоп и телефон): главная, каталог, страница модели, видео, `Назад`.
5. Проверьте редирект `www` (после переключения DNS): `curl -sI https://www.novaya-energy.ru/models/z800-1500.html` → `301`, `Location: https://novaya-energy.ru/models/z800-1500.html`.

Если `Accept-Ranges` или код 404 у `nonexistent-page` отличаются от ожидаемых, не переключайте DNS: сначала разберитесь с `Caddyfile` (`journalctl -u caddy`).

### 3.4. Порядок переключения DNS

1. **За 1–2 суток** снизьте TTL A-записей `novaya-energy.ru` и `www` до 300 с (у регистратора или DNS-провайдера). Старый TTL запишите.
2. Убедитесь, что выкладка прошла и пункт 3.3 проверен; бот на `bot.novaya-energy.ru` работает.
3. **Переключение.** Смените A-запись `novaya-energy.ru` и `www` на адрес сервера (AAAA, если были, удалите или тоже переключите). Caddy выпустит сертификаты автоматически: `journalctl -u caddy -f`.
4. **Проверка** с обычной сети и с мобильной: главная, страница модели, `https://www…` → редирект, `curl -sI https://novaya-energy.ru/` (200, `Cache-Control`), 404 на закрытых путях, `sitemap.xml`, `robots.txt`.
5. GitHub Pages пока не отключайте (аварийный путь, пока репозиторий публичный). После нескольких дней работы без замечаний верните TTL к прежнему значению. Затем в Caddy включите HSTS (раскомментировать строку в `security_headers`) и, если нужно, переведите репозиторий в закрытый.
6. После переезда в `assets/app.js` включите чат (`CHAT_URL`, шаг 2.7) и по желанию включите автозапуск деплоя.

### 3.5. Копия сборки для аварийного размещения в другом месте

- Каждая выкладка сохраняет артефакт `site-build` (zip готовых файлов сайта, 30 дней): Actions → нужный запуск → Artifacts. Его можно распаковать в любой статический хостинг (Caddy/nginx, объектное хранилище, GitHub Pages), структура уже без внутренних путей.
- Дополнительно на сервере (раз в неделю, `crontab -e` пользователя `deploy`): `tar czf ~/site-$(date +%F).tgz -C /srv/site . && find ~ -name 'site-*.tgz' -mtime +30 -delete`, и копирование архива на другое хранилище (rclone/scp; настройки подключения хранятся только на сервере).
- Аварийное переключение: развернуть копию на другом сервере или хостинге, переключить A-записи (TTL остаётся 300 с), проверить по списку из 3.3.

## 4. Если что-то не работает

| Симптом | Куда смотреть |
| --- | --- |
| `/health` не отвечает | `docker compose ps`, `docker compose logs bot`; порт `127.0.0.1:8787` |
| Бот отвечает «Сейчас не могу ответить…» | в логах `chat_error: …`: `http 429/503` — лимит или сбой провайдера модели (перед этим `llm_retry` и `llm_fail`); `timeout`/`network` — прокси или адрес провайдера; `config` — при `PROVIDER=openai` не заданы `MODEL` или `PROVIDER_BASE_URL` |
| Бот не запускается, в логе `config_error: …` | исправьте названную переменную в `.env` (значение в сообщении не печатается) |
| Уведомления в Telegram не приходят | в логах `tg_error: …`; проверка прокси (шаг 2.3), токен, chat id; бот не должен быть заблокирован менеджером |
| 403 в чате с сайта | `ALLOWED_ORIGINS` в `.env` (должны быть оба адреса сайта) |
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

В логе после каждого вызова модели остаётся одна строка только со счётчиками: `llm_usage {"provider":…,"model":…,"prompt_tokens":…,"completion_tokens":…,"ms":…}`. Тексты диалогов, ключи, заголовки и ответы провайдера в лог не попадают.

### 5.2. Порядок смены

1. Выберите модель, прогнав кейсы (раздел 5.3), не меняя боевой `.env`.
2. Сохраните копию `bot/.env` (`cp .env .env.gemini`, права `600`), затем в `.env` замените переменные по таблице выше.
3. Перезапустите: `cd /opt/novaya/repo/bot && docker compose up -d`. В логе (`docker compose logs bot`) не должно быть `config_error`; при запуске печатается `provider=openai model=…`.
4. Проверка: `curl -s http://127.0.0.1:8787/health`, затем несколько вопросов в чате на сайте. В логе должны появиться строки `llm_usage` с токенами.
5. Первые дни следите за логом: частые `llm_retry` и `llm_fail` означают лимиты провайдера (`http 429`) или сбои (`http 5xx`), `timeout` и `network` означают недоступность адреса или прокси.

### 5.3. Выбор модели: eval_cases.js

Скрипт `bot/tools/eval_cases.js` прогоняет `tests/bot_cases.json` на выбранных провайдере и модели и печатает таблицу: кейс, прошёл или нет, число попыток, время, токены на входе и выходе, стоимость. В боевом запуске он не участвует; ключ он берёт из `bot/.env` или окружения и не печатает. Уведомления в Telegram на время прогона выключены.

```bash
cd /opt/novaya/repo/bot        # на сервере или на своём компьютере, где есть репозиторий и выполнен npm ci
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
