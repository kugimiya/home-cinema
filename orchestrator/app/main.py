from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from collections.abc import Callable
from typing import Optional

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.clients.torrserver import (
    TorrServerClient,
    _extract_files,
    file_index_and_path,
    info_hash_from_magnet,
)
from app.config import Settings
from app.file_progress import progress_from_cache, upload_bytes_per_file
from app.media_files import build_media_catalog, media_kind_for_path
from app.models import (
    DownloadScopeBody,
    MediaKind,
    PlayRequest,
    PlayResponse,
    PlaySelectRequest,
    PlaySelectStatusResponse,
    PrepareResponse,
    Provider,
    ReleaseDetail,
    SearchResponse,
    StorageSummary,
    TorrentEntry,
    TorrentFileStat,
    TorrentListResponse,
    TorrentMediaFile,
    TranscodeSessionRequest,
    TranscodeSessionResponse,
    SystemStatusResponse,
    WarmProbeStartResponse,
    WarmProbeStatusResponse,
)
from app.play_select_progress import PlaySelectPhase, PlaySelectProgressStore
from app.transcode_ffmpeg import is_hls_playlist_complete
from app.transcode_sessions import TranscodeSessionManager, wait_playlist_ready
from app.storage_stats import storage_summary, torrent_hash_dir_size
from app.providers.rutor import RuTorClient
from app.providers.torapi import TorAPIClient
from app.search_service import SearchService
from app.store import MetaStore, TorrentMeta
from app.torr_cache import TorrStateCache
from app.activity_tracker import ActivityTracker
from app.discovery import MdnsAdvertiser, build_discover_payload
from app.docker_control import DockerControl
from app.probe_head import remove_hash_heads
from app.probe_messages import ProbeLiveStats, format_probe_status_message
from app.probe_runner import ProbeRunner
from app.probe_store import ProbeCacheStore
from app.probe_warm import (
    ProbeWarmManager,
    overlay_warm_on_stats,
    warm_summary_for_hash,
)
from app.system_status import build_system_status, _truncate as activity_truncate

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = Settings()
store = MetaStore(settings.database_path)
_prepared_no_download: set[str] = set()
torapi = TorAPIClient(settings.torapi_url, settings.search_timeout)
rutor = RuTorClient(settings.search_timeout)
search_service = SearchService(torapi, rutor)
torr = TorrServerClient(
    settings.torrserver_url,
    settings.torrserver_public_url,
    settings.torrents_save_path,
    settings.play_metadata_timeout,
    settings.torrserver_request_timeout,
    settings.torrserver_list_timeout,
    settings.torrserver_cache_size_mb,
    settings.torrserver_preload_cache,
    settings.torrserver_connections_limit,
    settings.torrserver_reader_read_ahead,
    settings.torrserver_priority_concurrency,
)
transcode_mgr = TranscodeSessionManager(
    settings.transcode_work_dir,
    settings.transcode_max_sessions,
    settings.transcode_session_ttl_sec,
    settings.orchestrator_public_url,
)
torr_cache = TorrStateCache(torr)
activity_tracker = ActivityTracker()


async def _probe_warm_fetch_cache(info_hash: str) -> dict:
    item = await torr_cache.find_list_item(info_hash)
    data = await torr_cache.get_cache_pieces(info_hash, list_item=item)
    return data if isinstance(data, dict) else {}


probe_cache = ProbeCacheStore(settings.database_path)
_probe_head_dir = Path(settings.transcode_work_dir) / "probe_heads"
probe_runner = ProbeRunner(
    store=probe_cache,
    torr=torr,
    torr_cache=torr_cache,
    settings=settings,
    head_dir=_probe_head_dir,
)
probe_warm = ProbeWarmManager(
    torr,
    activity_tracker,
    warm_bytes=settings.probe_warm_bytes,
    auto_files=settings.probe_warm_files,
    manual_files=settings.probe_warm_manual_files,
    concurrency=settings.probe_warm_concurrency,
    fetch_cache=_probe_warm_fetch_cache,
    warm_target_fn=probe_runner.warm_target_bytes,
    head_dir=_probe_head_dir,
)
play_select_progress = PlaySelectProgressStore()
docker_control = DockerControl(
    enabled=settings.service_restart_enabled,
    socket_path=settings.docker_socket_path,
    container_names={
        "torrserver": settings.docker_container_torrserver,
        "torapi": settings.docker_container_torapi,
        "orchestrator": settings.docker_container_orchestrator,
    },
)
_last_search_query: str | None = None
_last_search_at: float | None = None


