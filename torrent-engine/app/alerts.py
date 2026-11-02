from __future__ import annotations

import time
from collections import deque
from typing import Any

from app.hash_util import sha1_to_hex


def serialize_alert(alert: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": type(alert).__name__,
        "at": time.time(),
    }
    if hasattr(alert, "message"):
        try:
            out["message"] = alert.message()
        except Exception:
            out["message"] = str(alert)
    else:
        out["message"] = str(alert)
    if hasattr(alert, "category"):
        try:
            out["category"] = int(alert.category())
        except Exception:
            pass
    if hasattr(alert, "handle"):
        try:
            handle = alert.handle()
            if handle.is_valid():
                out["info_hash"] = sha1_to_hex(handle.info_hash())
        except Exception:
            pass
    if hasattr(alert, "error"):
        try:
            err = alert.error()
            if err:
                out["error"] = str(err)
        except Exception:
            pass
    return out


class AlertRing:
    def __init__(self, capacity: int = 300) -> None:
        self._capacity = max(10, capacity)
        self._items: deque[dict[str, Any]] = deque(maxlen=self._capacity)

    def extend(self, alerts: list[dict[str, Any]]) -> None:
        for item in alerts:
            self._items.append(item)

    def list_recent(self, limit: int = 100) -> list[dict[str, Any]]:
        lim = max(1, min(limit, self._capacity))
        if lim >= len(self._items):
            return list(self._items)
        return list(self._items)[-lim:]

    def size(self) -> int:
        return len(self._items)
