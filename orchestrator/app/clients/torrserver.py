from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)


class TorrServerClient:
    def __init__(
        self,
        base_url: str,
        public_base_url: str,
        torrents_save_path: str,
        metadata_timeout: float,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.public_base_url = public_base_url.rstrip("/")
        self.torrents_save_path = torrents_save_path
        self.metadata_timeout = metadata_timeout

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
        await self.set_settings(merged)
        logger.info(
            "TorrServer disk settings applied: UseDisk=%s path=%s",
            merged.get("UseDisk"),
            merged.get("TorrentsSavePath"),
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
        async with httpx.AsyncClient(timeout=60.0) as client:
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

    async def get_torrent(self, info_hash: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{self.base_url}/torrents",
                json={"action": "get", "hash": info_hash.lower()},
            )
            if r.status_code == 404:
                return {}
            r.raise_for_status()
            return r.json()

    async def list_torrents(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{self.base_url}/torrents",
                json={"action": "list"},
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                return data
            return []

    async def drop_torrent(self, info_hash: str) -> None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{self.base_url}/torrents",
                json={"action": "drop", "hash": info_hash.lower()},
            )
            r.raise_for_status()

    async def wait_for_files(self, info_hash: str) -> dict[str, Any]:
        deadline = asyncio.get_event_loop().time() + self.metadata_timeout
        while asyncio.get_event_loop().time() < deadline:
            st = await self.get_torrent(info_hash)
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
        st = await self.get_torrent(info_hash)
        files = _extract_files(st)
        if files:
            return st
        raise TimeoutError("Timed out waiting for torrent metadata from TorrServer")

    def build_stream_url(self, info_hash: str, file_path: str, file_index: int) -> str:
        encoded = quote(file_path, safe="")
        return (
            f"{self.public_base_url}/stream/{encoded}"
            f"?link={info_hash.lower()}&index={file_index}&play"
        )

    def delete_cache_dir(self, info_hash: str) -> None:
        path = Path(self.torrents_save_path) / info_hash.lower()
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)


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
