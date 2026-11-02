from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx

from app.activity_tracker import ActivityTracker
from app.models import (
    EngineAlertEntry,
    EngineDiagnosticsResponse,
    EngineOrchestratorSnapshot,
    EngineSessionStatus,
    EngineTorrentLive,
    EngineTorrentFileLive,
)
from app.probe_warm import ProbeWarmManager
from app.transcode_sessions import TranscodeSessionManager


async def fetch_engine_diagnostics(
    *,
    torrent_engine_url: str,
    activity: ActivityTracker,
    transcode_mgr: TranscodeSessionManager,
    probe_warm: ProbeWarmManager,
    alert_limit: int = 120,
) -> EngineDiagnosticsResponse:
    base = torrent_engine_url.rstrip("/")
    timeout = httpx.Timeout(15.0, connect=5.0)
    session: EngineSessionStatus | None = None
    torrents: list[EngineTorrentLive] = []
    alerts: list[EngineAlertEntry] = []
    engine_error: str | None = None

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            r = await client.get(f"{base}/v1/session/status")
            r.raise_for_status()
            session = EngineSessionStatus.model_validate(r.json())
        except httpx.HTTPError as e:
            engine_error = str(e) or type(e).__name__

        if engine_error is None:
            try:
                r = await client.get(f"{base}/v1/torrents")
                r.raise_for_status()
                raw_list = r.json()
                if isinstance(raw_list, list):
                    torrents = [_torrent_from_engine(item) for item in raw_list]
            except httpx.HTTPError as e:
                engine_error = str(e) or type(e).__name__

        if engine_error is None:
            try:
                r = await client.get(
                    f"{base}/v1/alerts",
                    params={"limit": alert_limit},
                )
                r.raise_for_status()
                data = r.json()
                raw_alerts = data.get("alerts") if isinstance(data, dict) else []
                if isinstance(raw_alerts, list):
                    alerts = [EngineAlertEntry.model_validate(a) for a in raw_alerts]
            except httpx.HTTPError as e:
                engine_error = str(e) or type(e).__name__

    act = activity.snapshot()
    warm = probe_warm.activity_snapshot()
    tc_count = await transcode_mgr.session_count()

    orch = EngineOrchestratorSnapshot(
        activity_label=act.label,
        activity_detail=act.detail,
        transcode_sessions=tc_count,
        transcode_max=transcode_mgr.max_sessions,
        warm_probe_active=warm.active,
        warm_probe_detail=warm.detail,
        warm_probe_queue=warm.queue_size,
    )

    return EngineDiagnosticsResponse(
        session=session,
        torrents=torrents,
        alerts=alerts,
        orchestrator=orch,
        engine_error=engine_error,
        polled_at=datetime.now(timezone.utc).isoformat(),
    )


def _torrent_from_engine(item: dict[str, Any]) -> EngineTorrentLive:
    files_raw = item.get("file_stats") or []
    files: list[EngineTorrentFileLive] = []
    if isinstance(files_raw, list):
        for f in files_raw:
            if not isinstance(f, dict):
                continue
            files.append(
                EngineTorrentFileLive(
                    id=int(f.get("id") or 0),
                    path=str(f.get("path") or ""),
                    length=int(f.get("length") or 0),
                    downloaded_bytes=int(f.get("downloaded_bytes") or 0),
                    completed=bool(f.get("completed")),
                    priority=int(f.get("priority") or 0),
                )
            )
    return EngineTorrentLive(
        hash=str(item.get("hash") or "").lower(),
        title=str(item.get("title") or ""),
        stat_string=item.get("stat_string"),
        mode=item.get("mode"),
        torrent_size=_optional_int(item.get("torrent_size")),
        loaded_size=_optional_int(item.get("loaded_size")),
        download_speed=_optional_float(item.get("download_speed")),
        upload_speed=_optional_float(item.get("upload_speed")),
        total_peers=_optional_int(item.get("total_peers")),
        connected_seeders=_optional_int(item.get("connected_seeders")),
        bytes_written_data=_optional_int(item.get("bytes_written_data")),
        all_time_download=_optional_int(item.get("all_time_download")),
        has_metadata=item.get("has_metadata"),
        is_seeding=item.get("is_seeding"),
        is_finished=item.get("is_finished"),
        is_paused=item.get("is_paused"),
        progress=_optional_float(item.get("progress")),
        num_connections=_optional_int(item.get("num_connections")),
        error=item.get("error"),
        save_path=item.get("save_path"),
        torrent_name=item.get("torrent_name"),
        scope_file_ids=item.get("scope_file_ids") or [],
        last_heartbeat_age_sec=_optional_float(item.get("last_heartbeat_age_sec")),
        sequential_download=item.get("sequential_download"),
        pieces_total=_optional_int(item.get("pieces_total")),
        pieces_have=_optional_int(item.get("pieces_have")),
        piece_length=_optional_int(item.get("piece_length")),
        file_stats=files,
    )


def _optional_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _optional_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
