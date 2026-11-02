from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import Any, Optional

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


def file_download_priority(file_index: int, active_file_indices: set[int]) -> int:
    if file_index in active_file_indices:
        return PRIORITY_STREAM
    if active_file_indices:
        return PRIORITY_BACKGROUND
    return PRIORITY_OFF


def extract_files(status: dict[str, Any]) -> list[dict[str, Any]]:
    if not status:
        return []
    raw = status.get("file_stats")
    if isinstance(raw, list) and raw:
        return raw
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
