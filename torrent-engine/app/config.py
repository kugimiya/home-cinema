from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TORRENT_ENGINE_", extra="ignore")

    save_path: str = "/torrents"
    host: str = "0.0.0.0"
    port: int = 8090
    listen_host: str = "0.0.0.0"
    listen_port: int = 6881
    metadata_timeout_sec: float = 120.0

    # Connection limits
    connections_limit: int = 500
    unchoke_slots_limit: int = 20
    max_connections_per_torrent: int = 100
    max_upload_slots_per_torrent: int = 4
    connection_speed: int = 30
    allow_multiple_connections_per_ip: bool = False

    # Rate limits (bytes/s; 0 = unlimited)
    download_rate_limit: int = 0
    upload_rate_limit: int = 0
    include_overhead_in_limits: bool = False

    # Network discovery
    enable_dht: bool = True
    enable_lsd: bool = True
    enable_upnp: bool = True
    enable_natpmp: bool = True
    dht_bootstrap_nodes: str = (
        "dht.libtorrent.org:25401,"
        "dht.transmissionbt.com:6881,"
        "router.bittorrent.com:6881"
    )

    # Protocol: 0=TCP+uTP, 1=TCP only, 2=uTP only
    bt_protocol: int = 0
    utp_mixed_mode: int = 0  # 0=prefer TCP, 1=proportional
    # Encryption: 0=enabled, 1=forced, 2=disabled
    encryption: int = 0

    # Choking
    choking_algorithm: int = 0  # 0=fixed slots, 1=rate based
    seed_choking_algorithm: int = 1  # 0=round robin, 1=fastest, 2=anti-leech

    # Peer rotation
    peer_turnover: int = 4
    peer_turnover_cutoff: int = 90
    peer_turnover_interval: int = 300
    max_out_request_queue: int = 500

    # Queue (auto-manage)
    queueing_enabled: bool = False
    max_active_downloads: int = 3
    max_active_uploads: int = 3
    max_active_torrents: int = 5
    ignore_slow_torrents_for_queueing: bool = False
    slow_torrents_download_rate: int = 2
    slow_torrents_upload_rate: int = 2
    slow_torrents_inactivity_timer: int = 60

    # Disk / I/O
    aio_threads: int = 10
    hashing_threads: int = 1
    file_pool_size: int = 100
    checking_mem_usage_size: int = 32
    disk_queue_size: int = 1024 * 1024
    disk_io_read_mode: int = 0
    disk_io_write_mode: int = 0
    max_active_checking: int = 1

    # Buffers
    send_buffer_watermark: int = 500
    send_buffer_low_watermark: int = 10
    send_buffer_watermark_factor: int = 50
    socket_send_buffer_size: int = 0
    socket_receive_buffer_size: int = 0
    socket_backlog_size: int = 30

    # Outgoing / trackers
    outgoing_ports_min: int = 0
    outgoing_ports_max: int = 0
    upnp_lease_duration: int = 0
    peer_dscp: int = 0x01
    max_concurrent_http_announces: int = 50
    stop_tracker_timeout: int = 2
    hostname_cache_ttl: int = 1200
    announce_to_all_trackers: bool = False
    announce_to_all_tiers: bool = True
    tracker_filtering_enabled: bool = False

    # Misc session
    anonymous_mode: bool = False
    piece_extent_affinity: bool = False
    suggest_mode: bool = False
    allow_idna: bool = False
    validate_https_trackers: bool = True
    ssrf_mitigation: bool = True
    block_peers_on_privileged_ports: bool = False

    # BitTorrent client identity (trackers / peer handshake)
    user_agent: str | None = "home-cinema/1.0"
    peer_fingerprint: str | None = None
    handshake_client_version: str | None = None


settings = Settings()