_mdns = MdnsAdvertiser(
    port=settings.orchestrator_listen_port,
    version="0.1.0",
    enabled=settings.discovery_mdns_enabled,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await torr.wait_ready()
    await torr.bootstrap_disk_settings()
    Path(settings.transcode_work_dir).mkdir(parents=True, exist_ok=True)
    _mdns.start()
    cleanup_task = asyncio.create_task(transcode_mgr.cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        _mdns.stop()


app = FastAPI(title="Home Cinema Orchestrator", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/discover")
async def api_discover(request: Request) -> dict[str, str]:
    """Identity + LAN URL hints for Android/TV clients."""
    payload = build_discover_payload(
        request,
        version="0.1.0",
        orchestrator_public_url=settings.orchestrator_public_url,
        torrserver_public_url=settings.torrserver_public_url,
        default_api_port=settings.orchestrator_listen_port,
    )
    return payload.as_dict()


@app.get("/api/search", response_model=SearchResponse)
async def api_search(q: str = Query(..., min_length=1)) -> SearchResponse:
    global _last_search_query, _last_search_at
    async with activity_tracker.track("search", activity_truncate(q)):
        source, releases = await search_service.search(q)
    _last_search_query = q
    _last_search_at = time.time()
    return SearchResponse(query=q, source=source, releases=releases)


@app.get("/api/system/status", response_model=SystemStatusResponse)
async def api_system_status() -> SystemStatusResponse:
    return await build_system_status(
        torrserver_url=settings.torrserver_url,
        torapi_url=settings.torapi_url,
        torr_cache=torr_cache,
        activity=activity_tracker,
        transcode_mgr=transcode_mgr,
        docker=docker_control,
        probe_warm=probe_warm,
        last_search_query=_last_search_query,
        last_search_at=_last_search_at,
    )


@app.post("/api/system/services/{service_id}/restart")
async def api_system_restart(service_id: str) -> dict[str, str]:
    try:
        await docker_control.restart_container(service_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except (ValueError, RuntimeError) as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"status": "restarting", "id": service_id}


@app.get("/api/releases/{provider}/{external_id}", response_model=ReleaseDetail)
async def api_release_detail(provider: Provider, external_id: str) -> ReleaseDetail:
    try:
        return await search_service.release_detail(provider, external_id)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


def _http_error_detail(exc: httpx.HTTPError) -> str:
    msg = str(exc).strip()
    return msg or type(exc).__name__


def _catalog_from_raw(info_hash: str, raw: list) -> list[TorrentMediaFile]:
    h = info_hash.lower()

    def stream_for(idx: int, path: str) -> str | None:
        kind = media_kind_for_path(path)
        if kind in (MediaKind.video, MediaKind.subtitle, MediaKind.audio):
            return torr.build_stream_url(h, path, idx)
        return None

    return build_media_catalog(raw, stream_url_for=stream_for)


async def _media_catalog(info_hash: str) -> list[TorrentMediaFile]:
    async with activity_tracker.track("prepare", info_hash[:8]):
        detail = await torr_cache.get_torrent_detail(info_hash)
    raw = _extract_files(detail)
    if not raw:
        raise HTTPException(status_code=504, detail="No files in torrent metadata")
    return _catalog_from_raw(info_hash, raw)


async def _probe_selected_file(
    info_hash: str,
    file_index: int,
    file_path: str,
    file_length: int = 0,
    *,
    on_attempt: Callable[[int, int], None] | None = None,
    on_live: Callable[[ProbeLiveStats], None] | None = None,
):
    return await probe_runner.probe_file(
        info_hash,
        file_index,
        file_path,
        file_length,
        allow_hevc=settings.transcode_allow_hevc_direct,
        on_attempt=on_attempt,
        on_live=on_live,
    )


async def _watch_ffmpeg_finalize(session_id: str) -> None:
    session = await transcode_mgr.get(session_id)
    if not session or not session.process:
        return
    try:
        await session.process.wait()
    except Exception:
        return
    refreshed = await transcode_mgr.get(session_id)
    if refreshed:
        transcode_mgr.mark_playlist_complete_if_ffmpeg_done(refreshed)


async def _start_ffmpeg_session(session_id: str) -> None:
    session = await transcode_mgr.get(session_id)
    if not session:
        return
    try:
        await transcode_mgr.ensure_ffmpeg(session)
        updated = await transcode_mgr.get(session_id)
        if updated and updated.process and updated.process.returncode is None:
            asyncio.create_task(_watch_ffmpeg_finalize(session_id))
    except Exception as e:
        logger.exception("ffmpeg start failed for %s: %s", session_id, e)


async def _create_transcode_playback(
    info_hash: str,
    file_index: int,
    file_path: str,
    stream_url: str,
    probe,
    *,
    file_length: int = 0,
    audio_index: int = 0,
    start_sec: float = 0.0,
    background_tasks: BackgroundTasks | None = None,
) -> PlayResponse:
    try:
        session = await transcode_mgr.create_session(
            info_hash=info_hash,
            file_index=file_index,
            file_path=file_path,
            source_url=torr.build_internal_stream_url(info_hash, file_path, file_index),
            probe=probe,
            audio_ordinal=audio_index,
            start_sec=start_sec,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    if background_tasks is not None:
        background_tasks.add_task(_start_ffmpeg_session, session.session_id)
    else:
        await _start_ffmpeg_session(session.session_id)

    return PlayResponse(
        hash=info_hash,
        title="",
        playback_mode=probe.playback_mode,
        playback_url=transcode_mgr.playback_url(session.session_id),
        transcode_session_id=session.session_id,
        direct_playable=False,
        probe_status="ok",
        stream_url=stream_url,
        file_name=file_path,
        file_index=file_index,
        audio_tracks=probe.audio_tracks,
        selected_audio_index=audio_index,
        duration_sec=probe.duration_sec,
        file_length=file_length or None,
    )


async def _playback_for_video(
    info_hash: str,
    selected: TorrentMediaFile,
    *,
    audio_index: int = 0,
    start_sec: float = 0.0,
    background_tasks: BackgroundTasks | None = None,
    on_probe_attempt: Callable[[int, int], None] | None = None,
    on_probe_live: Callable[[ProbeLiveStats], None] | None = None,
    on_transcode_start: Callable[[], None] | None = None,
) -> tuple[PlayResponse, object | None]:
    probe = await _probe_selected_file(
        info_hash,
        selected.id,
        selected.path,
        selected.length,
        on_attempt=on_probe_attempt,
        on_live=on_probe_live,
    )
    if probe.status == "pending":
        raise HTTPException(
            status_code=503,
            detail=(
                "Файл ещё не готов для анализа. Подождите начала загрузки и попробуйте снова."
            ),
        )

    base_fields = {
        "stream_url": selected.stream_url,
        "file_name": selected.path,
        "file_index": selected.id,
        "probe_status": "ok",
        "audio_tracks": probe.audio_tracks,
        "selected_audio_index": audio_index,
        "duration_sec": probe.duration_sec,
        "file_length": selected.length,
    }

    if probe.playback_mode == "direct":
        return (
            PlayResponse(
                hash=info_hash,
                title="",
                playback_mode="direct",
                playback_url=None,
                transcode_session_id=None,
                direct_playable=True,
                **base_fields,
            ),
            probe,
        )

    if not settings.transcode_enabled:
        return (
            PlayResponse(
                hash=info_hash,
                title="",
                playback_mode=probe.playback_mode,
                direct_playable=False,
                **base_fields,
            ),
            probe,
        )

    if on_transcode_start is not None:
        on_transcode_start()
    resp = await _create_transcode_playback(
        info_hash,
        selected.id,
        selected.path,
        selected.stream_url or "",
        probe,
        file_length=selected.length,
        audio_index=audio_index,
        start_sec=start_sec,
        background_tasks=background_tasks,
    )
    return resp, probe


def _select_video_file(
    files: list[TorrentMediaFile], file_index: int | None
) -> TorrentMediaFile | None:
    videos = [f for f in files if f.kind == MediaKind.video]
    if not videos:
        raise HTTPException(status_code=400, detail="No video files in torrent")
    if file_index is not None:
        for video in videos:
            if video.id == file_index:
                return video
        raise HTTPException(
            status_code=400,
            detail=f"Video file with index {file_index} not found",
        )
    if len(videos) == 1:
        return videos[0]
    return None


async def _resolve_magnet_and_meta(body: PlayRequest) -> tuple[str, str, Optional[str], Optional[str], Optional[str], Optional[str]]:
    magnet = body.magnet
    title = body.title or "Untitled"
    quality: Optional[str] = None
    voice: Optional[str] = None
    provider_str: Optional[str] = None
    external_id: Optional[str] = None

    if body.provider and body.external_id:
        try:
            detail = await search_service.release_detail(body.provider, body.external_id)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Release lookup failed: {e}") from e
        magnet = magnet or detail.magnet
        title = detail.title or title
        quality = detail.quality
        voice = detail.voice
        provider_str = body.provider.value
        external_id = body.external_id

    if not magnet:
        raise HTTPException(status_code=400, detail="magnet link is required")
    return magnet, title, quality, voice, provider_str, external_id


@app.get("/api/torrents/{info_hash}/media", response_model=PlayResponse)
async def api_torrent_media(info_hash: str) -> PlayResponse:
    h = info_hash.lower()
    detail = await torr_cache.get_torrent_detail(h)
    if not detail:
        raise HTTPException(status_code=404, detail="Torrent not found")
    files = await _media_catalog(h)
    meta = store.get(h)
    title = detail.get("title") or (meta.title if meta else h)
    return PlayResponse(hash=h, title=title, files=files)


@app.get("/api/torrents/{info_hash}/prepare", response_model=PrepareResponse)
async def api_torrent_prepare(info_hash: str) -> PrepareResponse:
    h = info_hash.lower()
    meta = store.get(h)
    try:
        async with activity_tracker.track("prepare", h[:8]):
            detail = await torr_cache.get_torrent_detail(h)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502, detail=f"TorrServer: {_http_error_detail(e)}"
        ) from e

    if not detail:
        retry = ""
        if meta and meta.provider and meta.external_id:
            retry = " Откройте раздачу в поиске и снова нажмите «Смотреть»."
        return PrepareResponse(
            hash=h,
            title=meta.title if meta else h,
            phase="missing",
            message=(
                "TorrServer не смог получить метаданные (таймаут или раздача удалена)."
                f"{retry} Проверьте VPN/доступ к BitTorrent или выберите другую раздачу."
            ),
            ready=False,
        )

    title = detail.get("title") or (meta.title if meta else h)
    stat = detail.get("stat_string") or "ожидание"
    peers = detail.get("total_peers")
    raw = _extract_files(detail)
    if not raw:
        hint = (
            " Большие сборники (сотни серий) могут ждать метаданные несколько минут."
            if peers and peers > 50
            else ""
        )
        return PrepareResponse(
            hash=h,
            title=title,
            phase="metadata",
            message=f"Получаем список файлов и подключаемся к пирам…{hint}",
            stat_string=stat,
            total_peers=peers,
            ready=False,
        )

    catalog = _catalog_from_raw(h, raw)
    # Do not block UI on mass priority updates (300+ files). Scope is applied in /play/select.
    _prepared_no_download.discard(h)

    return PrepareResponse(
        hash=h,
        title=title,
        phase="ready",
        message=(
            "Выберите файл для просмотра. При просмотре выбранный файл качается в первую "
            f"очередь, остальные — в фоне ({len(catalog)} файлов в раздаче)."
        ),
        stat_string=stat,
        total_peers=peers,
        files=catalog,
        ready=True,
    )


@app.post("/api/play/prepare", response_model=PrepareResponse)
async def api_play_prepare(body: PlayRequest) -> PrepareResponse:
    magnet, title, quality, voice, provider_str, external_id = await _resolve_magnet_and_meta(
        body
    )

    try:
        async with activity_tracker.track("prepare", "add"):
            added = await torr_cache.ensure_torrent(magnet, title, save_to_db=True)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"TorrServer add failed: {e}") from e

    info_hash = (added.get("hash") or info_hash_from_magnet(magnet) or "").lower()
    if not info_hash:
        raise HTTPException(status_code=502, detail="Could not determine info hash")

    store.upsert(
        TorrentMeta(
            info_hash=info_hash,
            title=title,
            provider=provider_str,
            external_id=external_id,
            quality=quality,
            voice=voice,
        )
    )

    return await api_torrent_prepare(info_hash)


@app.get("/api/play/select/status", response_model=PlaySelectStatusResponse)
async def api_play_select_status(
    hash: str = Query(..., min_length=8),
) -> PlaySelectStatusResponse:
    st = play_select_progress.get(hash)
    if not st:
        return PlaySelectStatusResponse(active=False)
    return PlaySelectStatusResponse(
        active=True,
        hash=st.hash,
        step=st.step,
        step_total=st.step_total,
        phase=st.phase,
        message=st.message,
        probe_attempt=st.probe_attempt,
        probe_max=st.probe_max,
        probe_bytes_downloaded=st.probe_bytes_downloaded,
        probe_bytes_target=st.probe_bytes_target,
        probe_download_speed=st.probe_download_speed,
        probe_total_peers=st.probe_total_peers,
        probe_subphase=st.probe_subphase,
        probe_elapsed_sec=st.probe_elapsed_sec,
    )


@app.post("/api/play/select", response_model=PlayResponse)
async def api_play_select(
    body: PlaySelectRequest, background_tasks: BackgroundTasks
) -> PlayResponse:
    h = body.hash.lower()
    probe_max = max(1, settings.transcode_probe_retries)
    step_total = 2 + probe_max + 1
    meta = store.get(h)

    current_probe_attempt = 1

    def set_progress(
        step: int,
        phase: PlaySelectPhase,
        message: str,
        *,
        probe_attempt: int = 0,
        probe_max: int = 0,
        probe_bytes_downloaded: int = 0,
        probe_bytes_target: int = 0,
        probe_download_speed: float | None = None,
        probe_total_peers: int | None = None,
        probe_subphase: str = "",
        probe_elapsed_sec: int = 0,
    ) -> None:
        play_select_progress.set(
            h,
            step=step,
            step_total=step_total,
            phase=phase,
            message=message,
            probe_attempt=probe_attempt,
            probe_max=probe_max,
            probe_bytes_downloaded=probe_bytes_downloaded,
            probe_bytes_target=probe_bytes_target,
            probe_download_speed=probe_download_speed,
            probe_total_peers=probe_total_peers,
            probe_subphase=probe_subphase,
            probe_elapsed_sec=probe_elapsed_sec,
        )

    def apply_probe_live(stats: ProbeLiveStats) -> None:
        step = 2 + current_probe_attempt
        set_progress(
            step,
            "probe",
            format_probe_status_message(
                stats,
                step=step,
                step_total=step_total,
                attempt=current_probe_attempt,
                attempt_max=probe_max,
            ),
            probe_attempt=current_probe_attempt,
            probe_max=probe_max,
            probe_bytes_downloaded=stats.bytes_downloaded,
            probe_bytes_target=stats.bytes_target,
            probe_download_speed=stats.download_speed,
            probe_total_peers=stats.total_peers,
            probe_subphase=stats.subphase,
            probe_elapsed_sec=stats.elapsed_sec,
        )

    try:
        set_progress(1, "torrent", "Этап 1: получаем состояние раздачи в TorrServer…")
        try:
            async with activity_tracker.track("play_select", h[:8]):
                detail = await torr_cache.get_torrent_detail(h)
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=502, detail=f"TorrServer: {_http_error_detail(e)}"
            ) from e
        if not detail:
            raise HTTPException(status_code=404, detail="Torrent not found")

        title = detail.get("title") or (meta.title if meta else h)
        raw = _extract_files(detail)
        if not raw:
            raise HTTPException(status_code=504, detail="No files in torrent metadata")
        catalog = _catalog_from_raw(h, raw)
        selected = _select_video_file(catalog, body.file_index)
        if not selected:
            raise HTTPException(status_code=400, detail="Video file not found")

        set_progress(
            2,
            "priority",
            "Этап 2: включаем загрузку выбранного файла и фоновую дозагрузку остальных…",
        )
        active = [body.file_index, *body.subtitle_file_ids]
        try:
            for file_id in active:
                await torr.set_file_priority(h, file_id, 7)
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=502,
                detail=f"Could not enable download for selected file: {_http_error_detail(e)}",
            ) from e

        torr_cache.invalidate_hash(h, ["list", "cache"])
        background_tasks.add_task(torr.configure_download_files, h, active, raw)

        def on_probe_attempt(attempt: int, total: int) -> None:
            nonlocal current_probe_attempt
            current_probe_attempt = attempt
            apply_probe_live(ProbeLiveStats(subphase="analyze_stream"))

        def on_transcode_start() -> None:
            set_progress(
                step_total,
                "transcode",
                f"Этап {step_total} из {step_total}: запуск перекодирования для браузера…",
            )

        playback, _probe = await _playback_for_video(
            h,
            selected,
            background_tasks=background_tasks,
            on_probe_attempt=on_probe_attempt,
            on_probe_live=apply_probe_live,
            on_transcode_start=on_transcode_start,
        )
        background_tasks.add_task(probe_warm.schedule_auto, h, catalog, body.file_index)
        return PlayResponse(
            hash=h,
            title=title,
            files=catalog,
            stream_url=playback.stream_url,
            file_name=playback.file_name,
            file_index=playback.file_index,
            playback_mode=playback.playback_mode,
            playback_url=playback.playback_url,
            transcode_session_id=playback.transcode_session_id,
            direct_playable=playback.direct_playable,
            probe_status=playback.probe_status,
            audio_tracks=playback.audio_tracks,
            selected_audio_index=playback.selected_audio_index,
            duration_sec=playback.duration_sec,
            file_length=playback.file_length,
        )
    finally:
        play_select_progress.clear(h)


