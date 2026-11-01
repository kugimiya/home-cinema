# Home Cinema

Локальный агрегатор торрентов для личного использования: поиск (TorAPI + RuTor fallback), стриминг и **сидирование на диск** через TorrServer. Удаление только из веб-библиотеки.

## Требования

- Docker и Docker Compose
- ~10 GB свободного места под кэш торрентов (зависит от контента)

## Быстрый старт

```bash
cp .env.example .env
mkdir -p data/torrents data/torrserver-config data/orchestrator
docker compose up --build
```

Откройте UI: [http://localhost:3000](http://localhost:3000)

**Android / Android TV:** каталог [`android/`](android/README.md) — Compose-клиент, поиск сервера в LAN (`/api/discover`, mDNS, скан подсети).

| Сервис        | URL |
|---------------|-----|
| Web UI        | http://localhost:3000 |
| Orchestrator  | http://localhost:8080/health |
| TorrServer    | http://localhost:8090 |
| TorAPI        | http://localhost:8443/docs |

## TorrServer: диск и сидирование

Orchestrator при старте **один раз** выставляет (через GET → merge → SET):

- `UseDisk=true`
- `TorrentsSavePath=/torrents` (volume `./data/torrents`)
- `RemoveCacheOnDrop=false`
- добавление торрентов с `save_to_db: true`

Файлы остаются на диске и раздаются, пока вы не нажмёте **Удалить** в библиотеке.

### Производительность (`.env`)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `TORRSERVER_CACHE_SIZE_MB` | 128 | RAM-буфер стриминга (не размер файлов на диске) |
| `TORRSERVER_PRELOAD_CACHE` | 40 | % кэша до старта потока; меньше = быстрее «Смотреть», больше = меньше подвисаний |
| `TORRSERVER_CONNECTIONS_LIMIT` | 40 | Пиры на торрент (обычно 25–50) |
| `TORRSERVER_READER_READ_AHEAD` | 95 | Опережающее чтение, % |
| `TORRSERVER_PRIORITY_CONCURRENCY` | 4 | Параллельность `set` приоритетов файлов (не перегружать TorrServer) |

Контейнер TorrServer: `mem_limit: 3g`, бинарь с `--torrentsdir /torrents`. UI проксирует `/stream` через порт **3000** (`TORRSERVER_PUBLIC_URL=http://localhost:3000`).

### Перекодирование для браузера (AVI, AC3/DTS и т.п.)

Orchestrator содержит **FFmpeg**: если `ffprobe` видит формат, который `<video>` не играет, включается **HLS** (H.264 + AAC). Прямые MP4/MKV (H.264 + AAC/MP3) по-прежнему идут напрямую с TorrServer.

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `TRANSCODE_ENABLED` | true | Выключить, если нужен только VLC |
| `TRANSCODE_MAX_SESSIONS` | 2 | Одновременных перекодирований (CPU) |
| `TRANSCODE_SESSION_TTL_SEC` | 300 | Очистка сессии без активности |
| `ORCHESTRATOR_PUBLIC_URL` | http://localhost:3000 | Базовый URL для `playback_url` (m3u8) в браузере |
| `TRANSCODE_ALLOW_HEVC_DIRECT` | false | Разрешить HEVC без transcode (Safari) |

### Прогрев ffprobe (Range prefetch)

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `PROBE_WARM_BYTES` | 4194304 | Байт с начала файла через HTTP Range; **0** = прогрев выключен |
| `PROBE_WARM_FILES` | 2 | При просмотре: **0** = только кнопка в библиотеке; **N** = следующие N video; **-1** = все video по очереди |
| `PROBE_WARM_MANUAL_FILES` | -1 | Кнопка «Предзагрузить ffprobe»: лимит video или **-1** = все |
| `PROBE_WARM_CONCURRENCY` | 1 | Параллельных Range-запросов |

Orchestrator сохраняет **результат ffprobe** и **нужный размер головы файла** per `(hash, file_id)` в SQLite (`file_probe_cache`). Повторный «Смотреть» использует кэш; головы файлов лежат в `{TRANSCODE_WORK_DIR}/probe_heads/`.

При локальном UI (`npm run dev` на :5173) задайте `ORCHESTRATOR_PUBLIC_URL=http://localhost:5173`, если orchestrator на :8080 и Vite проксирует `/api`.

**Windows:** для скорости диска держите проект в файловой системе **WSL2** или выделите Docker Desktop **≥4 GB RAM**. Огромные сборники (сотни файлов) лучше качать по сезонам.

Ручная настройка: [http://localhost:8090](http://localhost:8090) → Settings (после перезапуска orchestrator снова применит merge из `.env`).

## Поиск

1. **TorAPI** (RuTracker, Kinozal, RuTor, NNM) — если контейнер доступен.
2. **RuTor fallback** — прямой парсинг `rutor.info` / `rutor.is`, если TorAPI недоступен или пустой ответ.

Качество и озвучка: поля Kinozal (`Format`, `Language`) или эвристики по названию раздачи.

## Прокси для TorAPI

Если RuTracker/Kinozal не открываются из контейнера, задайте в `.env`:

```env
PROXY_ADDRESS=host.docker.internal
PROXY_PORT=7890
```

## Разработка без Docker (UI)

```bash
# orchestrator + torrserver через compose, UI локально:
cd web && npm install && npm run dev
```

Vite проксирует `/api` на `http://localhost:8080`.

## Приёмка (чеклист)

1. Поиск «назад в будущее» — непустой список (TorAPI и/или RuTor).
2. «Смотреть» — воспроизведение до полной загрузки, перемотка.
3. В `./data/torrents/{infohash}/` появляются файлы кусков/данные.
4. В библиотеке растёт «Отдано», торрент не пропадает сам.
5. «Удалить» — торрент снят, каталог hash удалён с диска.

### Перекодирование (ручная проверка)

1. **MP4 H.264 + AAC** — режим `direct`, без надписи «перекодирование».
2. **AVI (XviD/AC3)** — HLS в плеере, старт после начала загрузки файла.
3. **MKV H.264 + AC3** — HLS (аудио перекодируется), видео copy где возможно.
4. **Несколько озвучек** — select «Озвучка» создаёт новую сессию, звук меняется.
5. **Seek** на 5–10 мин — новая сессия, воспроизведение с новой позиции (± keyframe).
6. **Внешний .srt** — субтитры в HLS-режиме через `<track>`.
7. **Закрытие вкладки** — FFmpeg завершается (TTL / DELETE).
8. **Третий одновременный transcode** — ошибка 503 при `TRANSCODE_MAX_SESSIONS=2`.

## Структура

- `orchestrator/` — FastAPI, провайдеры, клиент TorrServer
- `web/` — React (Vite) SPA
- `torrserver/` — образ с бинарником TorrServer
- `data/` — локальные данные (в git не попадает)
