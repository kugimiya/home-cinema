from __future__ import annotations

import logging
from pathlib import Path

import httpx

from app.clients.torrserver import TorrServerClient

logger = logging.getLogger(__name__)


def head_cache_path(base_dir: Path, info_hash: str, file_id: int) -> Path:
    h = info_hash.lower()
    return base_dir / h[:16] / str(file_id) / "head.bin"


async def download_head_range(
    torr: TorrServerClient,
    info_hash: str,
    file_path: str,
    file_index: int,
    target_bytes: int,
    dest: Path,
) -> int:
    """Fetch bytes [0, target) from TorrServer stream into dest. Returns bytes written."""
    if target_bytes <= 0:
        return 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = torr.build_internal_stream_url(info_hash, file_path, file_index)
    end = max(0, target_bytes - 1)
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
            with dest.open("wb") as out:
                async for chunk in resp.aiter_bytes():
                    if not chunk:
                        continue
                    out.write(chunk)
                    total += len(chunk)
                    if total >= target_bytes:
                        break
    return total


async def ensure_head_file(
    torr: TorrServerClient,
    base_dir: Path,
    info_hash: str,
    file_path: str,
    file_index: int,
    file_length: int,
    target_bytes: int,
) -> tuple[Path | None, int]:
    if target_bytes <= 0:
        return None, 0
    path = head_cache_path(base_dir, info_hash, file_index)
    if path.is_file():
        size = path.stat().st_size
        if size >= min(target_bytes, file_length or target_bytes):
            return path, size
    try:
        written = await download_head_range(
            torr, info_hash, file_path, file_index, target_bytes, path
        )
    except Exception as e:
        logger.warning("head download failed %s/%s: %s", info_hash[:8], file_index, e)
        if path.is_file():
            return path, path.stat().st_size
        return None, 0
    return path, written


def remove_hash_heads(base_dir: Path, info_hash: str) -> None:
    h = info_hash.lower()
    folder = base_dir / h[:16]
    if folder.is_dir():
        import shutil

        shutil.rmtree(folder, ignore_errors=True)
