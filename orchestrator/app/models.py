from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field

PlaybackMode = Literal["direct", "hls_transcode", "hls_remux"]


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
    torrent_url: Optional[str] = None


class SearchResponse(BaseModel):
    query: str
    source: str
    releases: list[Release]


class ReleaseDetail(Release):
    hash: Optional[str] = None
    description: Optional[str] = None


class MediaKind(str, Enum):
    video = "video"
    subtitle = "subtitle"
    audio = "audio"
    other = "other"


class TorrentMediaFile(BaseModel):
    id: int
    path: str
    name: str
    length: int
    kind: MediaKind
    quality: Optional[str] = None
    voice: Optional[str] = None
    stream_url: Optional[str] = None


class PlayRequest(BaseModel):
    provider: Optional[Provider] = None
    external_id: Optional[str] = None
    magnet: Optional[str] = None
    title: Optional[str] = None
    file_index: Optional[int] = None


class PrepareResponse(BaseModel):
    hash: str
    title: str
    phase: str
    message: str
    stat_string: Optional[str] = None
    total_peers: Optional[int] = None
    files: list[TorrentMediaFile] = Field(default_factory=list)
    ready: bool = False


class AudioTrackInfo(BaseModel):
    index: int
    stream_index: int = 0
    codec: Optional[str] = None
    language: Optional[str] = None
    title: Optional[str] = None
    label: str


class PlaySelectRequest(BaseModel):
    hash: str
    file_index: int
    subtitle_file_ids: list[int] = Field(default_factory=list)
    video_height: Optional[int] = None


class DownloadScopeBody(BaseModel):
    file_ids: list[int]


class PlayResponse(BaseModel):
    hash: str
    title: str
    files: list[TorrentMediaFile] = Field(default_factory=list)
    stream_url: Optional[str] = None
    file_name: Optional[str] = None
    file_index: Optional[int] = None
    playback_mode: PlaybackMode = "direct"
    playback_url: Optional[str] = None
    transcode_session_id: Optional[str] = None
    direct_playable: bool = True
    probe_status: str = "ok"
    audio_tracks: list[AudioTrackInfo] = Field(default_factory=list)
    selected_audio_index: int = 0
    duration_sec: Optional[float] = None
    file_length: Optional[int] = None


class PlaySelectStatusResponse(BaseModel):
    active: bool
    hash: str = ""
    step: int = 0
    step_total: int = 0
    phase: str = ""
    message: str = ""
    probe_attempt: int = 0
    probe_max: int = 0
    probe_bytes_downloaded: int = 0
    probe_bytes_target: int = 0
    probe_download_speed: Optional[float] = None
    probe_total_peers: Optional[int] = None
    probe_subphase: str = ""
    probe_elapsed_sec: int = 0


class TranscodeSessionRequest(BaseModel):
    hash: str
    file_index: int
    audio_index: int = 0
    start_sec: float = 0.0
    video_height: Optional[int] = None
    replace_session_id: Optional[str] = None


class PlaybackEndedBody(BaseModel):
    file_ids: list[int] = Field(default_factory=list)


class TranscodeSessionResponse(BaseModel):
    session_id: str
    playback_url: str
    playback_mode: PlaybackMode
    selected_audio_index: int
    start_sec: float
    audio_tracks: list[AudioTrackInfo] = Field(default_factory=list)
    duration_sec: Optional[float] = None
    file_length: Optional[int] = None


WarmStatus = Literal["off", "idle", "queued", "warming", "ready", "failed"]


class TorrentFileStat(BaseModel):
    id: int
    path: str
    length: int
    downloaded_bytes: int = 0
    completed: bool = False
    priority: int = 0
    download_speed: Optional[float] = None
    kind: MediaKind = MediaKind.other
    warm_status: WarmStatus = "off"
    warm_bytes: int = 0
    warm_target_bytes: int = 0
    uploaded_bytes: int = 0


class StorageSummary(BaseModel):
    disk_total_bytes: int
    disk_free_bytes: int
    disk_used_bytes: int
    torrents_data_bytes: int


