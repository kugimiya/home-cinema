# Home Cinema

Локальный агрегатор торрентов: поиск (TorAPI + RuTor), **torrent-engine** (libtorrent) с режимами streaming / completing / seeding, **transcoder** (ffmpeg HLS + качество 240–1440p), веб и Android.

## Быстрый старт

```bash
cp .env.example .env
mkdir -p data/torrents data/orchestrator
docker compose up --build
```

UI: [http://localhost:3000](http://localhost:3000)

| Сервис | URL |
|--------|-----|
| Web UI | http://localhost:3000 |
| Orchestrator | http://localhost:8080/health |
| torrent-engine | http://localhost:8090/health |
| transcoder | http://localhost:8091/health |
| TorAPI | http://localhost:8443/docs |

## torrent-engine

- Файлы на `./data/torrents`, после просмотра **`POST /api/torrents/{hash}/playback-ended`** переводит раздачу в **completing** (докачка + раздача).
- Direct `/stream` через nginx :3000 (`TORRENT_ENGINE_PUBLIC_URL`).

## Transcoder

- Отдельный контейнер; вход с общего тома `/torrents` или HTTP stream с engine.
- Orchestrator отдаёт HLS через `/api/transcode/...` (общий volume `transcode-cache`).

## Плеер

- **Авто / оригинал**: direct, если кодек подходит браузеру/ExoPlayer.
- **240–1440p**: HLS через transcoder.
- Озвучка, seek (новая transcode-сессия), субтитры (web).

## Тесты (TDD)

```bash
pip install pytest pytest-asyncio httpx
python -m pytest orchestrator/tests transcoder/tests -q
# torrent-engine (нужен libtorrent):
pip install -e ./torrent-engine[dev] && python -m pytest torrent-engine/tests -q
```

Docker: `docker compose -f docker-compose.yml -f compose.test.yml run --rm test-runner`

## Структура

- `torrent-engine/` — libtorrent + REST + Range stream
- `transcoder/` — ffmpeg HLS sessions
- `orchestrator/` — API, probe, библиотека
- `web/`, `android/`
