from __future__ import annotations

import os
from pathlib import Path

import shutil


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


def torrents_data_bytes(base: Path) -> int:
    if not base.is_dir():
        return 0
    total = 0
    for entry in base.iterdir():
        if entry.is_dir():
            total += torrent_hash_dir_size(base, entry.name)
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
