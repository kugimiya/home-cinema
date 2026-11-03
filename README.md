# Home Cinema

Локальный агрегатор торрентов: поиск (TorAPI + RuTor), **torrent-engine** (libtorrent) с режимами streaming / completing / seeding, **transcoder** (ffmpeg HLS + качество 240–1440p), веб и Android.

## Быстрый старт

```bash
cp .env.example .env
mkdir -p data/torrents data/orchestrator
docker compose up --build
```

UI: [http://localhost:3000](http://localhost:3000)

### torrent-engine в локальной сети (macvlan)

По умолчанию контейнеры сидят в docker-bridge (`172.x`), проброс `6881:6881` на хост — UPnP/NAT-PMP и LSD на роутере часто не совпадают с тем, что видят пиры.

Чтобы **torrent-engine** получил адрес из вашей LAN (`192.168.1.x`), как «Bridged» у VirtualBox:

1. В `.env` задайте свободный IP и имя физического интерфейса (`ip link`): `DOCKER_MACVLAN_PARENT`, `DOCKER_LAN_SUBNET`, `DOCKER_LAN_GATEWAY`, `TORRENT_ENGINE_LAN_IP`.
2. Запуск: `docker compose -f docker-compose.yml -f compose.macvlan.yml up -d`.

Engine остаётся во внутренней сети compose (orchestrator по-прежнему `http://torrent-engine:8090`), плюс второй интерфейс в LAN для BitTorrent. В overlay включены LSD/UPnP/NAT-PMP и `TORRENT_ENGINE_LISTEN_INTERFACES=eth1:6881` (проверьте `docker exec home-cinema-torrent-engine ip -br link`, если порядок интерфейсов другой).

**VPN на хосте:** трафик macvlan обычно уходит напрямую через физическую NIC с MAC/IP контейнера, минуя маршрутизацию VPN в network namespace хоста — это как раз частый мотив для macvlan. Исключения возможны (policy routing, firewall, rootless Docker).

**Ограничения:** нужен Linux и rootful Docker; с хоста LAN-IP контейнера часто недоступен без [macvlan shim](https://blog.oddbit.com/post/2018-03-12-using-docker-macvlan-networks/#host-access); для API используйте `localhost:8090` или внутренние имена сервисов.

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
- HTTP-сервис на **Node.js (Fastify)**; libtorrent через **N-API addon** (`native/`, `lt_session.node`).

## Transcoder

- Отдельный контейнер (Node.js / Fastify); вход с общего тома `/torrents` или HTTP stream с engine.
- Orchestrator отдаёт HLS через `/api/transcode/...` (общий volume `transcode-cache`).

## Плеер

- **Авто / оригинал**: direct, если кодек подходит браузеру/ExoPlayer.
- **240–1440p**: HLS через transcoder.
- Озвучка, seek (новая transcode-сессия), субтитры (web).

## Тесты

```bash
cd orchestrator && npm install && npm test
cd ../torrent-engine && npm install && npm test
cd ../transcoder && npm install && npm test
```

Docker: `docker compose -f docker-compose.yml -f compose.test.yml run --rm test-runner`

## Структура

- `torrent-engine/` — libtorrent + REST + Range stream (Fastify + TS)
- `transcoder/` — ffmpeg HLS sessions (Fastify + TS)
- `orchestrator/` — API, probe, библиотека (Fastify + TS)
- `web/`, `android/`