@app.post("/api/transcode/session", response_model=TranscodeSessionResponse)
async def api_transcode_session(
    body: TranscodeSessionRequest, background_tasks: BackgroundTasks
) -> TranscodeSessionResponse:
    if not settings.transcode_enabled:
        raise HTTPException(status_code=503, detail="Transcode disabled")

    h = body.hash.lower()
    try:
        async with activity_tracker.track("transcode", h[:8]):
            detail = await torr_cache.get_torrent_detail(h)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=_http_error_detail(e)) from e
    if not detail:
        raise HTTPException(status_code=404, detail="Torrent not found")

    raw = _extract_files(detail)
    catalog = _catalog_from_raw(h, raw)
    selected = _select_video_file(catalog, body.file_index)
    if not selected:
        raise HTTPException(status_code=400, detail="Video file not found")

    probe = await _probe_selected_file(
        h, selected.id, selected.path, selected.length
    )
    if probe.status == "pending":
        cached = probe_runner.cached_probe_ok(
            h, selected.id, selected.path, selected.length
        )
        if cached is not None:
            probe = cached
        else:
            raise HTTPException(
                status_code=503,
                detail="Файл ещё не готов для перекодирования. Подождите загрузку.",
            )
    if probe.playback_mode == "direct":
        raise HTTPException(
            status_code=400,
            detail="Direct playback — transcode session not required",
        )

    if body.replace_session_id:
        await transcode_mgr.stop(body.replace_session_id.strip())

    try:
        session = await transcode_mgr.create_session(
            info_hash=h,
            file_index=selected.id,
            file_path=selected.path,
            source_url=torr.build_internal_stream_url(h, selected.path, selected.id),
            probe=probe,
            audio_ordinal=body.audio_index,
            start_sec=body.start_sec,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    background_tasks.add_task(_start_ffmpeg_session, session.session_id)
    return TranscodeSessionResponse(
        session_id=session.session_id,
        playback_url=transcode_mgr.playback_url(session.session_id),
        playback_mode=probe.playback_mode,
        selected_audio_index=body.audio_index,
        start_sec=body.start_sec,
        audio_tracks=probe.audio_tracks,
        duration_sec=probe.duration_sec,
        file_length=selected.length,
    )


@app.delete("/api/transcode/{session_id}")
async def api_transcode_stop(session_id: str) -> dict[str, str]:
    await transcode_mgr.stop(session_id)
    return {"status": "stopped", "session_id": session_id}


def _media_type_for_segment(name: str) -> str:
    lower = name.lower()
    if lower.endswith(".m3u8"):
        return "application/vnd.apple.mpegurl"
    if lower.endswith(".m4s"):
        return "video/iso.segment"
    if lower.endswith(".mp4"):
        return "video/mp4"
    return "application/octet-stream"


@app.get("/api/transcode/{session_id}/{filename}")
async def api_transcode_file(session_id: str, filename: str):
    session = await transcode_mgr.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    await transcode_mgr.ensure_ffmpeg(session)
    transcode_mgr.mark_playlist_complete_if_ffmpeg_done(session)
    if filename.endswith(".m3u8"):
        ready = await wait_playlist_ready(session, timeout=180.0)
        if not ready:
            raise HTTPException(
                status_code=503,
                detail="Перекодирование ещё не готово. Подождите…",
            )

    try:
        path = transcode_mgr.resolve_file(session, filename)
    except FileNotFoundError:
        if filename.endswith(".m3u8"):
            raise HTTPException(
                status_code=503,
                detail="Плейлист ещё не создан. Подождите…",
            ) from None
        raise HTTPException(status_code=404, detail="File not found") from None
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    cache_control = "no-cache"
    if filename.endswith(".m3u8") and is_hls_playlist_complete(session.out_dir):
        cache_control = "public, max-age=86400, immutable"

    return FileResponse(
        path,
        media_type=_media_type_for_segment(filename),
        headers={"Cache-Control": cache_control},
    )


@app.post("/api/torrents/{info_hash}/download-scope")
async def api_download_scope(info_hash: str, body: DownloadScopeBody) -> dict[str, str]:
    h = info_hash.lower()
    try:
        await torr.configure_download_files(h, body.file_ids)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    torr_cache.invalidate_hash(h, ["list", "cache"])
    return {"status": "ok", "hash": h}


@app.post("/api/torrents/{info_hash}/pause-download")
async def api_pause_download(info_hash: str) -> dict[str, str]:
    h = info_hash.lower()
    try:
        await torr.pause_all_files(h)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    torr_cache.invalidate_hash(h, ["list", "cache"])
    probe_warm.cancel_hash(h)
    return {"status": "paused", "hash": h}


@app.get("/api/torrents/{info_hash}/warm-probe", response_model=WarmProbeStatusResponse)
async def api_warm_probe_status(info_hash: str) -> WarmProbeStatusResponse:
    payload = probe_warm.status_payload(info_hash.lower())
    return WarmProbeStatusResponse(**payload)


@app.post(
    "/api/torrents/{info_hash}/warm-probe",
    response_model=WarmProbeStartResponse,
    status_code=202,
)
async def api_warm_probe_start(info_hash: str) -> WarmProbeStartResponse:
    if not probe_warm.enabled:
        raise HTTPException(
            status_code=400,
            detail="Прогрев ffprobe отключён (PROBE_WARM_BYTES=0).",
        )
    h = info_hash.lower()
    try:
        detail = await torr_cache.get_torrent_detail(h)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=_http_error_detail(e)) from e
    if not detail:
        raise HTTPException(status_code=404, detail="Torrent not found")
    raw = _extract_files(detail)
    if not raw:
        raise HTTPException(status_code=504, detail="No files in torrent metadata")
    queued, skipped = await probe_warm.schedule_manual(h, raw)
    return WarmProbeStartResponse(status="queued", queued=queued, skipped=skipped)


