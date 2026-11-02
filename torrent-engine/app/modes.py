from __future__ import annotations

from enum import Enum

PRIORITY_OFF = 0
PRIORITY_BACKGROUND = 1
PRIORITY_STREAM = 7


class TorrentMode(str, Enum):
    streaming = "streaming"
    completing = "completing"
    seeding = "seeding"
    paused = "paused"


def file_download_priority(file_index: int, active_file_indices: set[int]) -> int:
    if file_index in active_file_indices:
        return PRIORITY_STREAM
    if active_file_indices:
        return PRIORITY_BACKGROUND
    return PRIORITY_OFF


def apply_mode_to_scope(mode: TorrentMode, scope_file_ids: set[int]) -> set[int]:
    """Effective active set for priority mapping."""
    if mode == TorrentMode.paused:
        return set()
    if mode in (TorrentMode.streaming, TorrentMode.completing):
        return set(scope_file_ids)
    if mode == TorrentMode.seeding:
        return set()
    return set()
