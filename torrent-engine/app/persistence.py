from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class TorrentIndex:
    """Persist torrent metadata for restart (phase 2). MVP: save on add, load on startup."""

    def __init__(self, save_path: str) -> None:
        self._dir = Path(save_path) / ".engine"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = self._dir / "torrents.json"
        self._data: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.is_file():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                self._data = raw
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("Could not load torrent index: %s", e)

    def _save(self) -> None:
        try:
            self._path.write_text(
                json.dumps(self._data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as e:
            logger.warning("Could not save torrent index: %s", e)

    def remember(self, info_hash: str, *, link: str, title: str) -> None:
        h = str(info_hash).lower()
        self._data[h] = {"link": link, "title": title}
        self._save()

    def remove(self, info_hash: str) -> None:
        h = info_hash.lower()
        if h in self._data:
            del self._data[h]
            self._save()

    def all_entries(self) -> list[tuple[str, str, str]]:
        out: list[tuple[str, str, str]] = []
        for h, meta in self._data.items():
            out.append((h, meta.get("link") or "", meta.get("title") or h))
        return out