@app.post("/api/play", response_model=PlayResponse)
async def api_play(body: PlayRequest) -> PlayResponse:
    """Legacy: full prepare + optional auto-select single file."""
    prepared = await api_play_prepare(body)
    if not prepared.ready:
        try:
            await torr.wait_for_files(prepared.hash)
        except TimeoutError as e:
            raise HTTPException(status_code=504, detail=str(e)) from e
        prepared = await api_torrent_prepare(prepared.hash)

    if body.file_index is not None:
        return await api_play_select(
            PlaySelectRequest(hash=prepared.hash, file_index=body.file_index)
        )

    catalog = prepared.files
    selected = _select_video_file(catalog, None)
    if selected:
        return await api_play_select(
            PlaySelectRequest(hash=prepared.hash, file_index=selected.id)
        )

    return PlayResponse(hash=prepared.hash, title=prepared.title, files=catalog)


def _torrent_download_speed(item: dict) -> float | None:
    for key in ("download_speed", "DownloadSpeed", "downloadSpeed"):
        val = item.get(key)
        if val is not None:
            try:
                return float(val)
            except (TypeError, ValueError):
                continue
    return None


def _torrent_bytes_written_data(item: dict) -> int:
    for key in ("bytes_written_data", "BytesWrittenData", "bytes_written"):
        val = item.get(key)
        if val is not None:
            try:
                return max(0, int(val))
            except (TypeError, ValueError):
                continue
    return 0


