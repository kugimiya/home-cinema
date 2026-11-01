from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    torapi_url: str = "http://torapi:8443"
    torrserver_url: str = "http://torrserver:8090"
    torrserver_public_url: str = "http://localhost:8090"
    torrents_save_path: str = "/torrents"
    database_path: str = "/data/orchestrator.sqlite3"
    search_timeout: float = 60.0
    play_metadata_timeout: float = 180.0
    torrserver_request_timeout: float = 120.0
    torrserver_list_timeout: float = 45.0
    # TorrServer BTSets (see YouROK/TorrServer server/settings/btsets.go)
    torrserver_cache_size_mb: int = 128
    torrserver_preload_cache: int = 40
    torrserver_connections_limit: int = 40
    torrserver_reader_read_ahead: int = 95
    torrserver_priority_concurrency: int = 4

    orchestrator_public_url: str = "http://localhost:3000"
    transcode_enabled: bool = True
    transcode_work_dir: str = "/tmp/transcode"
    transcode_max_sessions: int = 2
    transcode_session_ttl_sec: int = 300
    transcode_allow_hevc_direct: bool = False
    transcode_probe_timeout: float = 45.0
    transcode_probe_retries: int = 6
    transcode_probe_retry_delay: float = 3.0

    # HTTP Range prefetch for fast ffprobe (0 = disabled)
    probe_warm_bytes: int = 4_194_304
    probe_warm_files: int = 2
    probe_warm_manual_files: int = -1
    probe_warm_concurrency: int = 1

    service_restart_enabled: bool = False
    docker_socket_path: str = "/var/run/docker.sock"
    docker_container_torrserver: str = "home-cinema-torrserver"
    docker_container_torapi: str = "home-cinema-torapi"
    docker_container_orchestrator: str = "home-cinema-orchestrator"

    discovery_mdns_enabled: bool = False
    orchestrator_listen_port: int = 8080
