from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    torapi_url: str = "http://torapi:8443"
    torrent_engine_url: str = "http://torrent-engine:8090"
    torrent_engine_public_url: str = "http://localhost:3000"
    transcoder_url: str = "http://transcoder:8091"
    transcoder_enabled: bool = True
    complete_scope: str = "active_only"
    torrent_engine_save_path: str = "/torrents"
    database_path: str = "/data/orchestrator.sqlite3"
    search_timeout: float = 60.0
    play_metadata_timeout: float = 180.0
    torrent_engine_request_timeout: float = 120.0
    torrent_engine_list_timeout: float = 45.0
    torrent_engine_connections_limit: int = 500
    torrent_engine_priority_concurrency: int = 4

    orchestrator_public_url: str = "http://localhost:3000"
    transcode_enabled: bool = True
    transcode_work_dir: str = "/tmp/transcode"
    transcode_max_sessions: int = 4
    transcode_session_ttl_sec: int = 300
    transcode_allow_hevc_direct: bool = False
    transcode_probe_timeout: float = 45.0
    transcode_probe_retries: int = 6
    transcode_probe_retry_delay: float = 3.0

    probe_warm_bytes: int = 4_194_304
    probe_warm_files: int = 2
    probe_warm_manual_files: int = -1
    probe_warm_concurrency: int = 1

    service_restart_enabled: bool = False
    docker_socket_path: str = "/var/run/docker.sock"
    docker_container_torrent_engine: str = "home-cinema-torrent-engine"
    docker_container_transcoder: str = "home-cinema-transcoder"
    docker_container_torapi: str = "home-cinema-torapi"
    docker_container_orchestrator: str = "home-cinema-orchestrator"

    discovery_mdns_enabled: bool = False
    orchestrator_listen_port: int = 8080