def _build_file_stats(
    raw_files: list[dict],
    cache: dict,
    download_speed: float | None,
    *,
    bytes_written_data: int | None = None,
) -> list[TorrentFileStat]:
    progress = progress_from_cache(raw_files, cache)
    upload_map = upload_bytes_per_file(progress, bytes_written_data)
    active_ids = [fid for fid, p in progress.items() if p.get("priority", 0) >= 1]
    speed_for: set[int] = set()
    if download_speed and download_speed > 0 and active_ids:
        if len(active_ids) == 1:
            speed_for.add(active_ids[0])
        else:
            speed_for.add(
                max(active_ids, key=lambda i: progress[i].get("priority", 0))
            )

    stats: list[TorrentFileStat] = []
    for f in raw_files:
        fid = int(f.get("id") or f.get("Id") or 0)
        path = f.get("path") or f.get("Path") or ""
        length = int(f.get("length") or f.get("Length") or 0)
        prog = progress.get(fid, {"downloaded": 0, "priority": 0})
        downloaded = int(prog.get("downloaded") or 0)
        if length > 0:
            downloaded = min(downloaded, length)
        completed = length > 0 and downloaded >= length * 0.995
        stats.append(
            TorrentFileStat(
                id=fid,
                path=path,
                length=length,
                downloaded_bytes=downloaded,
                completed=completed,
                priority=int(prog.get("priority") or 0),
                download_speed=download_speed if fid in speed_for else None,
                kind=media_kind_for_path(path),
                uploaded_bytes=int(upload_map.get(fid) or 0),
            )
        )
    return stats


