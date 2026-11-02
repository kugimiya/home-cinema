"""Build libtorrent session settings from TORRENT_ENGINE_* environment / Settings."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.client_identity import client_session_settings
from app.config import Settings

_PE_ENABLED = 1
_PE_FORCED = 2
_PE_DISABLED = 0
_CHOKING_FIXED = 0
_CHOKING_RATE = 2
_SEED_CHOKING_RR = 0
_SEED_CHOKING_FAST = 1
_SEED_CHOKING_ANTI = 2
_MIXED_PREFER_TCP = 0
_MIXED_PROPORTIONAL = 1
_DISK_IO_ENABLE_OS = 0
_DISK_IO_DISABLE_OS = 1
_SUGGEST_NONE = 0
_SUGGEST_READ_CACHE = 1


@dataclass(frozen=True)
class SessionConfiguration:
    libtorrent: dict[str, Any]
    max_connections_per_torrent: int
    max_upload_slots_per_torrent: int
    listen_port: int


def build_session_configuration(settings: Settings) -> SessionConfiguration:
    lt: dict[str, Any] = {
        "listen_interfaces": f"{settings.listen_host}:{settings.listen_port}",
        "enable_dht": settings.enable_dht,
        "enable_lsd": settings.enable_lsd,
        "enable_upnp": settings.enable_upnp,
        "enable_natpmp": settings.enable_natpmp,
        "connections_limit": settings.connections_limit,
        "unchoke_slots_limit": settings.unchoke_slots_limit,
        "connection_speed": settings.connection_speed,
        "send_socket_buffer_size": settings.socket_send_buffer_size,
        "recv_socket_buffer_size": settings.socket_receive_buffer_size,
        "listen_queue_size": settings.socket_backlog_size,
        "download_rate_limit": settings.download_rate_limit,
        "upload_rate_limit": settings.upload_rate_limit,
        "allowed_enc_level": 1,
        "prefer_rc4": True,
        "active_checking": settings.max_active_checking,
        "announce_to_all_trackers": settings.announce_to_all_trackers,
        "announce_to_all_tiers": settings.announce_to_all_tiers,
        "peer_turnover": settings.peer_turnover,
        "peer_turnover_cutoff": settings.peer_turnover_cutoff,
        "peer_turnover_interval": settings.peer_turnover_interval,
        "max_out_request_queue": settings.max_out_request_queue,
        "aio_threads": settings.aio_threads,
        "hashing_threads": settings.hashing_threads,
        "file_pool_size": settings.file_pool_size,
        "checking_mem_usage": settings.checking_mem_usage_size * 64,
        "max_queued_disk_bytes": settings.disk_queue_size,
        "piece_extent_affinity": settings.piece_extent_affinity,
        "anonymous_mode": settings.anonymous_mode,
        "send_buffer_watermark": settings.send_buffer_watermark * 1024,
        "send_buffer_low_watermark": settings.send_buffer_low_watermark * 1024,
        "send_buffer_watermark_factor": settings.send_buffer_watermark_factor,
        "upnp_lease_duration": settings.upnp_lease_duration,
        "peer_dscp": settings.peer_dscp,
        "rate_limit_ip_overhead": settings.include_overhead_in_limits,
        "max_concurrent_http_announces": settings.max_concurrent_http_announces,
        "stop_tracker_timeout": settings.stop_tracker_timeout,
        "resolver_cache_timeout": settings.hostname_cache_ttl,
        "allow_idna": settings.allow_idna,
        "allow_multiple_connections_per_ip": settings.allow_multiple_connections_per_ip,
        "validate_https_trackers": settings.validate_https_trackers,
        "ssrf_mitigation": settings.ssrf_mitigation,
        "no_connect_privileged_ports": settings.block_peers_on_privileged_ports,
        "apply_ip_filter_to_trackers": settings.tracker_filtering_enabled,
        "dht_bootstrap_nodes": settings.dht_bootstrap_nodes,
        "active_tracker_limit": -1,
        "active_dht_limit": -1,
        "active_lsd_limit": -1,
    }

    if settings.outgoing_ports_max > settings.outgoing_ports_min:
        lt["outgoing_port"] = settings.outgoing_ports_min
        lt["num_outgoing_ports"] = settings.outgoing_ports_max - settings.outgoing_ports_min

    enc = settings.encryption
    if enc == 1:
        lt["out_enc_policy"] = _PE_FORCED
        lt["in_enc_policy"] = _PE_FORCED
    elif enc == 2:
        lt["out_enc_policy"] = _PE_DISABLED
        lt["in_enc_policy"] = _PE_DISABLED
    else:
        lt["out_enc_policy"] = _PE_ENABLED
        lt["in_enc_policy"] = _PE_ENABLED

    if settings.queueing_enabled:
        lt["active_downloads"] = settings.max_active_downloads
        lt["active_seeds"] = settings.max_active_uploads
        lt["active_limit"] = settings.max_active_torrents
        lt["dont_count_slow_torrents"] = settings.ignore_slow_torrents_for_queueing
        lt["inactive_down_rate"] = settings.slow_torrents_download_rate * 1024
        lt["inactive_up_rate"] = settings.slow_torrents_upload_rate * 1024
        lt["auto_manage_startup"] = settings.slow_torrents_inactivity_timer
    else:
        lt["active_downloads"] = -1
        lt["active_seeds"] = -1
        lt["active_limit"] = -1

    if settings.bt_protocol == 1:
        lt.update(
            {
                "enable_incoming_tcp": True,
                "enable_outgoing_tcp": True,
                "enable_incoming_utp": False,
                "enable_outgoing_utp": False,
            }
        )
    elif settings.bt_protocol == 2:
        lt.update(
            {
                "enable_incoming_tcp": False,
                "enable_outgoing_tcp": False,
                "enable_incoming_utp": True,
                "enable_outgoing_utp": True,
            }
        )
    else:
        lt.update(
            {
                "enable_incoming_tcp": True,
                "enable_outgoing_tcp": True,
                "enable_incoming_utp": True,
                "enable_outgoing_utp": True,
            }
        )

    lt["mixed_mode_algorithm"] = (
        _MIXED_PROPORTIONAL if settings.utp_mixed_mode == 1 else _MIXED_PREFER_TCP
    )
    lt["choking_algorithm"] = (
        _CHOKING_RATE if settings.choking_algorithm == 1 else _CHOKING_FIXED
    )
    if settings.seed_choking_algorithm == 0:
        lt["seed_choking_algorithm"] = _SEED_CHOKING_RR
    elif settings.seed_choking_algorithm == 2:
        lt["seed_choking_algorithm"] = _SEED_CHOKING_ANTI
    else:
        lt["seed_choking_algorithm"] = _SEED_CHOKING_FAST

    lt["disk_io_read_mode"] = (
        _DISK_IO_DISABLE_OS if settings.disk_io_read_mode == 1 else _DISK_IO_ENABLE_OS
    )
    lt["disk_io_write_mode"] = (
        _DISK_IO_DISABLE_OS if settings.disk_io_write_mode == 1 else _DISK_IO_ENABLE_OS
    )
    lt["suggest_mode"] = _SUGGEST_READ_CACHE if settings.suggest_mode else _SUGGEST_NONE

    lt.update(
        client_session_settings(
            user_agent=settings.user_agent,
            peer_fingerprint=settings.peer_fingerprint,
            handshake_client_version=settings.handshake_client_version,
        )
    )

    return SessionConfiguration(
        libtorrent=lt,
        max_connections_per_torrent=settings.max_connections_per_torrent,
        max_upload_slots_per_torrent=settings.max_upload_slots_per_torrent,
        listen_port=settings.listen_port,
    )
