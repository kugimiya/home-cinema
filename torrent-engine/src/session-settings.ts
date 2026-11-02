import { existsSync } from "node:fs";
import type { Settings } from "./config.js";
import { clientSessionSettings } from "./client-identity.js";

const PE_ENABLED = 1;
const PE_FORCED = 2;
const PE_DISABLED = 0;
const CHOKING_FIXED = 0;
const CHOKING_RATE = 2;
const SEED_CHOKING_RR = 0;
const SEED_CHOKING_FAST = 1;
const SEED_CHOKING_ANTI = 2;
const MIXED_PREFER_TCP = 0;
const MIXED_PROPORTIONAL = 1;
const DISK_IO_ENABLE_OS = 0;
const DISK_IO_DISABLE_OS = 1;
const SUGGEST_NONE = 0;
const SUGGEST_READ_CACHE = 1;

export interface SessionConfiguration {
  libtorrent: Record<string, unknown>;
  maxConnectionsPerTorrent: number;
  maxUploadSlotsPerTorrent: number;
  listenPort: number;
}

/** Avoid 0.0.0.0 in Docker: libtorrent may announce trackers from 127.0.0.1 → get_interface failures. */
export function resolveListenInterfaces(settings: Settings): string {
  const fromEnv = process.env.TORRENT_ENGINE_LISTEN_INTERFACES?.trim();
  if (fromEnv) return fromEnv;

  const host = settings.listenHost.trim();
  const port = settings.listenPort;
  if (
    host &&
    host !== "0.0.0.0" &&
    host !== "::" &&
    host !== "0:0:0:0:0:0:0:0"
  ) {
    return `${host}:${port}`;
  }

  if (process.platform === "linux" && existsSync("/sys/class/net/eth0")) {
    return `eth0:${port}`;
  }
  return `${host}:${port}`;
}