def _entry_from_list_item(
    item: dict,
    meta: TorrentMeta | None,
    cache: dict,
    torrents_base: Path,
) -> TorrentEntry | None:
    h = (item.get("hash") or "").lower()
    if not h:
        return None
    file_stats_raw = item.get("file_stats") or []
    if not file_stats_raw:
        file_stats_raw = _extract_files(item)
    dl_speed = _torrent_download_speed(item)
    reported_upload = _torrent_bytes_written_data(item)
    lifetime_upload = store.sync_upload_lifetime(h, reported_upload)
    file_stats = _build_file_stats(
        file_stats_raw,
        cache,
        dl_speed,
        bytes_written_data=lifetime_upload,
    )
    file_stats = overlay_warm_on_stats(file_stats, h, probe_warm)
    video_count = sum(1 for f in file_stats if f.kind == MediaKind.video)
    return TorrentEntry(
        hash=h,
        title=item.get("title") or (meta.title if meta else h),
        stat_string=item.get("stat_string"),
        torrent_size=item.get("torrent_size"),
        loaded_size=item.get("loaded_size"),
        preloaded_bytes=item.get("preloaded_bytes"),
        bytes_written_data=reported_upload,
        uploaded_bytes=lifetime_upload,
        download_speed=dl_speed,
        upload_speed=item.get("upload_speed"),
        total_peers=item.get("total_peers"),
        connected_seeders=item.get("connected_seeders"),
        quality=meta.quality if meta else None,
        voice=meta.voice if meta else None,
        search_query=meta.search_query if meta else None,
        provider=meta.provider if meta else None,
        file_stats=file_stats,
        on_disk_bytes=torrent_hash_dir_size(torrents_base, h),
        warm_summary=warm_summary_for_hash(h, probe_warm, video_count),
        probe_warm_enabled=probe_warm.enabled,
    )


