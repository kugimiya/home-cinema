from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from app.activity_tracker import ActivitySnapshot, ActivityTracker
from app.docker_control import DockerControl
from app.models import ServiceStatus, SystemStatusResponse
from app.torrent_cache import TorrentStateCache
from app.torrent_files import extract_files
from app.probe_warm import ProbeWarmManager
from app.transcode_sessions import TranscodeSessionManager

TORRENT_ENGINE_LIST_MAX_AGE_STATUS = 30.0


def _truncate(s: str, n: int = 40) -> str:
    s = s.strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


async def _probe_http(url: str, path: str = "") -> tuple[bool, float, str | None]:
    target = f"{url.rstrip('/')}{path}"
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(target)
            elapsed = time.monotonic() - start
            if r.status_code >= 500:
                return False, elapsed, f"HTTP {r.status_code}"
            return True, elapsed, None
    except httpx.HTTPError as e:
        return False, time.monotonic() - start, str(e) or type(e).__name__


def _torrent_engine_activity(items: list[dict[str, Any]], cache_age: float | None) -> str:
    n = len(items)
    active = 0
    waiting = 0
    for item in items:
        speed = item.get("download_speed") or 0
        try:
            if float(speed) > 0:
                active += 1
                continue
        except (TypeError, ValueError):
            pass
        if not extract_files(item):
            waiting += 1
    parts: list[str] = []
    if active:
        parts.append(f"Качает {active} раздач(и)")
    if waiting:
        parts.append(f"метаданные: {waiting}")
    if not parts:
        parts.append("Свободен")
    parts.append(f"{n} торрентов")
    if cache_age is not None:
        parts.append(f"list {cache_age:.0f}s назад")
    return " · ".join(parts)


def _orchestrator_activity(
    activity: ActivitySnapshot,
    transcode_count: int,
    transcode_max: int,
    list_in_progress: bool,
    warm_detail: str | None = None,
    warm_queue: int = 0,
) -> str:
    parts: list[str] = []
    if transcode_count:
        parts.append(f"Transcode {transcode_count}/{transcode_max}")
    if activity.label == "warm_probe":
        detail = activity.detail or warm_detail
        if detail:
            parts.append(f"Прогрев probe: {detail}")
        else:
            parts.append("Прогрев probe")
    elif activity.label:
        detail = f' ({activity.detail})' if activity.detail else ""
        parts.append(f"{activity.label}{detail}")
    elif warm_detail:
        parts.append(f"Прогрев probe: {warm_detail}")
    elif warm_queue > 0:
        parts.append(f"Прогрев probe: очередь {warm_queue}")
    elif list_in_progress:
        parts.append("torrent-engine: list")
    if not parts:
        return "Свободен"
    return " · ".join(parts)


async def build_system_status(
    *,
    torrent_engine_url: str,
    torapi_url: str,
    torrent_cache: TorrentStateCache,
    activity: ActivityTracker,
    transcode_mgr: TranscodeSessionManager,
    docker: DockerControl,
    probe_warm: ProbeWarmManager,
    last_search_query: str | None,
    last_search_at: float | None,
) -> SystemStatusResponse:
    engine_ok, engine_elapsed, engine_err = await _probe_http(torrent_engine_url, "/")
    torapi_ok, torapi_elapsed, torapi_err = await _probe_http(torapi_url, "/api/provider/list")

    items: list[dict[str, Any]] = []
    cache_age = torrent_cache.snapshot_age_sec()
    if engine_ok:
        try:
            snapshot = await torrent_cache.list_snapshot(
                max_age=TORRENT_ENGINE_LIST_MAX_AGE_STATUS,
            )
            items = list(snapshot.values())
            cache_age = torrent_cache.snapshot_age_sec()
        except httpx.HTTPError:
            pass

    act = activity.snapshot()
    tc_count = await transcode_mgr.session_count()
    warm_snap = probe_warm.activity_snapshot()

    engine_state = "down"
    if engine_ok:
        engine_state = "degraded" if engine_elapsed > 2.0 else "ok"

        def _dl(it: dict[str, Any]) -> float:
            v = it.get("download_speed")
            try:
                return float(v) if v is not None else 0.0
            except (TypeError, ValueError):
                return 0.0

        if any(_dl(it) > 0 for it in items):
            engine_state = "busy" if engine_state == "ok" else engine_state

    torapi_state = "down"
    if torapi_ok:
        torapi_state = "degraded" if torapi_elapsed > 2.0 else "ok"
    if act.label == "search":
        torapi_state = "busy" if torapi_state != "down" else torapi_state

    orch_state = "ok"
    if act.label or tc_count or torrent_cache.list_fetch_in_progress or warm_snap.active:
        orch_state = "busy"

    torapi_activity = "Свободен"
    if act.label == "search" and act.detail:
        torapi_activity = f'Поиск: "{act.detail}"'
    elif not torapi_ok:
        torapi_activity = f"Недоступен: {torapi_err or 'ошибка'}"
    elif last_search_query and last_search_at:
        age_min = max(0, int((time.time() - last_search_at) / 60))
        torapi_activity = f'Последний поиск: «{_truncate(last_search_query)}» ({age_min} мин назад)'

    services = [
        ServiceStatus(
            id="torrent-engine",
            label="Torrent engine",
            state=engine_state,
            activity=_torrent_engine_activity(items, cache_age)
            if engine_ok
            else f"Недоступен: {engine_err or 'ошибка'}",
            restart_allowed=docker.restart_allowed("torrent-engine"),
        ),
        ServiceStatus(
            id="torapi",
            label="TorAPI",
            state=torapi_state,
            activity=torapi_activity,
            restart_allowed=docker.restart_allowed("torapi"),
        ),
        ServiceStatus(
            id="orchestrator",
            label="Orchestrator",
            state=orch_state,
            activity=_orchestrator_activity(
                act,
                tc_count,
                transcode_mgr.max_sessions,
                torrent_cache.list_fetch_in_progress,
                warm_detail=warm_snap.detail,
                warm_queue=warm_snap.queue_size,
            ),
            restart_allowed=docker.restart_allowed("orchestrator"),
        ),
    ]

    return SystemStatusResponse(
        services=services,
        polled_at=datetime.now(timezone.utc).isoformat(),
    )
