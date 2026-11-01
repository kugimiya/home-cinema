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

## Структура

- `orchestrator/` — FastAPI, провайдеры, клиент TorrServer
- `web/` — React (Vite) SPA
- `torrserver/` — образ с бинарником TorrServer
- `data/` — локальные данные (в git не попадает)
