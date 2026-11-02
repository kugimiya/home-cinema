from __future__ import annotations

import os
from pathlib import Path

import shutil

_SKIP_DIR_NAMES = frozenset({".engine"})


def torrent_hash_dir_size(base: Path, info_hash: str) -> int:
    path = base / info_hash.lower()
    if not path.is_dir():
        return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return total


def torrent_on_disk_bytes(
    base: Path,
    info_hash: str,
    file_paths: list[str],
    *,
    loaded_size: int | None = None,
) -> int:
    """Bytes on disk for a torrent (libtorrent uses save_path/name, not hash subdirs)."""
    hash_dir = torrent_hash_dir_size(base, info_hash)
    if hash_dir > 0:
        return hash_dir

    from app.media_paths import find_torrent_media_file

    total = 0
    seen: set[str] = set()
    for rel in file_paths:
        if not rel.strip():
            continue
        found = find_torrent_media_file(base, rel)
        if found is None:
            continue
        key = str(found.resolve())
        if key in seen:
            continue
        seen.add(key)
        try:
            total += found.stat().st_size
        except OSError:
            continue
    if total > 0:
        return total
    if loaded_size and loaded_size > 0:
        return loaded_size
    return 0


def torrents_data_bytes(base: Path) -> int:
    if not base.is_dir():
        return 0
    total = 0
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIR_NAMES and not d.startswith(".")]
        for name in files:
            if name.startswith("."):
                continue
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return total


def storage_summary(torrents_path: str) -> dict[str, int]:
    base = Path(torrents_path)
    base.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(base)
    data_bytes = torrents_data_bytes(base)
    return {
        "disk_total_bytes": usage.total,
        "disk_free_bytes": usage.free,
        "disk_used_bytes": usage.used,
        "torrents_data_bytes": data_bytes,
    }
