from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

# libtorrent file priorities: 0 = skip, 7 = highest (streaming file).
PRIORITY_OFF = 0
PRIORITY_BACKGROUND = 1
PRIORITY_STREAM = 7

_BTIH_HEX = re.compile(r"btih:([a-f0-9]{40})", re.I)
_BTIH_B32 = re.compile(r"btih:([a-z2-7]{32})", re.I)


def info_hash_from_magnet(link: str) -> Optional[str]:
    m = _BTIH_HEX.search(link)
    if m:
        return m.group(1).lower()
    m = _BTIH_B32.search(link)
    if not m:
        return None
    try:
        encoded = m.group(1).upper()
        encoded += "=" * (-len(encoded) % 8)
        raw = base64.b32decode(encoded)
    except (ValueError, TypeError):
        return None
    return raw.hex().lower()


class TorrServerClient:
    def __init__(
        self,
        base_url: str,
        public_base_url: str,
        torrents_save_path: str,
        metadata_timeout: float,
        request_timeout: float = 120.0,
        list_timeout: float = 45.0,
        cache_size_mb: int = 128,
        preload_cache: int = 40,
        connections_limit: int = 40,
        reader_read_ahead: int = 95,
        priority_concurrency: int = 4,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.public_base_url = public_base_url.rstrip("/")
        self.torrents_save_path = torrents_save_path
        self.metadata_timeout = metadata_timeout
        self.request_timeout = request_timeout
        self.list_timeout = list_timeout
        self.cache_size_bytes = max(32, cache_size_mb) * 1024 * 1024
        self.preload_cache = max(0, min(100, preload_cache))
        self.connections_limit = max(10, min(100, connections_limit))
        self.reader_read_ahead = max(5, min(100, reader_read_ahead))
        self.priority_concurrency = max(1, min(16, priority_concurrency))

    async def wait_ready(self, attempts: int = 30, delay: float = 2.0) -> None:
        last: Optional[Exception] = None
        for _ in range(attempts):
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{self.base_url}/")
                    if r.status_code == 200:
                        return
            except httpx.HTTPError as e:
                last = e
            await asyncio.sleep(delay)
        if last:
            raise last
        raise RuntimeError("TorrServer not ready")

    async def bootstrap_disk_settings(self) -> None:
        current = await self.get_settings()
        merged = {**current}
        merged["UseDisk"] = True
        merged["TorrentsSavePath"] = self.torrents_save_path
        merged["RemoveCacheOnDrop"] = False
        merged["CacheSize"] = self.cache_size_bytes
        merged["PreloadCache"] = self.preload_cache
        merged["ConnectionsLimit"] = self.connections_limit
        merged["ReaderReadAHead"] = self.reader_read_ahead
        merged["ResponsiveMode"] = True
        merged["DownloadRateLimit"] = 0
        merged["StoreSettingsInJson"] = True
        if merged.get("RetrackersMode") is None:
            merged["RetrackersMode"] = 1
        await self.set_settings(merged)
        logger.info(
            "TorrServer settings applied: UseDisk=%s path=%s CacheSize=%sMB Preload=%s%% conn=%s",
            merged.get("UseDisk"),
            merged.get("TorrentsSavePath"),
            self.cache_size_bytes // (1024 * 1024),
            self.preload_cache,
            self.connections_limit,
        )

    async def get_settings(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{self.base_url}/settings",
                json={"action": "get"},
            )
            r.raise_for_status()
            return r.json()

    async def set_settings(self, sets: dict[str, Any]) -> None:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{self.base_url}/settings",
                json={"action": "set", "sets": sets},
            )
            r.raise_for_status()

    async def add_torrent(self, link: str, title: str, save_to_db: bool = True) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.post(
                f"{self.base_url}/torrents",
                json={
                    "action": "add",
                    "link": link,
                    "title": title,
                    "save_to_db": save_to_db,
                },
            )
            r.raise_for_status()
            return r.json()

    async def ensure_torrent(
        self, link: str, title: str, save_to_db: bool = True
    ) -> dict[str, Any]:
        """Add torrent once; if already in TorrServer, skip duplicate add."""
        info_hash = info_hash_from_magnet(link)
        if info_hash:
            try:
                existing = await self.find_list_item(info_hash)
            except httpx.HTTPError as e:
                logger.warning("list before add failed (%s): %s", info_hash[:8], e)
                existing = {}
            if existing:
                logger.info("Torrent %s already in TorrServer, skipping add", info_hash[:8])
                merged = dict(existing)
                merged.setdefault("hash", info_hash)
                return merged
        added = await self.add_torrent(link, title, save_to_db=save_to_db)
        if not added.get("hash") and info_hash:
            added["hash"] = info_hash
        return added

    async def get_torrent(self, info_hash: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.post(
                f"{self.base_url}/torrents",
                json={"action": "get", "hash": info_hash.lower()},
            )
            if r.status_code == 404:
                return {}
            r.raise_for_status()
            return r.json()

    async def get_cache(self, info_hash: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.list_timeout) as client:
            r = await client.post(
                f"{self.base_url}/cache",
                json={"action": "get", "hash": info_hash.lower()},
            )
            if r.status_code == 404:
                return {}
            r.raise_for_status()
            data = r.json()
            return data if isinstance(data, dict) else {}

    async def list_torrents(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self.list_timeout) as client:
            r = await client.post(
                f"{self.base_url}/torrents",
                json={"action": "list"},
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                return data
            return []

    async def find_list_item(self, info_hash: str) -> dict[str, Any]:
        h = info_hash.lower()
        for item in await self.list_torrents():
            if (item.get("hash") or "").lower() == h:
                return item
        return {}

    async def get_torrent_status(self, info_hash: str) -> dict[str, Any]:
        """Prefer fast `list` (includes cached `data`); fall back to `get`."""
        listed = await self.find_list_item(info_hash)
        if listed and _extract_files(listed):
            return listed
        detail = await self.get_torrent(info_hash)
        if detail:
            return detail
        return listed

    async def drop_torrent(self, info_hash: str) -> None:
        """Remove torrent from TorrServer (DB + active session). `drop` alone leaves it in the list."""
        h = info_hash.lower()
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            try:
                await client.post(
                    f"{self.base_url}/torrents",
                    json={"action": "drop", "hash": h},
                )
            except httpx.HTTPError:
                logger.warning("TorrServer drop before rem failed for %s", h[:8])
            r = await client.post(
                f"{self.base_url}/torrents",
                json={"action": "rem", "hash": h},
            )
            r.raise_for_status()

    async def set_file_priority(
        self, info_hash: str, file_index: int, priority: int
    ) -> None:
        timeout = min(self.request_timeout, 45.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(
                f"{self.base_url}/torrents",
                json={
                    "action": "set",
                    "hash": info_hash.lower(),
                    "file_index": file_index,
                    "priority": priority,
                },
            )
            r.raise_for_status()

    async def _apply_file_priorities(
        self,
        info_hash: str,
        raw_files: list[dict[str, Any]],
        active_file_indices: set[int],
    ) -> None:
        h = info_hash.lower()
        sem = asyncio.Semaphore(self.priority_concurrency)
        timeout = httpx.Timeout(30.0, connect=10.0)
        failures: list[str] = []

        async with httpx.AsyncClient(timeout=timeout) as client:

            async def set_one(file_index: int, priority: int) -> None:
                async with sem:
                    try:
                        r = await client.post(
                            f"{self.base_url}/torrents",
                            json={
                                "action": "set",
                                "hash": h,
                                "file_index": file_index,
                                "priority": priority,
                            },
                        )
                        r.raise_for_status()
                    except httpx.HTTPError as e:
                        failures.append(str(e) or type(e).__name__)

            tasks = []
            for entry in raw_files:
                idx = int(entry.get("id") or entry.get("Id") or 0)
                if idx <= 0:
                    continue
                priority = file_download_priority(idx, active_file_indices)
                tasks.append(set_one(idx, priority))
            if tasks:
                await asyncio.gather(*tasks)

        if tasks and failures and len(failures) >= len(tasks):
            raise httpx.HTTPError(
                f"Не удалось обновить приоритеты файлов ({len(failures)} ошибок): "
                f"{failures[0]}"
            )
        if failures:
            logger.warning(
                "Partial priority update for %s: %s/%s failed",
                h[:8],
                len(failures),
                len(tasks),
            )

    async def configure_download_files(
        self,
        info_hash: str,
        active_file_indices: list[int],
        raw_files: list[dict[str, Any]] | None = None,
    ) -> None:
        """Streaming files get highest priority; other files download in the background."""
        h = info_hash.lower()
        raw = raw_files if raw_files is not None else _extract_files(
            await self.get_torrent_status(h)
        )
        if not raw:
            raise ValueError("No files in torrent")
        active = {int(i) for i in active_file_indices}
        await self._apply_file_priorities(h, raw, active)
        logger.info(
            "Download scope for %s: active files %s (of %s)",
            h[:8],
            sorted(active),
            len(raw),
        )

    async def pause_all_files(
        self, info_hash: str, raw_files: list[dict[str, Any]] | None = None
    ) -> None:
        await self.configure_download_files(info_hash, [], raw_files=raw_files)

    async def wait_for_files(self, info_hash: str) -> dict[str, Any]:
        deadline = asyncio.get_event_loop().time() + self.metadata_timeout
        last_error: Optional[Exception] = None
        while asyncio.get_event_loop().time() < deadline:
            try:
                st = await self.get_torrent(info_hash)
            except httpx.HTTPError as e:
                last_error = e
                logger.warning(
                    "get_torrent while waiting for metadata (%s): %s",
                    info_hash[:8],
                    e,
                )
                await asyncio.sleep(3)
                continue
            if not st:
                await asyncio.sleep(2)
                continue
            files = _extract_files(st)
            if files:
                return st
            stat = st.get("stat_string") or ""
            if "closed" in stat.lower():
                break
            await asyncio.sleep(2)
        try:
            st = await self.get_torrent(info_hash)
        except httpx.HTTPError as e:
            last_error = e
            st = {}
        files = _extract_files(st)
        if files:
            return st
        if last_error:
            raise TimeoutError(
                f"TorrServer не ответил при ожидании метаданных: {last_error}"
            ) from last_error
        raise TimeoutError("Timed out waiting for torrent metadata from TorrServer")

    def _stream_path(self, info_hash: str, file_path: str, file_index: int) -> str:
        encoded = quote(file_path, safe="")
        return (
            f"/stream/{encoded}"
            f"?link={info_hash.lower()}&index={file_index}&play"
        )

    def build_stream_url(self, info_hash: str, file_path: str, file_index: int) -> str:
        return f"{self.public_base_url.rstrip('/')}{self._stream_path(info_hash, file_path, file_index)}"

    def build_internal_stream_url(
        self, info_hash: str, file_path: str, file_index: int
    ) -> str:
        return f"{self.base_url.rstrip('/')}{self._stream_path(info_hash, file_path, file_index)}"

    def delete_cache_dir(self, info_hash: str) -> None:
        path = Path(self.torrents_save_path) / info_hash.lower()
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)


def file_download_priority(file_index: int, active_file_indices: set[int]) -> int:
    """Map a torrent file to libtorrent priority (stream > background > off)."""
    if file_index in active_file_indices:
        return PRIORITY_STREAM
    if active_file_indices:
        return PRIORITY_BACKGROUND
    return PRIORITY_OFF


def _extract_files(status: dict[str, Any]) -> list[dict[str, Any]]:
    if not status:
        return []
    raw = status.get("file_stats")
    if isinstance(raw, list) and raw:
        return raw
    data = status.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            data = None
    if isinstance(data, dict):
        torr = data.get("TorrServer") or data
        files = torr.get("Files") if isinstance(torr, dict) else None
        if isinstance(files, list):
            return files
    return []


def pick_video_file(files: list[dict[str, Any]]) -> dict[str, Any]:
    video_ext = (".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts")
    candidates = []
    for f in files:
        path = f.get("path") or f.get("Path") or ""
        if path.lower().endswith(video_ext):
            candidates.append(f)
    if not candidates:
        if files:
            return files[0]
        raise ValueError("No files in torrent")
    return max(candidates, key=lambda x: int(x.get("length") or x.get("Length") or 0))


def file_index_and_path(file_entry: dict[str, Any]) -> tuple[int, str]:
    idx = int(file_entry.get("id") or file_entry.get("Id") or 1)
    path = file_entry.get("path") or file_entry.get("Path") or "video.mkv"
    return idx, path
