from __future__ import annotations

import asyncio
import base64
import logging
import shutil
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import httpx

from app.torrent_files import (
    PRIORITY_OFF,
    PRIORITY_STREAM,
    extract_files,
    file_download_priority,
    info_hash_from_magnet,
)

logger = logging.getLogger(__name__)


class TorrentEngineClient:
    """HTTP client for home-cinema torrent-engine (v1 API)."""

    def __init__(
        self,
        base_url: str,
        public_base_url: str,
        torrents_save_path: str,
        metadata_timeout: float,
        request_timeout: float = 120.0,
        list_timeout: float = 45.0,
        connections_limit: int = 500,
        priority_concurrency: int = 4,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.public_base_url = public_base_url.rstrip("/")
        self.torrents_save_path = torrents_save_path
        self.metadata_timeout = metadata_timeout
        self.request_timeout = request_timeout
        self.list_timeout = list_timeout
        self.connections_limit = max(10, min(500, connections_limit))
        self.priority_concurrency = max(1, min(16, priority_concurrency))

    async def wait_ready(self, attempts: int = 30, delay: float = 2.0) -> None:
        last: Optional[Exception] = None
        for _ in range(attempts):
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(f"{self.base_url}/health")
                    if r.status_code == 200:
                        return
            except httpx.HTTPError as e:
                last = e
            await asyncio.sleep(delay)
        if last:
            raise last
        raise RuntimeError("torrent-engine not ready")

    async def bootstrap_disk_settings(self) -> None:
        logger.info("torrent-engine: disk path=%s (configured in engine)", self.torrents_save_path)

    async def add_torrent(self, link: str, title: str, save_to_db: bool = True) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.post(
                f"{self.base_url}/v1/torrents",
                json={"link": link, "title": title, "save_to_db": save_to_db},
            )
            r.raise_for_status()
            return r.json()

    async def add_torrent_bytes(
        self,
        data: bytes,
        title: str,
        *,
        magnet: str = "",
        save_to_db: bool = True,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.post(
                f"{self.base_url}/v1/torrents",
                json={
                    "title": title,
                    "save_to_db": save_to_db,
                    "torrent_b64": base64.b64encode(data).decode("ascii"),
                    "magnet": magnet,
                },
            )
            r.raise_for_status()
            return r.json()

    async def ensure_torrent(
        self, link: str, title: str, save_to_db: bool = True
    ) -> dict[str, Any]:
        info_hash = info_hash_from_magnet(link)
        if info_hash:
            existing = await self.find_list_item(info_hash)
            if existing:
                merged = dict(existing)
                merged.setdefault("hash", info_hash)
                return merged
        added = await self.add_torrent(link, title, save_to_db=save_to_db)
        if not added.get("hash") and info_hash:
            added["hash"] = info_hash
        return added

    async def get_torrent(self, info_hash: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.get(f"{self.base_url}/v1/torrents/{info_hash.lower()}")
            if r.status_code == 404:
                return {}
            r.raise_for_status()
            return r.json()

    async def get_cache(self, info_hash: str) -> dict[str, Any]:
        detail = await self.get_torrent(info_hash)
        files = detail.get("file_stats") or []
        if files:
            return {"_engine_files": files}
        return {}

    async def list_torrents(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self.list_timeout) as client:
            r = await client.get(f"{self.base_url}/v1/torrents")
            r.raise_for_status()
            data = r.json()
            return data if isinstance(data, list) else []

    async def find_list_item(self, info_hash: str) -> dict[str, Any]:
        h = info_hash.lower()
        for item in await self.list_torrents():
            if (item.get("hash") or "").lower() == h:
                return item
        return {}

    async def get_torrent_status(self, info_hash: str) -> dict[str, Any]:
        listed = await self.find_list_item(info_hash)
        if listed and extract_files(listed):
            return listed
        detail = await self.get_torrent(info_hash)
        if detail:
            return detail
        return listed

    async def drop_torrent(self, info_hash: str) -> None:
        await self.remove_torrent(info_hash)

    async def remove_torrent(self, info_hash: str) -> None:
        h = info_hash.lower()
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.delete(f"{self.base_url}/v1/torrents/{h}")
            r.raise_for_status()

    async def set_file_priority(
        self, info_hash: str, file_index: int, priority: int
    ) -> None:
        h = info_hash.lower()
        detail = await self.get_torrent(h)
        files = extract_files(detail)
        active = {
            int(f.get("id") or 0)
            for f in files
            if int(f.get("priority") or 0) >= PRIORITY_STREAM
        }
        if priority >= PRIORITY_STREAM:
            active.add(file_index)
        elif file_index in active:
            active.discard(file_index)
        await self.configure_download_files(h, list(active), raw_files=files)

    async def configure_download_files(
        self,
        info_hash: str,
        active_file_indices: list[int],
        raw_files: list[dict[str, Any]] | None = None,
    ) -> None:
        h = info_hash.lower()
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.post(
                f"{self.base_url}/v1/torrents/{h}/scope",
                json={"file_ids": [int(i) for i in active_file_indices]},
            )
            r.raise_for_status()
            mode = "streaming" if active_file_indices else "paused"
            r2 = await client.post(
                f"{self.base_url}/v1/torrents/{h}/mode",
                json={"mode": mode},
            )
            r2.raise_for_status()

    async def set_mode(self, info_hash: str, mode: str) -> None:
        h = info_hash.lower()
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            r = await client.post(
                f"{self.base_url}/v1/torrents/{h}/mode",
                json={"mode": mode},
            )
            r.raise_for_status()

    async def playback_ended(self, info_hash: str, file_ids: list[int]) -> None:
        h = info_hash.lower()
        async with httpx.AsyncClient(timeout=30.0) as client:
            await client.post(
                f"{self.base_url}/v1/torrents/{h}/scope",
                json={"file_ids": file_ids},
            )
            await client.post(
                f"{self.base_url}/v1/torrents/{h}/mode",
                json={"mode": "completing"},
            )

    async def heartbeat(
        self, info_hash: str, file_ids: list[int], stream_active: bool
    ) -> None:
        h = info_hash.lower()
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{self.base_url}/v1/torrents/{h}/heartbeat",
                json={"file_ids": file_ids, "stream_active": stream_active},
            )

    async def pause_all_files(
        self, info_hash: str, raw_files: list[dict[str, Any]] | None = None
    ) -> None:
        await self.set_mode(info_hash.lower(), "paused")
        async with httpx.AsyncClient(timeout=self.request_timeout) as client:
            await client.post(
                f"{self.base_url}/v1/torrents/{info_hash.lower()}/scope",
                json={"file_ids": []},
            )

    async def wait_for_files(self, info_hash: str) -> dict[str, Any]:
        deadline = asyncio.get_event_loop().time() + self.metadata_timeout
        last_error: Optional[Exception] = None
        while asyncio.get_event_loop().time() < deadline:
            try:
                st = await self.get_torrent(info_hash)
            except httpx.HTTPError as e:
                last_error = e
                await asyncio.sleep(2)
                continue
            if not st:
                await asyncio.sleep(2)
                continue
            files = extract_files(st)
            if files:
                return st
            await asyncio.sleep(2)
        st = await self.get_torrent(info_hash)
        files = extract_files(st)
        if files:
            return st
        if last_error:
            raise TimeoutError(str(last_error)) from last_error
        raise TimeoutError("Timed out waiting for torrent metadata")

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
        return (
            f"{self.base_url}/v1/torrents/{info_hash.lower()}/files/{file_index}/stream"
        )

    def delete_cache_dir(self, info_hash: str) -> None:
        path = Path(self.torrents_save_path) / info_hash.lower()
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