export function buildSessionConfiguration(settings: Settings): SessionConfiguration {
  const lt: Record<string, unknown> = {
    listen_interfaces: resolveListenInterfaces(settings),
    enable_dht: settings.enableDht,
    enable_lsd: settings.enableLsd,
    enable_upnp: settings.enableUpnp,
    enable_natpmp: settings.enableNatpmp,
    connections_limit: settings.connectionsLimit,
    unchoke_slots_limit: settings.unchokeSlotsLimit,
    connection_speed: settings.connectionSpeed,
    send_socket_buffer_size: settings.socketSendBufferSize,
    recv_socket_buffer_size: settings.socketReceiveBufferSize,
    listen_queue_size: settings.socketBacklogSize,
    download_rate_limit: settings.downloadRateLimit,
    upload_rate_limit: settings.uploadRateLimit,
    allowed_enc_level: 1,
    prefer_rc4: true,
    active_checking: settings.maxActiveChecking,
    announce_to_all_trackers: settings.announceToAllTrackers,
    announce_to_all_tiers: settings.announceToAllTiers,
    peer_turnover: settings.peerTurnover,
    peer_turnover_cutoff: settings.peerTurnoverCutoff,
    peer_turnover_interval: settings.peerTurnoverInterval,
    max_out_request_queue: settings.maxOutRequestQueue,
    aio_threads: settings.aioThreads,
    hashing_threads: settings.hashingThreads,
    file_pool_size: settings.filePoolSize,
    checking_mem_usage: settings.checkingMemUsageSize * 64,
    max_queued_disk_bytes: settings.diskQueueSize,
    piece_extent_affinity: settings.pieceExtentAffinity,
    anonymous_mode: settings.anonymousMode,
    send_buffer_watermark: settings.sendBufferWatermark * 1024,
    send_buffer_low_watermark: settings.sendBufferLowWatermark * 1024,
    send_buffer_watermark_factor: settings.sendBufferWatermarkFactor,
    upnp_lease_duration: settings.upnpLeaseDuration,
    peer_dscp: settings.peerDscp,
    rate_limit_ip_overhead: settings.includeOverheadInLimits,
    max_concurrent_http_announces: settings.maxConcurrentHttpAnnounces,
    stop_tracker_timeout: settings.stopTrackerTimeout,
    resolver_cache_timeout: settings.hostnameCacheTtl,
    allow_idna: settings.allowIdna,
    allow_multiple_connections_per_ip: settings.allowMultipleConnectionsPerIp,
    validate_https_trackers: settings.validateHttpsTrackers,
    ssrf_mitigation: settings.ssrfMitigation,
    no_connect_privileged_ports: settings.blockPeersOnPrivilegedPorts,
    apply_ip_filter_to_trackers: settings.trackerFilteringEnabled,
    dht_bootstrap_nodes: settings.dhtBootstrapNodes,
    active_tracker_limit: -1,
    active_dht_limit: -1,
    active_lsd_limit: -1,
  };

  if (settings.outgoingPortsMax > settings.outgoingPortsMin) {
    lt.outgoing_port = settings.outgoingPortsMin;
    lt.num_outgoing_ports = settings.outgoingPortsMax - settings.outgoingPortsMin;
  }

  const enc = settings.encryption;
  if (enc === 1) {
    lt.out_enc_policy = PE_FORCED;
    lt.in_enc_policy = PE_FORCED;
  } else if (enc === 2) {
    lt.out_enc_policy = PE_DISABLED;
    lt.in_enc_policy = PE_DISABLED;
  } else {
    lt.out_enc_policy = PE_ENABLED;
    lt.in_enc_policy = PE_ENABLED;
  }

  if (settings.queueingEnabled) {
    lt.active_downloads = settings.maxActiveDownloads;
    lt.active_seeds = settings.maxActiveUploads;
    lt.active_limit = settings.maxActiveTorrents;
    lt.dont_count_slow_torrents = settings.ignoreSlowTorrentsForQueueing;
    lt.inactive_down_rate = settings.slowTorrentsDownloadRate * 1024;
    lt.inactive_up_rate = settings.slowTorrentsUploadRate * 1024;
    lt.auto_manage_startup = settings.slowTorrentsInactivityTimer;
  } else {
    lt.active_downloads = -1;
    lt.active_seeds = -1;
    lt.active_limit = -1;
  }

  if (settings.btProtocol === 1) {
    Object.assign(lt, {
      enable_incoming_tcp: true,
      enable_outgoing_tcp: true,
      enable_incoming_utp: false,
      enable_outgoing_utp: false,
    });
  } else if (settings.btProtocol === 2) {
    Object.assign(lt, {
      enable_incoming_tcp: false,
      enable_outgoing_tcp: false,
      enable_incoming_utp: true,
      enable_outgoing_utp: true,
    });
  } else {
    Object.assign(lt, {
      enable_incoming_tcp: true,
      enable_outgoing_tcp: true,
      enable_incoming_utp: true,
      enable_outgoing_utp: true,
    });
  }

  lt.mixed_mode_algorithm =
    settings.utpMixedMode === 1 ? MIXED_PROPORTIONAL : MIXED_PREFER_TCP;
  lt.choking_algorithm = settings.chokingAlgorithm === 1 ? CHOKING_RATE : CHOKING_FIXED;

  if (settings.seedChokingAlgorithm === 0) {
    lt.seed_choking_algorithm = SEED_CHOKING_RR;
  } else if (settings.seedChokingAlgorithm === 2) {
    lt.seed_choking_algorithm = SEED_CHOKING_ANTI;
  } else {
    lt.seed_choking_algorithm = SEED_CHOKING_FAST;
  }

  lt.disk_io_read_mode =
    settings.diskIoReadMode === 1 ? DISK_IO_DISABLE_OS : DISK_IO_ENABLE_OS;
  lt.disk_io_write_mode =
    settings.diskIoWriteMode === 1 ? DISK_IO_DISABLE_OS : DISK_IO_ENABLE_OS;
  lt.suggest_mode = settings.suggestMode ? SUGGEST_READ_CACHE : SUGGEST_NONE;

  Object.assign(
    lt,
    clientSessionSettings({
      userAgent: settings.userAgent,
      peerFingerprint: settings.peerFingerprint,
      handshakeClientVersion: settings.handshakeClientVersion,
    }),
  );

  return {
    libtorrent: lt,
    maxConnectionsPerTorrent: settings.maxConnectionsPerTorrent,
    maxUploadSlotsPerTorrent: settings.maxUploadSlotsPerTorrent,
    listenPort: settings.listenPort,
  };
}
