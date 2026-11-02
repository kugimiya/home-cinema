from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import replace
from pathlib import Path
from typing import Callable

from app.clients.torrent_engine import TorrentEngineClient
from app.torrent_files import extract_files
from app.config import Settings
from app.file_progress import progress_from_cache
from app.media_paths import find_torrent_media_file
from app.playback_probe import (
    ProbeResult,
    ffprobe_path,
    probe_playback,
    resolve_probe_duration,
)
from app.probe_head import ensure_head_file, head_cache_path
from app.probe_messages import ProbeLiveStats, probe_prefix_bytes_from_start
from app.probe_store import ProbeCacheStore, default_warm_head_bytes
from app.torrent_cache import TorrentStateCache

logger = logging.getLogger(__name__)


def duration_likely_incomplete(duration_sec: float | None, file_length: int) -> bool:
    if file_length <= 0:
        return False
    if duration_sec is None:
        return True
    if file_length > 100 * 1024 * 1024 and duration_sec < 300:
        return True
    if file_length > 500 * 1024 * 1024 and duration_sec < 900:
        return True
    megabytes = file_length / (1024 * 1024)
    expected_min = max(60.0, megabytes * 1.5)
    return duration_sec < expected_min


class ProbeRunner:
    def __init__(
        self,
        *,
        store: ProbeCacheStore,
        torrent_engine: TorrentEngineClient,
        torrent_cache: TorrentStateCache,
        settings: Settings,
        head_dir: Path,
    ) -> None:
        self._store = store
        self._torrent_engine = torrent_engine
        self._torrent_cache = torrent_cache
        self._settings = settings
        self._head_dir = head_dir
        self._torrents_root = Path(settings.torrent_engine_save_path)
        self._head_dir.mkdir(parents=True, exist_ok=True)

    def cached_probe_ok(
        self,
        info_hash: str,
        file_id: int,
        file_path: str,
        file_length: int,
    ) -> ProbeResult | None:
        cached = self._store.get_cached_probe(
            info_hash, file_id, file_path, file_length
        )
        if cached is not None and cached.status == "ok":
            return cached
        return None

    def _finalize_probe_result(
        self,
        info_hash: str,
        file_id: int,
        file_path: str,
        file_length: int,
        result: ProbeResult,
        *,
        warm_head_bytes: int,
    ) -> ProbeResult:
        duration = resolve_probe_duration(result.duration_sec, file_length)
        if duration is not None and duration != result.duration_sec:
            logger.info(
                "probe duration estimate %s file %s: %.0fs -> %.0fs",
                info_hash[:8],
                file_id,
                result.duration_sec or 0,
                duration,
            )
            result = replace(result, duration_sec=duration)
        self._store.save_probe(
            info_hash,
            file_id,
            file_path,
            file_length,
            result,
            warm_head_bytes=warm_head_bytes,
        )
        return result

    def warm_target_bytes(
        self, info_hash: str, file_id: int, file_path: str, file_length: int
    ) -> int:
        if self._settings.probe_warm_bytes <= 0:
            return 0
        stored = self._store.get_warm_head_bytes(info_hash, file_id)
        if stored is not None and stored > 0:
            return stored
        return default_warm_head_bytes(
            file_path,
            file_length,
            fallback=self._settings.probe_warm_bytes,
        )

    async def _file_downloaded(self, info_hash: str, file_id: int, file_length: int) -> int:
        try:
            detail = await self._torrent_cache.find_list_item(info_hash)
            raw = extract_files(detail)
            if not raw:
                return 0
            cache = await self._torrent_cache.get_cache_pieces(info_hash, list_item=detail)
            progress = progress_from_cache(raw, cache)
            prog = progress.get(file_id, {})
            downloaded = int(prog.get("downloaded") or 0)
            if file_length > 0:
                return min(downloaded, file_length)
            return downloaded
        except Exception:
            return 0

    async def _live_stats(
        self,
        info_hash: str,
        file_id: int,
        file_path: str,
        file_length: int,
        target: int,
    ) -> ProbeLiveStats:
        head_path = head_cache_path(self._head_dir, info_hash, file_id)
        head_bytes = int(head_path.stat().st_size) if head_path.is_file() else 0
        local_size = 0
        local_media = find_torrent_media_file(self._torrents_root, file_path)
        if local_media and local_media.is_file():
            local_size = int(local_media.stat().st_size)
        torrent_downloaded = await self._file_downloaded(info_hash, file_id, file_length)
        downloaded = probe_prefix_bytes_from_start(
            target=target,
            head_bytes=head_bytes,
            local_file_size=local_size,
            torrent_downloaded=torrent_downloaded,
        )
        speed: float | None = None
        peers: int | None = None
        try:
            item = await self._torrent_cache.find_list_item(info_hash)
            if item:
                for key in ("download_speed", "DownloadSpeed"):
                    v = item.get(key)
                    if v is not None:
                        speed = float(v)
                        break
                for key in ("total_peers", "TotalPeers"):
                    v = item.get(key)
                    if v is not None:
                        peers = int(v)
                        break
        except Exception:
            pass
        return ProbeLiveStats(
            bytes_downloaded=downloaded,
            bytes_target=target,
            download_speed=speed,
            total_peers=peers,
        )

    async def probe_file(
        self,
        info_hash: str,
        file_id: int,
        file_path: str,
        file_length: int,
        *,
        allow_hevc: bool,
        on_attempt: Callable[[int, int], None] | None = None,
        on_live: Callable[[ProbeLiveStats], None] | None = None,
    ) -> ProbeResult:
        h = info_hash.lower()
        cached = self._store.get_cached_probe(h, file_id, file_path, file_length)
        if cached is not None:
            duration = resolve_probe_duration(cached.duration_sec, file_length)
            if duration is not None and duration != cached.duration_sec:
                cached = replace(cached, duration_sec=duration)
        if cached is not None and not duration_likely_incomplete(
            cached.duration_sec, file_length
        ):
            logger.info("probe cache hit %s file %s", h[:8], file_id)
            if on_live:
                on_live(
                    ProbeLiveStats(
                        bytes_downloaded=0,
                        bytes_target=0,
                        subphase="cache",
                    )
                )
            return cached
        if cached is not None:
            logger.info(
                "probe cache skipped (short duration) %s file %s",
                h[:8],
                file_id,
            )

        target = self.warm_target_bytes(h, file_id, file_path, file_length)
        internal_url = self._torrent_engine.build_internal_stream_url(h, file_path, file_id)

        local_media = find_torrent_media_file(self._torrents_root, file_path)
        if local_media and local_media.is_file():
            min_on_disk = min(target, 512 * 1024) if target > 0 else 512 * 1024
            if local_media.stat().st_size >= min_on_disk:
                if on_live:
                    local_size = int(local_media.stat().st_size)
                    stats = ProbeLiveStats(
                        bytes_downloaded=probe_prefix_bytes_from_start(
                            target=target,
                            local_file_size=local_size,
                        ),
                        bytes_target=target if target > 0 else local_size,
                        subphase="analyze_head",
                    )
                    on_live(stats)
                try:
                    from app.playback_probe import _parse_probe_payload

                    data = await ffprobe_path(
                        str(local_media),
                        timeout=min(60.0, self._settings.transcode_probe_timeout),
                    )
                    result = _parse_probe_payload(data, file_path, allow_hevc)
                    logger.info(
                        "probe local disk ok %s file %s path=%s",
                        h[:8],
                        file_id,
                        local_media,
                    )
                    return self._finalize_probe_result(
                        h,
                        file_id,
                        file_path,
                        file_length,
                        result,
                        warm_head_bytes=max(target, local_media.stat().st_size),
                    )
                except Exception as e:
                    logger.info("local ffprobe failed, continuing: %s", e)

        async def tick(subphase: str, elapsed: int) -> None:
            if not on_live:
                return
            stats = await self._live_stats(
                h, file_id, file_path, file_length, target
            )
            stats.subphase = subphase
            stats.elapsed_sec = elapsed
            on_live(stats)

        if target > 0:
            if on_live:
                on_live(
                    ProbeLiveStats(
                        bytes_downloaded=0,
                        bytes_target=target,
                        subphase="prefetch_head",
                    )
                )
            head_path, head_size = await ensure_head_file(
                self._torrent_engine,
                self._head_dir,
                h,
                file_path,
                file_id,
                file_length,
                target,
            )
            if head_path and head_size > 0:
                if on_live:
                    stats = await self._live_stats(
                        h, file_id, file_path, file_length, target
                    )
                    stats.subphase = "analyze_head"
                    on_live(stats)
                try:
                    data = await ffprobe_path(str(head_path), timeout=min(30.0, self._settings.transcode_probe_timeout))
                    from app.playback_probe import _parse_probe_payload

                    result = _parse_probe_payload(data, file_path, allow_hevc)
                    return self._finalize_probe_result(
                        h,
                        file_id,
                        file_path,
                        file_length,
                        result,
                        warm_head_bytes=max(head_size, target),
                    )
                except Exception as e:
                    logger.info("head ffprobe failed, trying stream: %s", e)

        def sync_tick(elapsed: int, subphase: str) -> None:
            asyncio.create_task(tick(subphase, elapsed))

        result = await probe_playback(
            internal_url,
            file_path,
            allow_hevc=allow_hevc,
            timeout=self._settings.transcode_probe_timeout,
            retries=self._settings.transcode_probe_retries,
            retry_delay=self._settings.transcode_probe_retry_delay,
            on_attempt=on_attempt,
            on_tick=sync_tick if on_live else None,
        )

        if result.status == "ok":
            downloaded = await self._file_downloaded(h, file_id, file_length)
            head_path = head_cache_path(self._head_dir, h, file_id)
            head_size = head_path.stat().st_size if head_path.is_file() else 0
            warm_saved = max(target, downloaded, head_size)
            needs_tail = warm_saved > target * 2 or (
                file_length > 0 and warm_saved >= file_length * 0.5
            )
            self._store.save_probe(
                h,
                file_id,
                file_path,
                file_length,
                result,
                warm_head_bytes=warm_saved,
                needs_stream_tail=needs_tail,
            )
        return result
