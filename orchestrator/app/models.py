from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class Provider(str, Enum):
    rutracker = "rutracker"
    kinozal = "kinozal"
    rutor = "rutor"
    nonameclub = "nonameclub"
    rutor_direct = "rutor_direct"


class Release(BaseModel):
    provider: Provider
    external_id: str
    title: str
    quality: Optional[str] = None
    voice: Optional[str] = None
    size: Optional[str] = None
    seeds: Optional[str] = None
    peers: Optional[str] = None
    magnet: Optional[str] = None
    url: Optional[str] = None


class SearchResponse(BaseModel):
    query: str
    source: str
    releases: list[Release]


class ReleaseDetail(Release):
    hash: Optional[str] = None
    description: Optional[str] = None


class PlayRequest(BaseModel):
    provider: Optional[Provider] = None
    external_id: Optional[str] = None
    magnet: Optional[str] = None
    title: Optional[str] = None


class PlayResponse(BaseModel):
    hash: str
    title: str
    stream_url: str
    file_name: str
    file_index: int


class TorrentFileStat(BaseModel):
    id: int
    path: str
    length: int


class TorrentEntry(BaseModel):
    hash: str
    title: str
    stat_string: Optional[str] = None
    torrent_size: Optional[int] = None
    loaded_size: Optional[int] = None
    preloaded_bytes: Optional[int] = None
    bytes_written_data: Optional[int] = None
    download_speed: Optional[float] = None
    upload_speed: Optional[float] = None
    total_peers: Optional[int] = None
    connected_seeders: Optional[int] = None
    quality: Optional[str] = None
    voice: Optional[str] = None
    search_query: Optional[str] = None
    provider: Optional[str] = None
    file_stats: list[TorrentFileStat] = Field(default_factory=list)


class TorrentListResponse(BaseModel):
    torrents: list[TorrentEntry]
