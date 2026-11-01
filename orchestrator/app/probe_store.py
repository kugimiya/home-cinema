from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from app.models import AudioTrackInfo
from app.playback_probe import ProbeResult


def default_warm_head_bytes(
    file_path: str,
    file_length: int,
    *,
    fallback: int,
) -> int:
    ext = Path(file_path).suffix.lower()
    base = fallback
    if ext in (".mp4", ".m4v", ".mov"):
        base = max(base, 8 * 1024 * 1024)
    if file_length > 0:
        return min(base, file_length)
    return base


class ProbeCacheStore:
    def __init__(self, db_path: str) -> None:
        self._path = Path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self._path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS file_probe_cache (
                    info_hash TEXT NOT NULL,
                    file_id INTEGER NOT NULL,
                    file_path TEXT NOT NULL,
                    file_length INTEGER NOT NULL DEFAULT 0,
                    playback_mode TEXT NOT NULL,
                    direct_playable INTEGER NOT NULL,
                    video_copy INTEGER NOT NULL,
                    audio_copy INTEGER NOT NULL,
                    duration_sec REAL,
                    audio_tracks_json TEXT NOT NULL,
                    warm_head_bytes INTEGER NOT NULL,
                    needs_stream_tail INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (info_hash, file_id)
                )
                """
            )

    def get_warm_head_bytes(self, info_hash: str, file_id: int) -> Optional[int]:
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT warm_head_bytes FROM file_probe_cache
                WHERE info_hash = ? AND file_id = ?
                """,
                (info_hash.lower(), file_id),
            ).fetchone()
        if not row:
            return None
        return int(row["warm_head_bytes"])

    def get_cached_probe(
        self,
        info_hash: str,
        file_id: int,
        file_path: str,
        file_length: int,
    ) -> Optional[ProbeResult]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM file_probe_cache WHERE info_hash = ? AND file_id = ?",
                (info_hash.lower(), file_id),
            ).fetchone()
        if not row:
            return None
        if row["file_path"] != file_path:
            return None
        if file_length > 0 and int(row["file_length"]) != file_length:
            return None
        tracks_raw = json.loads(row["audio_tracks_json"] or "[]")
        tracks = [AudioTrackInfo.model_validate(t) for t in tracks_raw]
        return ProbeResult(
            status="ok",
            playback_mode=row["playback_mode"],  # type: ignore[arg-type]
            direct_playable=bool(row["direct_playable"]),
            audio_tracks=tracks,
            video_copy=bool(row["video_copy"]),
            audio_copy=bool(row["audio_copy"]),
            duration_sec=row["duration_sec"],
        )

    def save_probe(
        self,
        info_hash: str,
        file_id: int,
        file_path: str,
        file_length: int,
        result: ProbeResult,
        *,
        warm_head_bytes: int,
        needs_stream_tail: bool = False,
    ) -> None:
        if result.status != "ok":
            return
        tracks_json = json.dumps([t.model_dump() for t in result.audio_tracks])
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO file_probe_cache (
                    info_hash, file_id, file_path, file_length,
                    playback_mode, direct_playable, video_copy, audio_copy,
                    duration_sec, audio_tracks_json, warm_head_bytes, needs_stream_tail
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(info_hash, file_id) DO UPDATE SET
                    file_path=excluded.file_path,
                    file_length=excluded.file_length,
                    playback_mode=excluded.playback_mode,
                    direct_playable=excluded.direct_playable,
                    video_copy=excluded.video_copy,
                    audio_copy=excluded.audio_copy,
                    duration_sec=CASE
                        WHEN excluded.duration_sec IS NULL THEN file_probe_cache.duration_sec
                        WHEN file_probe_cache.duration_sec IS NULL THEN excluded.duration_sec
                        ELSE MAX(excluded.duration_sec, file_probe_cache.duration_sec)
                    END,
                    audio_tracks_json=excluded.audio_tracks_json,
                    warm_head_bytes=excluded.warm_head_bytes,
                    needs_stream_tail=excluded.needs_stream_tail,
                    updated_at=CURRENT_TIMESTAMP
                """,
                (
                    info_hash.lower(),
                    file_id,
                    file_path,
                    file_length,
                    result.playback_mode,
                    int(result.direct_playable),
                    int(result.video_copy),
                    int(result.audio_copy),
                    result.duration_sec,
                    tracks_json,
                    max(0, warm_head_bytes),
                    int(needs_stream_tail),
                ),
            )

    def delete_hash(self, info_hash: str) -> None:
        with self._conn() as conn:
            conn.execute(
                "DELETE FROM file_probe_cache WHERE info_hash = ?",
                (info_hash.lower(),),
            )
