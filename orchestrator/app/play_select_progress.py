from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

PlaySelectPhase = Literal["torrent", "priority", "probe", "transcode", "done"]


@dataclass
class PlaySelectStatus:
    hash: str
    step: int
    step_total: int
    phase: PlaySelectPhase
    message: str
    probe_attempt: int = 0
    probe_max: int = 0
    probe_bytes_downloaded: int = 0
    probe_bytes_target: int = 0
    probe_download_speed: float | None = None
    probe_total_peers: int | None = None
    probe_subphase: str = ""
    probe_elapsed_sec: int = 0
    updated_at: float = 0.0


class PlaySelectProgressStore:
    STALE_SEC = 180.0

    def __init__(self) -> None:
        self._by_hash: dict[str, PlaySelectStatus] = {}

    def set(
        self,
        info_hash: str,
        *,
        step: int,
        step_total: int,
        phase: PlaySelectPhase,
        message: str,
        probe_attempt: int = 0,
        probe_max: int = 0,
        probe_bytes_downloaded: int = 0,
        probe_bytes_target: int = 0,
        probe_download_speed: float | None = None,
        probe_total_peers: int | None = None,
        probe_subphase: str = "",
        probe_elapsed_sec: int = 0,
    ) -> None:
        h = info_hash.lower()
        self._by_hash[h] = PlaySelectStatus(
            hash=h,
            step=step,
            step_total=step_total,
            phase=phase,
            message=message,
            probe_attempt=probe_attempt,
            probe_max=probe_max,
            probe_bytes_downloaded=probe_bytes_downloaded,
            probe_bytes_target=probe_bytes_target,
            probe_download_speed=probe_download_speed,
            probe_total_peers=probe_total_peers,
            probe_subphase=probe_subphase,
            probe_elapsed_sec=probe_elapsed_sec,
            updated_at=time.monotonic(),
        )

    def get(self, info_hash: str) -> PlaySelectStatus | None:
        h = info_hash.lower()
        st = self._by_hash.get(h)
        if not st:
            return None
        if (time.monotonic() - st.updated_at) > self.STALE_SEC:
            self._by_hash.pop(h, None)
            return None
        return st

    def clear(self, info_hash: str) -> None:
        self._by_hash.pop(info_hash.lower(), None)
