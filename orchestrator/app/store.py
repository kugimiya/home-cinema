import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional

from app.upload_stats import accumulate_upload


@dataclass
class TorrentMeta:
    info_hash: str
    title: str
    provider: Optional[str] = None
    external_id: Optional[str] = None
    search_query: Optional[str] = None
    quality: Optional[str] = None
    voice: Optional[str] = None


class MetaStore:
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
                CREATE TABLE IF NOT EXISTS torrent_meta (
                    info_hash TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    provider TEXT,
                    external_id TEXT,
                    search_query TEXT,
                    quality TEXT,
                    voice TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS torrent_upload (
                    info_hash TEXT PRIMARY KEY,
                    lifetime_bytes INTEGER NOT NULL DEFAULT 0,
                    last_reported_bytes INTEGER NOT NULL DEFAULT 0
                )
                """
            )

    def sync_upload_lifetime(self, info_hash: str, reported_bytes: int) -> int:
        h = info_hash.lower()
        with self._conn() as conn:
            row = conn.execute(
                "SELECT lifetime_bytes, last_reported_bytes FROM torrent_upload WHERE info_hash = ?",
                (h,),
            ).fetchone()
            if row:
                lifetime, last = accumulate_upload(
                    int(row["lifetime_bytes"]),
                    int(row["last_reported_bytes"]),
                    reported_bytes,
                )
                conn.execute(
                    """
                    UPDATE torrent_upload
                    SET lifetime_bytes = ?, last_reported_bytes = ?
                    WHERE info_hash = ?
                    """,
                    (lifetime, last, h),
                )
                return lifetime
            lifetime, last = accumulate_upload(0, 0, reported_bytes)
            conn.execute(
                """
                INSERT INTO torrent_upload (info_hash, lifetime_bytes, last_reported_bytes)
                VALUES (?, ?, ?)
                """,
                (h, lifetime, last),
            )
            return lifetime

    def upsert(self, meta: TorrentMeta) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT INTO torrent_meta (
                    info_hash, title, provider, external_id, search_query, quality, voice
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(info_hash) DO UPDATE SET
                    title=excluded.title,
                    provider=COALESCE(excluded.provider, torrent_meta.provider),
                    external_id=COALESCE(excluded.external_id, torrent_meta.external_id),
                    search_query=COALESCE(excluded.search_query, torrent_meta.search_query),
                    quality=COALESCE(excluded.quality, torrent_meta.quality),
                    voice=COALESCE(excluded.voice, torrent_meta.voice)
                """,
                (
                    meta.info_hash.lower(),
                    meta.title,
                    meta.provider,
                    meta.external_id,
                    meta.search_query,
                    meta.quality,
                    meta.voice,
                ),
            )

    def get(self, info_hash: str) -> Optional[TorrentMeta]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT * FROM torrent_meta WHERE info_hash = ?",
                (info_hash.lower(),),
            ).fetchone()
        if not row:
            return None
        return TorrentMeta(
            info_hash=row["info_hash"],
            title=row["title"],
            provider=row["provider"],
            external_id=row["external_id"],
            search_query=row["search_query"],
            quality=row["quality"],
            voice=row["voice"],
        )

    def delete(self, info_hash: str) -> None:
        h = info_hash.lower()
        with self._conn() as conn:
            conn.execute("DELETE FROM torrent_meta WHERE info_hash = ?", (h,))
            conn.execute("DELETE FROM torrent_upload WHERE info_hash = ?", (h,))
