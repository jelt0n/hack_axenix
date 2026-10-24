# Публичное демо Java Blueprints

Область issue #11: готовые образы, HTTP-прокси, одна очередь и отдельный исполнитель.
Цель — Ubuntu 26.04, Linux/amd64, 2 CPU, 4 ГБ RAM, 60 ГБ диска.
Весь Java-код приложения, включая помощник JavaParser, собирается **вне сервера**.
На сервере компилируется только пользовательская Java внутри ограниченного исполнителя.

```text
Интернет :80 → nginx :8080 → API :8000 → том SQLite
                                           ↑
                                один worker → Docker → временный контейнер Java
```

Публикуется только порт прокси. API доступен через него по `/api/`, но отдельного
публичного порта API нет. SQLite — файл в именованном томе. Docker socket подключён
только к доверенному worker, у которого нет сети. API и прокси разделяют внутреннюю
сеть; пользовательские контейнеры запускаются с `--network=none`.

## Сборка и проверки вне сервера

Workflow `.github/workflows/deployment.yml` запускается для PR, `main` и ветки #11.
Он собирает образы, проверяет Python/TypeScript, API, браузер, настоящий исполнитель
и развёртывание за прокси. Архив релиза публикуется только после успешных проверок.
В нём нет исходников для сборки, секретов, Docker socket или пользовательских проектов.

На отдельной машине Linux/amd64 с Docker, Compose, Python 3.12+, uv, Node 22.12+
и JDK 21 тот же процесс можно выполнить вручную из чистого коммита:

```bash
python3 scripts/setup.py
python3 scripts/build_release.py .cache/release
# Только доверенный сгенерированный файл; содержит четыре ID образов.
set -a
. .cache/release/release.env
set +a
export BLUEPRINTS_DOCKER_BIN=docker BLUEPRINTS_COMPOSE_BIN='docker compose'
.venv/bin/pytest
.venv/bin/ruff check backend tests scripts
.venv/bin/ruff format --check backend tests scripts
npm run typecheck
npm run test:e2e
```

`build_release.py` собирает экспорт `git archive HEAD`, поэтому незакоммиченные
локальные файлы не попадают в образы. Он создаёт новый каталог и отказывается
перезаписывать существующий.
`manifest.json` содержит коммит и ID каждого образа. `release.env` закрепляет именно
ID, а `images.tar.gz` переносит их без registry. `SHA256SUMS` проверяет целостность
доставки. Базовые теги Dockerfile могут обновляться; повторная сборка того же коммита
не обещает побайтового совпадения. Для повторного запуска используйте сохранённый
проверенный архив, а не пересборку.

Из GitHub скачайте артефакт **успешного** запуска для нужного коммита:

```bash
gh run list --repo jelt0n/hack_axenix --workflow deployment.yml
gh run download RUN_ID --repo jelt0n/hack_axenix --name blueprints-release-COMMIT --dir .cache/release
```

Заменяйте `RUN_ID`, `COMMIT`, `SERVER` своими значениями. Пароль SSH вводится локально
в терминале; он не записывается в файлы релиза. Не включайте пароль в командную строку.

## Обследование сервера до изменений

```bash
uname -m
cat /etc/os-release
free -h
df -h / /var/lib/docker
ss -lntp
docker version
docker compose version
docker ps -a
docker compose ls
docker volume ls
docker system df
```

Сохраните вывод в журнал запуска. Порт 80 должен быть свободен. Не останавливайте
чужие сервисы и не выполняйте `docker system prune`. Если 80 занят, сначала согласуйте
маршрутизацию с владельцем. Внешний firewall организаторов должен пропускать TCP/80;
TCP/8000, 2375 и 2376 открывать не требуется. Перед загрузкой оставьте запас диска
под архив, распакованные образы и предыдущий релиз; этот процесс не удаляет их автоматически.

## Первый запуск

Передайте каталог релиза в `/opt/blueprints/releases/COMMIT` через SCP/SFTP.
Уникальный каталог не должен заменять текущий релиз. На сервере:

```bash
cd /opt/blueprints/releases/COMMIT
sha256sum -c SHA256SUMS
docker image load -i images.tar.gz
install -d -m 700 /opt/blueprints
printf 'DOCKER_GID=%s\nBLUEPRINTS_BIND=0.0.0.0\nBLUEPRINTS_PORT=80\n' \
  "$(stat -c '%g' /var/run/docker.sock)" > /opt/blueprints/operator.env
docker compose --env-file release.env --env-file /opt/blueprints/operator.env \
  -f compose.yaml -p blueprints-demo config --quiet
docker compose --env-file release.env --env-file /opt/blueprints/operator.env \
  -f compose.yaml -p blueprints-demo up -d --no-build --pull never --wait --wait-timeout 120
curl --fail http://127.0.0.1/api/health
curl --fail http://127.0.0.1/api/runner
```

Все сервисы должны быть healthy; `/api/runner` должен вернуть `available: true`.
В Compose нет `build`, скачивание образов запрещено через `pull_policy: never`.
Контейнеры API и прокси работают без root и capabilities, с read-only root.
Не масштабируйте worker и не запускайте второй комплект над тем же томом.

С внешней машины проверьте `http://SERVER/`, загрузите пример и выполните проверку.
Для автоматического сквозного прогона используйте **свободное демо**: тест создаёт
временные проекты и задания, включая два таймаута.

```bash
BLUEPRINTS_DEMO_URL=http://SERVER npx playwright test --config deploy/playwright.config.ts
```

После приёмки сохраните указатель на релиз:

```bash
ln -s /opt/blueprints/releases/COMMIT /opt/blueprints/current
```

Для IP используется HTTP. Cookie сессии HttpOnly/SameSite=Strict; шифрования HTTP нет.
Когда появится домен, HTTPS настраивается отдельно с владельцем сети. Не меняйте
проксирование заголовков на доверие произвольным клиентским `X-Forwarded-*`.

## Обновление, резервная копия и откат

Сначала доставьте и проверьте новый архив в новом каталоге. Сохраните старые
`release.env`, `compose.yaml`, `manifest.json`, образы и `/opt/blueprints/operator.env`.
В окне обслуживания из каталога **текущего** релиза:

```bash
docker compose --env-file release.env --env-file /opt/blueprints/operator.env \
  -f compose.yaml -p blueprints-demo stop proxy worker api
```

После остановки всех писателей скопируйте весь том `blueprints-demo_projects`
в отдельный архив, включая SQLite WAL/SHM, если они есть. Например, используя ID
текущего API из `release.env` и новый каталог резервной копии:

```bash
mkdir -p /opt/blueprints/backups/BEFORE_COMMIT
docker run --rm --network none --read-only --user 0:0 \
  -v blueprints-demo_projects:/data:ro \
  -v /opt/blueprints/backups/BEFORE_COMMIT:/backup \
  --entrypoint tar API_IMAGE_ID -czf /backup/projects.tar.gz -C /data .
```

Затем из каталога нового релиза выполните команды `up --no-build --pull never --wait`
и проверки выше. После успеха обновите только символьную ссылку `current` через
`ln -sfn /opt/blueprints/releases/NEW_COMMIT /opt/blueprints/current`.

Если запуск или проверки не прошли, остановите новый комплект и выполните `up`
из старого каталога с его `release.env`. Эта задача не меняет схему SQLite, поэтому
для её отката достаточно прежних образов. Для будущего релиза с миграцией данных
сначала согласуйте восстановление резервной копии: это теряет записи после снимка.
Не выполняйте `down -v` и не удаляйте общий том при штатном обновлении или откате.
При неудачном первом запуске `down --timeout 45` удаляет только этот комплект,
сохраняя именованный том и образы.

## Начальные лимиты и измерения

| Область | Начальное ограничение |
| --- | --- |
| Прокси / API / worker | 128 / 768 / 256 МиБ, swap отключён |
| CPU прокси / API / worker | 0,25 / 0,75 / 0,25 CPU |
| PID прокси / API / worker | 32 / 128 / 64 |
| Активная Java | 1 CPU, 512 МиБ без swap, 64 PID |
| Компилятор / JVM | heap 192 / 128 МиБ; SerialGC; один активный процессор |
| Компиляция / запуск | 25 / 5 секунд на версию и сценарий |
| Вывод | 65 536 байт суммарно stdout + stderr на процесс |
| Временные данные Java | `/work` 64 МиБ, `/tmp` 16 МиБ, удаляются с контейнером |
| Очередь | одно активное задание, 20 незавершённых всего, 2 на сессию |
| Сценарии | 1–5; stdin до 32 КиБ UTF-8 на сценарий |
| Логи сервисов | 2 файла по 10 МиБ на сервис |

Контейнер Java расходует память отдельно от worker. Сумма лимитов памяти основных
сервисов и одной Java — 1664 МиБ, остаётся запас ОС/Docker; tmpfs учитывается в памяти
контейнера. Сумма квот CPU может превышать 2: это потолки, а не резервирование CPU.
Числа — начальные настройки, а не заявление о проведённых измерениях на сервере.

Проверяйте реальные ограничения на целевом хосте через доверенный Docker CLI,
который обращается к нему по SSH/локальному Unix-туннелю. TCP Docker API не нужен.
На машине проверяющего с Python-зависимостями проекта:

```bash
# Docker CLI и DOCKER_HOST заранее настроены оператором на целевой Unix socket.
export BLUEPRINTS_DOCKER_BIN=docker
export BLUEPRINTS_RUNNER_IMAGE=sha256:RUNNER_IMAGE_ID
.venv/bin/pytest tests/test_docker_checks.py tests/test_deployment_limits.py -q
```

Новые пробы измеряют рост `nr_throttled` при CPU-нагрузке, отказ создания потоков
и `pids.events`, OOM-kill дочерней JVM за пределами heap родителя и переполнение tmpfs.
Они требуют cgroup v2. Существующие тесты также проверяют таймаут, вывод, ошибки
компиляции и исключения, отсутствие сети и удаление контейнеров. Запускайте их при
остановленном публичном worker, чтобы дополнительная тестовая нагрузка не конкурировала
с демо за ресурсы. После проверок возобновите worker и повторите браузерный сценарий.

Сохраните дату, коммит, версии Docker/ядра, вывод pytest/Playwright, `docker stats
--no-stream`, время компиляции/исполнения из результата API и список оставшихся
контейнеров `docker ps -a --filter label=dev.blueprints.deployment`. Пустой список
после завершения заданий подтверждает удаление контейнеров вместе с tmpfs.
Журнал конкретного запуска находится в `deploy/VALIDATION.md` в репозитории.
Если сервер или публичный порт недоступны, #11 остаётся заблокированной внешним доступом.

Основания конфигурации: [Compose services](https://docs.docker.com/reference/compose-file/services/),
[Compose networking](https://docs.docker.com/compose/how-tos/networking/),
[Docker resource limits](https://docs.docker.com/engine/containers/resource_constraints/).
