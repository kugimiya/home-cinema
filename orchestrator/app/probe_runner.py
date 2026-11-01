from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Callable

from app.clients.torrserver import TorrServerClient, _extract_files
from app.config import Settings
from app.file_progress import progress_from_cache
from app.playback_probe import ProbeResult, ffprobe_path, probe_playback
from app.probe_head import ensure_head_file, head_cache_path
from app.probe_messages import ProbeLiveStats
from app.probe_store import ProbeCacheStore, default_warm_head_bytes
from app.torr_cache import TorrStateCache

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
        torr: TorrServerClient,
        torr_cache: TorrStateCache,
        settings: Settings,
        head_dir: Path,
    ) -> None:
        self._store = store
        self._torr = torr
        self._torr_cache = torr_cache
        self._settings = settings
        self._head_dir = head_dir
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
            detail = await self._torr_cache.find_list_item(info_hash)
            raw = _extract_files(detail)
            if not raw:
                return 0
            cache = await self._torr_cache.get_cache_pieces(info_hash, list_item=detail)
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
        file_length: int,
        target: int,
    ) -> ProbeLiveStats:
        downloaded = await self._file_downloaded(info_hash, file_id, file_length)
        head_path = head_cache_path(self._head_dir, info_hash, file_id)
        if head_path.is_file():
            downloaded = max(downloaded, head_path.stat().st_size)
        speed: float | None = None
        peers: int | None = None
        try:
            item = await self._torr_cache.find_list_item(info_hash)
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
        internal_url = self._torr.build_internal_stream_url(h, file_path, file_id)

        async def tick(subphase: str, elapsed: int) -> None:
            if not on_live:
                return
            stats = await self._live_stats(h, file_id, file_length, target)
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
                self._torr,
                self._head_dir,
                h,
                file_path,
                file_id,
                file_length,
                target,
            )
            if head_path and head_size > 0:
                if on_live:
                    stats = await self._live_stats(h, file_id, file_length, target)
                    stats.subphase = "analyze_head"
                    on_live(stats)
                try:
                    data = await ffprobe_path(str(head_path), timeout=min(30.0, self._settings.transcode_probe_timeout))
                    from app.playback_probe import _parse_probe_payload

                    result = _parse_probe_payload(data, file_path, allow_hevc)
                    if not duration_likely_incomplete(result.duration_sec, file_length):
                        self._store.save_probe(
                            h,
                            file_id,
                            file_path,
                            file_length,
                            result,
                            warm_head_bytes=max(head_size, target),
                        )
                        return result
                    logger.info(
                        "head ffprobe short duration (%s), trying stream",
                        result.duration_sec,
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
