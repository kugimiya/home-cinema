from __future__ import annotations

import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class ActivitySnapshot:
    label: str | None
    detail: str | None
    updated_at: float | None


class ActivityTracker:
    STALE_SEC = 30.0

    def __init__(self) -> None:
        self._label: str | None = None
        self._detail: str | None = None
        self._updated_at: float = 0.0
        self._depth = 0

    def snapshot(self) -> ActivitySnapshot:
        now = time.monotonic()
        if self._depth <= 0 or (now - self._updated_at) > self.STALE_SEC:
            return ActivitySnapshot(None, None, None)
        return ActivitySnapshot(self._label, self._detail, self._updated_at)

    @asynccontextmanager
    async def track(self, label: str, detail: str | None = None) -> AsyncIterator[None]:
        self._depth += 1
        self._label = label
        self._detail = detail
        self._updated_at = time.monotonic()
        try:
            yield
        finally:
            self._depth -= 1
            if self._depth <= 0:
                self._depth = 0
                self._label = None
                self._detail = None
