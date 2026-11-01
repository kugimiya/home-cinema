from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Optional

import httpx

from app.activity_tracker import ActivityTracker
from app.clients.torrserver import TorrServerClient
from app.file_progress import progress_from_cache
from app.media_files import media_kind_for_path
from app.probe_head import ensure_head_file
from app.models import MediaKind, TorrentFileStat, TorrentMediaFile

logger = logging.getLogger(__name__)

WarmStatus = Literal["off", "idle", "queued", "warming", "ready", "failed"]


@dataclass
class FileWarmState:
    status: WarmStatus = "idle"
    warmed_bytes: int = 0
    target_bytes: int = 0
    error: str | None = None
    path: str = ""
    updated_at: float = 0.0


@dataclass
class WarmQueueItem:
    info_hash: str
    file_id: int
    path: str
    length: int
    target_bytes: int


@dataclass
class WarmActivitySnapshot:
    active: bool
    detail: str | None
    queue_size: int


def select_auto_video_ids(
    catalog: list[TorrentMediaFile],
    current_file_id: int,
    limit: int,
) -> list[int]:
    """Next video file ids after current; limit -1 = all remaining."""
    if limit == 0:
        return []
    videos = sorted(
        [f for f in catalog if f.kind == MediaKind.video],
        key=lambda f: f.id,
    )
    ids = [f.id for f in videos]
    if current_file_id in ids:
        idx = ids.index(current_file_id)
        candidates = ids[idx + 1 :]
    else:
        candidates = ids
    if limit < 0:
        return candidates
    return candidates[:limit]


def select_manual_video_ids(
    raw_files: list[dict[str, Any]],
    limit: int,
    *,
    is_ready: Callable[[str, int, int, int], bool],
    info_hash: str,
) -> list[tuple[int, str, int]]:
    """Return (file_id, path, length) for videos not yet ready."""
    if limit == 0:
        return []
    videos: list[tuple[int, str, int]] = []
    for f in raw_files:
        path = f.get("path") or f.get("Path") or ""
        if media_kind_for_path(path) != MediaKind.video:
            continue
        fid = int(f.get("id") or f.get("Id") or 0)
        if fid <= 0:
            continue
        length = int(f.get("length") or f.get("Length") or 0)
        if is_ready(info_hash, fid, length, 0):
            continue
        videos.append((fid, path, length))
    videos.sort(key=lambda x: x[0])
    if limit < 0:
        return videos
    return videos[:limit]


def overlay_warm_on_stats(
    stats: list[TorrentFileStat],
    info_hash: str,
    manager: ProbeWarmManager,
) -> list[TorrentFileStat]:
    if not manager.enabled:
        return stats
    h = info_hash.lower()
    out: list[TorrentFileStat] = []
    for s in stats:
        st = manager.get_file_state(
            h, s.id, s.length, s.downloaded_bytes, s.completed, s.path
        )
        out.append(
            s.model_copy(
                update={
                    "warm_status": st.status,
                    "warm_bytes": st.warmed_bytes,
                    "warm_target_bytes": st.target_bytes,
                }
            )
        )
    return out


def warm_summary_for_hash(
    info_hash: str,
    manager: ProbeWarmManager,
    video_count: int,
) -> str | None:
    if not manager.enabled or video_count <= 0:
        return None
    snap = manager.hash_progress(info_hash)
    if snap["total"] <= 0 and snap["queue"] <= 0:
        return None
    done = snap["ready"]
    total = max(snap["total"], video_count)
    if snap["active"]:
        cur = snap.get("current_path") or "…"
        name = Path(cur).name
        return f"Прогрев ffprobe: {name} ({done}/{total})"
    if done >= total:
        return f"Прогрев ffprobe: готово ({done}/{total})"
    if snap["queue"] > 0 or done > 0:
        return f"Прогрев ffprobe: {done}/{total}"
    return None