class TorrentEntry(BaseModel):
    hash: str
    title: str
    stat_string: Optional[str] = None
    torrent_size: Optional[int] = None
    loaded_size: Optional[int] = None
    preloaded_bytes: Optional[int] = None
    bytes_written_data: Optional[int] = None
    uploaded_bytes: int = 0
    download_speed: Optional[float] = None
    upload_speed: Optional[float] = None
    total_peers: Optional[int] = None
    connected_seeders: Optional[int] = None
    quality: Optional[str] = None
    voice: Optional[str] = None
    search_query: Optional[str] = None
    provider: Optional[str] = None
    file_stats: list[TorrentFileStat] = Field(default_factory=list)
    on_disk_bytes: Optional[int] = None
    warm_summary: Optional[str] = None
    probe_warm_enabled: bool = False


class WarmProbeFileStatus(BaseModel):
    id: int
    path: str = ""
    status: WarmStatus = "idle"
    warmed_bytes: int = 0
    target_bytes: int = 0
    error: Optional[str] = None


class WarmProbeStatusResponse(BaseModel):
    enabled: bool
    active: bool
    current_path: Optional[str] = None
    done: int = 0
    total: int = 0
    files: list[WarmProbeFileStatus] = Field(default_factory=list)


class WarmProbeStartResponse(BaseModel):
    status: str
    queued: int = 0
    skipped: int = 0


class TorrentListResponse(BaseModel):
    storage: StorageSummary
    torrents: list[TorrentEntry]


ServiceState = Literal["ok", "busy", "degraded", "down", "unknown"]


class ServiceStatus(BaseModel):
    id: str
    label: str
    state: ServiceState
    activity: str
    restart_allowed: bool = False


class SystemStatusResponse(BaseModel):
    services: list[ServiceStatus]
    polled_at: str


class EngineSessionStatus(BaseModel):
    save_path: str
    connections_limit: int
    listen: str
    enable_dht: bool = True
    enable_lsd: bool = True
    enable_upnp: bool = True
    enable_natpmp: bool = True
    torrent_count: int
    download_rate: int
    upload_rate: int
    active_downloads: int
    waiting_metadata: int
    seeding_count: int
    alert_buffer_size: int
    collected_at: float
    user_agent: Optional[str] = None
    peer_fingerprint: Optional[str] = None
    handshake_client_version: Optional[str] = None
    dht_bootstrap_nodes: Optional[str] = None


class EngineTorrentFileLive(BaseModel):
    id: int
    path: str
    length: int
    downloaded_bytes: int = 0
    completed: bool = False
    priority: int = 0


class EngineTorrentLive(BaseModel):
    hash: str
    title: str
    stat_string: Optional[str] = None
    mode: Optional[str] = None
    torrent_size: Optional[int] = None
    loaded_size: Optional[int] = None
    download_speed: Optional[float] = None
    upload_speed: Optional[float] = None
    total_peers: Optional[int] = None
    connected_seeders: Optional[int] = None
    bytes_written_data: Optional[int] = None
    all_time_download: Optional[int] = None
    has_metadata: Optional[bool] = None
    is_seeding: Optional[bool] = None
    is_finished: Optional[bool] = None
    is_paused: Optional[bool] = None
    progress: Optional[float] = None
    num_connections: Optional[int] = None
    error: Optional[str] = None
    save_path: Optional[str] = None
    torrent_name: Optional[str] = None
    scope_file_ids: list[int] = Field(default_factory=list)
    last_heartbeat_age_sec: Optional[float] = None
    sequential_download: Optional[bool] = None
    pieces_total: Optional[int] = None
    pieces_have: Optional[int] = None
    piece_length: Optional[int] = None
    file_stats: list[EngineTorrentFileLive] = Field(default_factory=list)


class EngineAlertEntry(BaseModel):
    type: str
    message: str
    at: float
    category: Optional[int] = None
    info_hash: Optional[str] = None
    error: Optional[str] = None


class EngineOrchestratorSnapshot(BaseModel):
    activity_label: Optional[str] = None
    activity_detail: Optional[str] = None
    transcode_sessions: int = 0
    transcode_max: int = 0
    warm_probe_active: bool = False
    warm_probe_detail: Optional[str] = None
    warm_probe_queue: int = 0


class EngineDiagnosticsResponse(BaseModel):
    session: Optional[EngineSessionStatus] = None
    torrents: list[EngineTorrentLive] = Field(default_factory=list)
    alerts: list[EngineAlertEntry] = Field(default_factory=list)
    orchestrator: EngineOrchestratorSnapshot
    engine_error: Optional[str] = None
    polled_at: str
