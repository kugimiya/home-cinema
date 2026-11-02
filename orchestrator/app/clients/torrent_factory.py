from __future__ import annotations

from app.clients.torrent_engine import TorrentEngineClient
from app.config import Settings


def build_torrent_engine_client(settings: Settings) -> TorrentEngineClient:
    return TorrentEngineClient(
        settings.torrent_engine_url,
        public_base_url=settings.torrent_engine_public_url,
        torrents_save_path=settings.torrent_engine_save_path,
        metadata_timeout=settings.play_metadata_timeout,
        request_timeout=settings.torrent_engine_request_timeout,
        list_timeout=settings.torrent_engine_list_timeout,
        connections_limit=settings.torrent_engine_connections_limit,
        priority_concurrency=settings.torrent_engine_priority_concurrency,
    )