class ProbeWarmManager:
    def __init__(
        self,
        torr: TorrServerClient,
        activity: ActivityTracker,
        *,
        warm_bytes: int,
        auto_files: int,
        manual_files: int,
        concurrency: int,
        fetch_cache: Callable[[str], Any],
        warm_target_fn: Callable[[str, int, str, int], int] | None = None,
        head_dir: Path | None = None,
    ) -> None:
        self._torr = torr
        self._activity = activity
        self.warm_bytes = max(0, warm_bytes)
        self._warm_target_fn = warm_target_fn
        self._head_dir = head_dir
        self.auto_files = auto_files
        self.manual_files = manual_files
        self.concurrency = max(1, min(8, concurrency))
        self._fetch_cache = fetch_cache
        self._lock = asyncio.Lock()
        self._queue: asyncio.Queue[WarmQueueItem | None] | None = None
        self._workers: list[asyncio.Task[None]] = []
        self._file_states: dict[tuple[str, int], FileWarmState] = {}
        self._cancelled_hashes: set[str] = set()
        self._active_detail: str | None = None
        self._warming_count = 0
        self._started = False

    @property
    def enabled(self) -> bool:
        return self.warm_bytes > 0

    def _resolve_target(
        self, info_hash: str, file_id: int, path: str, length: int
    ) -> int:
        if not self.enabled:
            return 0
        target = self.warm_bytes
        if self._warm_target_fn is not None:
            target = max(0, int(self._warm_target_fn(info_hash, file_id, path, length)))
        if target <= 0:
            return 0
        if length <= 0:
            return target
        return min(target, length)

    def _key(self, info_hash: str, file_id: int) -> tuple[str, int]:
        return (info_hash.lower(), file_id)

    def _get_state(self, info_hash: str, file_id: int) -> FileWarmState:
        k = self._key(info_hash, file_id)
        if k not in self._file_states:
            self._file_states[k] = FileWarmState(target_bytes=self.warm_bytes)
        return self._file_states[k]

    def get_file_state(
        self,
        info_hash: str,
        file_id: int,
        length: int,
        downloaded_bytes: int,
        completed: bool,
        path: str = "",
    ) -> FileWarmState:
        target = self._resolve_target(info_hash, file_id, path, length)
        if not self.enabled:
            return FileWarmState(status="off", target_bytes=0)
        st = self._get_state(info_hash, file_id)
        st.target_bytes = target
        effective = max(st.warmed_bytes, downloaded_bytes)
        if completed or effective >= target:
            st.status = "ready"
            st.warmed_bytes = max(st.warmed_bytes, min(effective, target if target else effective))
        elif st.status not in ("queued", "warming"):
            st.status = "idle"
        return st

    def is_file_ready(
        self,
        info_hash: str,
        file_id: int,
        length: int,
        downloaded_bytes: int,
    ) -> bool:
        target = self._resolve_target(info_hash, file_id, "", length)
        if target <= 0:
            return True
        st = self._get_state(info_hash, file_id)
        if st.status == "ready":
            return True
        effective = max(st.warmed_bytes, downloaded_bytes)
        return effective >= target

    async def ensure_started(self) -> None:
        if not self.enabled or self._started:
            return
        async with self._lock:
            if self._started or not self.enabled:
                return
            self._queue = asyncio.Queue()
            for _ in range(self.concurrency):
                self._workers.append(asyncio.create_task(self._worker_loop()))
            self._started = True

    async def schedule_auto(
        self,
        info_hash: str,
        catalog: list[TorrentMediaFile],
        current_file_id: int,
    ) -> int:
        if not self.enabled or self.auto_files == 0:
            return 0
        ids = select_auto_video_ids(catalog, current_file_id, self.auto_files)
        return await self._enqueue_ids(info_hash, catalog, ids)

    async def schedule_manual(self, info_hash: str, raw_files: list[dict[str, Any]]) -> tuple[int, int]:
        if not self.enabled:
            return 0, 0
        h = info_hash.lower()
        self._cancelled_hashes.discard(h)

        cache: dict[str, Any] = {}
        try:
            cache = await self._fetch_cache(h)
        except Exception:
            cache = {}
        progress = progress_from_cache(raw_files, cache if isinstance(cache, dict) else {})

        def is_ready(hash_: str, fid: int, length: int, _: int) -> bool:
            prog = progress.get(fid, {})
            downloaded = int(prog.get("downloaded") or 0)
            completed = length > 0 and downloaded >= length * 0.995
            return self.is_file_ready(hash_, fid, length, downloaded)

        items = select_manual_video_ids(
            raw_files,
            self.manual_files,
            is_ready=is_ready,
            info_hash=h,
        )
        skipped = sum(
            1
            for f in raw_files
            if media_kind_for_path(f.get("path") or f.get("Path") or "") == MediaKind.video
        ) - len(items)
        queued = 0
        await self.ensure_started()
        assert self._queue is not None
        for fid, path, length in items:
            if await self._enqueue_one(h, fid, path, length):
                queued += 1
        return queued, max(0, skipped)

    async def _enqueue_ids(
        self,
        info_hash: str,
        catalog: list[TorrentMediaFile],
        file_ids: list[int],
    ) -> int:
        if not file_ids:
            return 0
        h = info_hash.lower()
        self._cancelled_hashes.discard(h)
        by_id = {f.id: f for f in catalog}
        queued = 0
        await self.ensure_started()
        for fid in file_ids:
            f = by_id.get(fid)
            if not f:
                continue
            if await self._enqueue_one(h, f.id, f.path, f.length):
                queued += 1
        return queued

    async def _enqueue_one(
        self,
        info_hash: str,
        file_id: int,
        path: str,
        length: int,
    ) -> bool:
        if info_hash in self._cancelled_hashes:
            return False
        st = self._get_state(info_hash, file_id)
        target = self._resolve_target(info_hash, file_id, path, length)
        st.target_bytes = target
        st.path = path
        if target <= 0:
            return False
        if st.status in ("ready", "warming", "queued"):
            return False
        st.status = "queued"
        st.updated_at = time.monotonic()
        assert self._queue is not None
        await self._queue.put(
            WarmQueueItem(
                info_hash=info_hash,
                file_id=file_id,
                path=path,
                length=length,
                target_bytes=target,
            )
        )
        return True

    def cancel_hash(self, info_hash: str) -> None:
        h = info_hash.lower()
        self._cancelled_hashes.add(h)
        for (hash_, fid), st in list(self._file_states.items()):
            if hash_ == h and st.status in ("queued", "warming"):
                st.status = "idle"
                st.error = None

    def activity_snapshot(self) -> WarmActivitySnapshot:
        if not self.enabled:
            return WarmActivitySnapshot(active=False, detail=None, queue_size=0)
        qsize = self._queue.qsize() if self._queue else 0
        active = self._warming_count > 0 or qsize > 0
        detail = self._active_detail
        if not detail and qsize > 0:
            detail = f"очередь {qsize}"
        return WarmActivitySnapshot(active=active, detail=detail, queue_size=qsize)

    def hash_progress(self, info_hash: str) -> dict[str, Any]:
        h = info_hash.lower()
        ready = warming = queued = 0
        current_path: str | None = None
        for (hash_, _), st in self._file_states.items():
            if hash_ != h:
                continue
            if st.status == "ready":
                ready += 1
            elif st.status == "warming":
                warming += 1
                current_path = st.path
            elif st.status == "queued":
                queued += 1
        total = ready + warming + queued
        return {
            "ready": ready,
            "warming": warming,
            "queue": queued,
            "total": total,
            "active": warming > 0,
            "current_path": current_path,
        }

    def status_payload(self, info_hash: str) -> dict[str, Any]:
        h = info_hash.lower()
        prog = self.hash_progress(h)
        files: list[dict[str, Any]] = []
        for (hash_, fid), st in sorted(self._file_states.items(), key=lambda x: x[0][1]):
            if hash_ != h:
                continue
            files.append(
                {
                    "id": fid,
                    "path": st.path,
                    "status": st.status,
                    "warmed_bytes": st.warmed_bytes,
                    "target_bytes": st.target_bytes,
                    "error": st.error,
                }
            )
        return {
            "enabled": self.enabled,
            "active": prog["active"] or prog["queue"] > 0,
            "current_path": prog.get("current_path"),
            "done": prog["ready"],
            "total": prog["total"],
            "files": files,
        }

    async def _worker_loop(self) -> None:
        assert self._queue is not None
        while True:
            item = await self._queue.get()
            try:
                if item is None:
                    return
                if item.info_hash in self._cancelled_hashes:
                    continue
                await self._process_item(item)
            finally:
                self._queue.task_done()

    async def _process_item(self, item: WarmQueueItem) -> None:
        h = item.info_hash.lower()
        if h in self._cancelled_hashes:
            return
        st = self._get_state(h, item.file_id)
        target = item.target_bytes or self._resolve_target(
            h, item.file_id, item.path, item.length
        )
        st.target_bytes = target
        st.path = item.path

        try:
            cache = await self._fetch_cache(h)
        except Exception:
            cache = {}
        progress = progress_from_cache(
            [{"id": item.file_id, "length": item.length, "path": item.path}],
            cache if isinstance(cache, dict) else {},
        )
        prog = progress.get(item.file_id, {})
        downloaded = int(prog.get("downloaded") or 0)
        if self.is_file_ready(h, item.file_id, item.length, downloaded):
            st.status = "ready"
            st.warmed_bytes = max(st.warmed_bytes, min(downloaded, target))
            return

        st.status = "warming"
        st.updated_at = time.monotonic()
        name = Path(item.path).name
        prog_snap = self.hash_progress(h)
        done = prog_snap["ready"] + 1
        total = max(prog_snap["total"], 1)
        detail = f"{h[:8]} · {name} ({done}/{total})"
        self._warming_count += 1
        self._active_detail = detail

        try:
            async with self._activity.track("warm_probe", detail):
                if self._head_dir is not None:
                    _path, warmed = await ensure_head_file(
                        self._torr,
                        self._head_dir,
                        h,
                        item.path,
                        item.file_id,
                        item.length,
                        target,
                    )
                else:
                    warmed = await self._warm_file_http(
                        h, item.path, item.file_id, target
                    )
            st.warmed_bytes = warmed
            if warmed >= target or (item.length > 0 and warmed >= item.length):
                st.status = "ready"
                st.error = None
            else:
                st.status = "failed"
                st.error = f"получено {warmed} из {target} байт"
        except Exception as e:
            st.status = "failed"
            st.error = str(e)[:120]
            logger.warning("warm failed %s file %s: %s", h[:8], item.file_id, e)
        finally:
            self._warming_count = max(0, self._warming_count - 1)
            if self._warming_count <= 0:
                self._active_detail = None
            st.updated_at = time.monotonic()

    async def _warm_file_http(
        self,
        info_hash: str,
        path: str,
        file_index: int,
        target: int,
    ) -> int:
        url = self._torr.build_internal_stream_url(info_hash, path, file_index)
        end = max(0, target - 1)
        headers = {"Range": f"bytes=0-{end}"}
        timeout = httpx.Timeout(120.0, connect=15.0)
        total = 0
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code not in (200, 206):
                    body = await resp.aread()
                    raise RuntimeError(
                        f"HTTP {resp.status_code}: {(body[:200]).decode(errors='replace')}"
                    )
                async for chunk in resp.aiter_bytes():
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total >= target:
                        break
        return total