@app.get("/api/torrents", response_model=TorrentListResponse)
async def api_torrents(
    detail: Optional[str] = Query(None, description="Comma-separated info hashes for file progress"),
) -> TorrentListResponse:
    detail_hashes = {h.strip().lower() for h in (detail or "").split(",") if h.strip()}
    async with activity_tracker.track("torrents_list", None):
        items = await torr_cache.list_items(max_age=TorrStateCache.LIST_TTL_LIBRARY)
    torrents_base = Path(settings.torrents_save_path)
    items_by_hash = {(item.get("hash") or "").lower(): item for item in items}

    cache_by_hash: dict[str, dict] = {}

    async def fetch_detail_cache(h: str) -> tuple[str, dict]:
        item = items_by_hash.get(h) or {}
        if not item:
            return h, {}
        data = await torr_cache.get_cache_pieces(h, list_item=item)
        return h, data

    if detail_hashes:
        pairs = await asyncio.gather(*(fetch_detail_cache(h) for h in detail_hashes))
        cache_by_hash = dict(pairs)

    entries: list[TorrentEntry] = []
    for item in items:
        h = (item.get("hash") or "").lower()
        meta = store.get(h) if h else None
        cache = cache_by_hash.get(h, {}) if h in detail_hashes else {}
        entry = _entry_from_list_item(item, meta, cache, torrents_base)
        if entry:
            entries.append(entry)

    summary = storage_summary(settings.torrents_save_path)
    return TorrentListResponse(
        storage=StorageSummary(**summary),
        torrents=entries,
    )


@app.delete("/api/torrents/{info_hash}")
async def api_delete_torrent(
    info_hash: str,
    delete_files: bool = Query(default=True, alias="deleteFiles"),
) -> dict[str, str]:
    h = info_hash.lower()
    try:
        await torr.drop_torrent(h)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if delete_files:
        torr.delete_cache_dir(h)
    store.delete(h)
    probe_cache.delete_hash(h)
    remove_hash_heads(_probe_head_dir, h)
    probe_warm.cancel_hash(h)
    torr_cache.remove_hash(h)
    torr_cache.invalidate_list()
    return {"status": "deleted", "hash": h}
