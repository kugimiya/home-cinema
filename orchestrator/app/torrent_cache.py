from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from app.torrent_fetch import fetch_torrent_bytes
from app.torrent_files import extract_files, info_hash_from_magnet

Scope = Literal["list", "cache", "files"]


class TorrentEngineClientProtocol(Protocol):
    async def list_torrents(self) -> list[dict[str, Any]]: ...
    async def get_torrent(self, info_hash: str) -> dict[str, Any]: ...
    async def get_cache(self, info_hash: str) -> dict[str, Any]: ...
    async def add_torrent(
        self, link: str, title: str, save_to_db: bool = True
    ) -> dict[str, Any]: ...
    async def add_torrent_bytes(
        self,
        data: bytes,
        title: str,
        *,
        magnet: str = "",
        save_to_db: bool = True,
    ) -> dict[str, Any]: ...


@dataclass
class ListSnapshot:
    items_by_hash: dict[str, dict[str, Any]]
    fetched_at: float


@dataclass
class HashEntry:
    list_item: dict[str, Any] | None = None
    cache_pieces: dict[str, Any] | None = None
    files_raw: list[dict[str, Any]] | None = None
    list_updated_at: float = 0.0
    cache_updated_at: float = 0.0
    files_updated_at: float = 0.0


class TorrentStateCache:
    LIST_TTL_HOT = 3.0
    LIST_TTL_LIBRARY = 8.0
    CACHE_TTL_ACTIVE = 4.0
    CACHE_TTL_IDLE = 45.0

    def __init__(self, client: TorrentEngineClientProtocol) -> None:
        self._client = client
        self._lock = asyncio.Lock()
        self._snapshot: ListSnapshot | None = None
        self._entries: dict[str, HashEntry] = {}
        self._list_task: asyncio.Task[dict[str, dict[str, Any]]] | None = None
        self._cache_tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self._get_tasks: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self.list_fetch_in_progress = False

    def snapshot_age_sec(self) -> float | None:
        if not self._snapshot:
            return None
        return time.monotonic() - self._snapshot.fetched_at

    def invalidate_list(self) -> None:
        self._snapshot = None

    def invalidate_hash(self, info_hash: str, scopes: list[Scope] | None = None) -> None:
        h = info_hash.lower()
        if scopes is None or "list" in scopes:
            entry = self._entries.get(h)
            if entry:
                entry.list_item = None
                entry.list_updated_at = 0.0
        if scopes is None or "cache" in scopes:
            entry = self._entries.setdefault(h, HashEntry())
            entry.cache_pieces = None
            entry.cache_updated_at = 0.0
        if scopes is None or "files" in scopes:
            entry = self._entries.setdefault(h, HashEntry())
            entry.files_raw = None
            entry.files_updated_at = 0.0
        if scopes is None:
            self._entries.pop(h, None)

    def remove_hash(self, info_hash: str) -> None:
        h = info_hash.lower()
        self._entries.pop(h, None)
        if self._snapshot:
            self._snapshot.items_by_hash.pop(h, None)

    async def list_snapshot(
        self,
        *,
        max_age: float | None = None,
        force: bool = False,
    ) -> dict[str, dict[str, Any]]:
        ttl = max_age if max_age is not None else self.LIST_TTL_LIBRARY
        now = time.monotonic()
        if not force and self._snapshot and (now - self._snapshot.fetched_at) <= ttl:
            return self._snapshot.items_by_hash

        async with self._lock:
            now = time.monotonic()
            if not force and self._snapshot and (now - self._snapshot.fetched_at) <= ttl:
                return self._snapshot.items_by_hash
            if self._list_task is not None:
                task = self._list_task
            else:
                self.list_fetch_in_progress = True
                task = asyncio.create_task(self._load_list())
                self._list_task = task

        try:
            return await task
        finally:
            async with self._lock:
                if self._list_task is task and task.done():
                    self._list_task = None
                    self.list_fetch_in_progress = False

    async def _load_list(self) -> dict[str, dict[str, Any]]:
        items = await self._client.list_torrents()
        by_hash: dict[str, dict[str, Any]] = {}
        now = time.monotonic()
        for item in items:
            h = (item.get("hash") or "").lower()
            if not h:
                continue
            by_hash[h] = item
            entry = self._entries.setdefault(h, HashEntry())
            entry.list_item = item
            entry.list_updated_at = now
            raw = extract_files(item)
            if raw:
                entry.files_raw = raw
                entry.files_updated_at = now
        self._snapshot = ListSnapshot(items_by_hash=by_hash, fetched_at=now)
        return by_hash

    async def find_list_item(self, info_hash: str, *, max_age: float | None = None) -> dict[str, Any]:
        h = info_hash.lower()
        snapshot = await self.list_snapshot(max_age=max_age)
        return dict(snapshot.get(h) or {})

    async def get_torrent_detail(
        self,
        info_hash: str,
        *,
        max_age_list: float | None = None,
    ) -> dict[str, Any]:
        h = info_hash.lower()
        listed = await self.find_list_item(h, max_age=max_age_list or self.LIST_TTL_HOT)
        if listed and extract_files(listed):
            return listed

        entry = self._entries.get(h)
        if entry and entry.files_raw:
            base = dict(listed) if listed else {}
            if not extract_files(base) and entry.list_item:
                base = dict(entry.list_item)
            return base

        detail = await self._get_torrent_coalesced(h)
        if detail:
            now = time.monotonic()
            entry = self._entries.setdefault(h, HashEntry())
            entry.list_item = detail
            entry.list_updated_at = now
            raw = extract_files(detail)
            if raw:
                entry.files_raw = raw
                entry.files_updated_at = now
            return detail
        if listed and not extract_files(listed):
            self.invalidate_hash(h)
            self.invalidate_list()
            return {}
        return listed

    async def _get_torrent_coalesced(self, info_hash: str) -> dict[str, Any]:
        h = info_hash.lower()
        async with self._lock:
            if h in self._get_tasks:
                task = self._get_tasks[h]
            else:
                task = asyncio.create_task(self._client.get_torrent(h))
                self._get_tasks[h] = task

        try:
            return await task
        finally:
            async with self._lock:
                if self._get_tasks.get(h) is task and task.done():
                    self._get_tasks.pop(h, None)

    def _cache_ttl_for_item(self, list_item: dict[str, Any]) -> float:
        if list_item.get("stat") == 5:
            return 0.0
        speed = list_item.get("download_speed") or 0
        try:
            if float(speed) > 0:
                return self.CACHE_TTL_ACTIVE
        except (TypeError, ValueError):
            pass
        return self.CACHE_TTL_IDLE

    async def get_cache_pieces(
        self,
        info_hash: str,
        *,
        list_item: dict[str, Any] | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        h = info_hash.lower()
        if list_item is None:
            list_item = await self.find_list_item(h)
        if list_item.get("stat") == 5:
            return {}

        ttl = self._cache_ttl_for_item(list_item)
        if ttl <= 0:
            return {}

        now = time.monotonic()
        entry = self._entries.setdefault(h, HashEntry())
        if (
            not force
            and entry.cache_pieces is not None
            and (now - entry.cache_updated_at) <= ttl
        ):
            return entry.cache_pieces

        async with self._lock:
            if h in self._cache_tasks:
                task = self._cache_tasks[h]
            else:
                task = asyncio.create_task(self._fetch_cache(h))
                self._cache_tasks[h] = task

        try:
            data = await task
        finally:
            async with self._lock:
                if self._cache_tasks.get(h) is task and task.done():
                    self._cache_tasks.pop(h, None)

        entry.cache_pieces = data
        entry.cache_updated_at = time.monotonic()
        return data

    async def _fetch_cache(self, info_hash: str) -> dict[str, Any]:
        try:
            data = await asyncio.wait_for(
                self._client.get_cache(info_hash),
                timeout=12.0,
            )
        except (asyncio.TimeoutError, Exception):
            data = {}
        return data if isinstance(data, dict) else {}

    async def list_items(self, *, max_age: float | None = None, force: bool = False) -> list[dict[str, Any]]:
        snapshot = await self.list_snapshot(max_age=max_age, force=force)
        return list(snapshot.values())

    async def ensure_torrent_lookup(self, info_hash: str) -> dict[str, Any]:
        return await self.find_list_item(info_hash, max_age=self.LIST_TTL_LIBRARY)

    async def ensure_torrent(
        self,
        link: str,
        title: str,
        save_to_db: bool = True,
        torrent_url: str | None = None,
    ) -> dict[str, Any]:
        info_hash = info_hash_from_magnet(link)
        existing: dict[str, Any] = {}
        if info_hash:
            try:
                existing = await self.ensure_torrent_lookup(info_hash)
            except Exception:
                existing = {}
            if existing and extract_files(existing):
                merged = dict(existing)
                merged.setdefault("hash", info_hash)
                return merged

        async def _add_from_url() -> dict[str, Any] | None:
            if not torrent_url:
                return None
            data = await fetch_torrent_bytes(
                torrent_url,
                timeout=min(45.0, self._client.request_timeout),
            )
            if not data:
                return None
            added = await self._client.add_torrent_bytes(
                data,
                title,
                magnet=link,
                save_to_db=save_to_db,
            )
            self.invalidate_list()
            h = (added.get("hash") or info_hash or "").lower()
            if h:
                self.invalidate_hash(h, ["list", "cache", "files"])
            if not added.get("hash") and info_hash:
                added["hash"] = info_hash
            return added

        if existing and not extract_files(existing):
            upgraded = await _add_from_url()
            if upgraded:
                return upgraded
            merged = dict(existing)
            merged.setdefault("hash", info_hash)
            return merged

        upgraded = await _add_from_url()
        if upgraded:
            return upgraded

        added = await self._client.add_torrent(link, title, save_to_db=save_to_db)
        self.invalidate_list()
        h = (added.get("hash") or info_hash or "").lower()
        if h:
            self.invalidate_hash(h, ["list", "cache", "files"])
        if not added.get("hash") and info_hash:
            added["hash"] = info_hash
        return added
