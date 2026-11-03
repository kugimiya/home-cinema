import { z } from "zod";

export const ProviderSchema = z.enum([
  "rutracker",
  "kinozal",
  "rutor",
  "nonameclub",
  "rutor_direct",
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const PlaybackModeSchema = z.enum([
  "direct",
  "hls_transcode",
  "hls_remux",
  "hls_audio",
]);
export type PlaybackMode = z.infer<typeof PlaybackModeSchema>;

export const MediaKindSchema = z.enum(["video", "subtitle", "audio", "other"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const WarmStatusSchema = z.enum([
  "off",
  "idle",
  "queued",
  "warming",
  "ready",
  "failed",
]);
export type WarmStatus = z.infer<typeof WarmStatusSchema>;

export const ServiceStateSchema = z.enum([
  "ok",
  "busy",
  "degraded",
  "down",
  "unknown",
]);
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const ReleaseSchema = z.object({
  provider: ProviderSchema,
  external_id: z.string(),
  title: z.string(),
  quality: z.string().nullable().optional(),
  voice: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  seeds: z.string().nullable().optional(),
  peers: z.string().nullable().optional(),
  magnet: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  torrent_url: z.string().nullable().optional(),
});
export type Release = z.infer<typeof ReleaseSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  source: z.string(),
  releases: z.array(ReleaseSchema),
});

export const ReleaseDetailSchema = ReleaseSchema.extend({
  hash: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type ReleaseDetail = z.infer<typeof ReleaseDetailSchema>;

export const TorrentMediaFileSchema = z.object({
  id: z.number(),
  path: z.string(),
  name: z.string(),
  length: z.number(),
  kind: MediaKindSchema,
  quality: z.string().nullable().optional(),
  voice: z.string().nullable().optional(),
  stream_url: z.string().nullable().optional(),
});
export type TorrentMediaFile = z.infer<typeof TorrentMediaFileSchema>;

export const PlayRequestSchema = z.object({
  provider: ProviderSchema.nullable().optional(),
  external_id: z.string().nullable().optional(),
  magnet: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  file_index: z.number().nullable().optional(),
});

export const PrepareResponseSchema = z.object({
  hash: z.string(),
  title: z.string(),
  phase: z.string(),
  message: z.string(),
  stat_string: z.string().nullable().optional(),
  total_peers: z.number().nullable().optional(),
  files: z.array(TorrentMediaFileSchema).default([]),
  ready: z.boolean().default(false),
});

export const AudioTrackInfoSchema = z.object({
  index: z.number(),
  stream_index: z.number().default(0),
  codec: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  label: z.string(),
});
export type AudioTrackInfo = z.infer<typeof AudioTrackInfoSchema>;

export const PlaySelectRequestSchema = z.object({
  hash: z.string(),
  file_index: z.number(),
  subtitle_file_ids: z.array(z.number()).default([]),
  video_height: z.number().nullable().optional(),
});

export const DownloadScopeBodySchema = z.object({
  file_ids: z.array(z.number()),
});

export const PlayResponseSchema = z.object({
  hash: z.string(),
  title: z.string(),
  files: z.array(TorrentMediaFileSchema).default([]),
  stream_url: z.string().nullable().optional(),
  file_name: z.string().nullable().optional(),
  file_index: z.number().nullable().optional(),
  playback_mode: PlaybackModeSchema.default("direct"),
  playback_url: z.string().nullable().optional(),
  transcode_session_id: z.string().nullable().optional(),
  direct_playable: z.boolean().default(true),
  probe_status: z.string().default("ok"),
  audio_tracks: z.array(AudioTrackInfoSchema).default([]),
  selected_audio_index: z.number().default(0),
  duration_sec: z.number().nullable().optional(),
  file_length: z.number().nullable().optional(),
});

export const PlaySelectStatusResponseSchema = z.object({
  active: z.boolean(),
  hash: z.string().default(""),
  step: z.number().default(0),
  step_total: z.number().default(0),
  phase: z.string().default(""),
  message: z.string().default(""),
  probe_attempt: z.number().default(0),
  probe_max: z.number().default(0),
  probe_bytes_downloaded: z.number().default(0),
  probe_bytes_target: z.number().default(0),
  probe_download_speed: z.number().nullable().optional(),
  probe_total_peers: z.number().nullable().optional(),
  probe_subphase: z.string().default(""),
  probe_elapsed_sec: z.number().default(0),
});

export const TranscodeSessionRequestSchema = z.object({
  hash: z.string(),
  file_index: z.number(),
  audio_index: z.number().default(0),
  start_sec: z.number().default(0),
  video_height: z.number().nullable().optional(),
  replace_session_id: z.string().nullable().optional(),
});

export const PlaybackEndedBodySchema = z.object({
  file_ids: z.array(z.number()).default([]),
});

export const TranscodeSessionResponseSchema = z.object({
  session_id: z.string(),
  playback_url: z.string(),
  playback_mode: PlaybackModeSchema,
  selected_audio_index: z.number(),
  start_sec: z.number(),
  audio_tracks: z.array(AudioTrackInfoSchema).default([]),
  duration_sec: z.number().nullable().optional(),
  file_length: z.number().nullable().optional(),
});

export const TorrentFileStatSchema = z.object({
  id: z.number(),
  path: z.string(),
  length: z.number(),
  downloaded_bytes: z.number().default(0),
  completed: z.boolean().default(false),
  priority: z.number().default(0),
  download_speed: z.number().nullable().optional(),
  kind: MediaKindSchema.default("other"),
  warm_status: WarmStatusSchema.default("off"),
  warm_bytes: z.number().default(0),
  warm_target_bytes: z.number().default(0),
  uploaded_bytes: z.number().default(0),
});
export type TorrentFileStat = z.infer<typeof TorrentFileStatSchema>;

export const StorageSummarySchema = z.object({
  disk_total_bytes: z.number(),
  disk_free_bytes: z.number(),
  disk_used_bytes: z.number(),
  torrents_data_bytes: z.number(),
});

export const TorrentEntrySchema = z.object({
  hash: z.string(),
  title: z.string(),
  stat_string: z.string().nullable().optional(),
  torrent_size: z.number().nullable().optional(),
  loaded_size: z.number().nullable().optional(),
  preloaded_bytes: z.number().nullable().optional(),
  bytes_written_data: z.number().nullable().optional(),
  uploaded_bytes: z.number().default(0),
  download_speed: z.number().nullable().optional(),
  upload_speed: z.number().nullable().optional(),
  total_peers: z.number().nullable().optional(),
  connected_seeders: z.number().nullable().optional(),
  quality: z.string().nullable().optional(),
  voice: z.string().nullable().optional(),
  search_query: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  file_stats: z.array(TorrentFileStatSchema).default([]),
  on_disk_bytes: z.number().nullable().optional(),
  warm_summary: z.string().nullable().optional(),
  probe_warm_enabled: z.boolean().default(false),
});

export const TorrentListResponseSchema = z.object({
  storage: StorageSummarySchema,
  torrents: z.array(TorrentEntrySchema),
});

export const WarmProbeFileStatusSchema = z.object({
  id: z.number(),
  path: z.string().default(""),
  status: WarmStatusSchema.default("idle"),
  warmed_bytes: z.number().default(0),
  target_bytes: z.number().default(0),
  error: z.string().nullable().optional(),
});

export const WarmProbeStatusResponseSchema = z.object({
  enabled: z.boolean(),
  active: z.boolean(),
  current_path: z.string().nullable().optional(),
  done: z.number().default(0),
  total: z.number().default(0),
  files: z.array(WarmProbeFileStatusSchema).default([]),
});

export const WarmProbeStartResponseSchema = z.object({
  status: z.string(),
  queued: z.number().default(0),
  skipped: z.number().default(0),
});

export const ServiceStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: ServiceStateSchema,
  activity: z.string(),
  restart_allowed: z.boolean().default(false),
});

export const SystemStatusResponseSchema = z.object({
  services: z.array(ServiceStatusSchema),
  polled_at: z.string(),
});

export const EngineSessionStatusSchema = z.object({
  save_path: z.string(),
  connections_limit: z.number(),
  listen: z.string(),
  enable_dht: z.boolean().default(true),
  enable_lsd: z.boolean().default(true),
  enable_upnp: z.boolean().default(true),
  enable_natpmp: z.boolean().default(true),
  torrent_count: z.number(),
  download_rate: z.number(),
  upload_rate: z.number(),
  active_downloads: z.number(),
  waiting_metadata: z.number(),
  seeding_count: z.number(),
  alert_buffer_size: z.number(),
  collected_at: z.number(),
  user_agent: z.string().nullable().optional(),
  peer_fingerprint: z.string().nullable().optional(),
  handshake_client_version: z.string().nullable().optional(),
  dht_bootstrap_nodes: z.string().nullable().optional(),
});

export const EngineTorrentFileLiveSchema = z.object({
  id: z.number(),
  path: z.string(),
  length: z.number(),
  downloaded_bytes: z.number().default(0),
  completed: z.boolean().default(false),
  priority: z.number().default(0),
});

export const EngineTorrentLiveSchema = z.object({
  hash: z.string(),
  title: z.string(),
  stat_string: z.string().nullable().optional(),
  mode: z.string().nullable().optional(),
  torrent_size: z.number().nullable().optional(),
  loaded_size: z.number().nullable().optional(),
  download_speed: z.number().nullable().optional(),
  upload_speed: z.number().nullable().optional(),
  total_peers: z.number().nullable().optional(),
  connected_seeders: z.number().nullable().optional(),
  bytes_written_data: z.number().nullable().optional(),
  all_time_download: z.number().nullable().optional(),
  has_metadata: z.boolean().nullable().optional(),
  is_seeding: z.boolean().nullable().optional(),
  is_finished: z.boolean().nullable().optional(),
  is_paused: z.boolean().nullable().optional(),
  progress: z.number().nullable().optional(),
  num_connections: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  save_path: z.string().nullable().optional(),
  torrent_name: z.string().nullable().optional(),
  scope_file_ids: z.array(z.number()).default([]),
  last_heartbeat_age_sec: z.number().nullable().optional(),
  sequential_download: z.boolean().nullable().optional(),
  pieces_total: z.number().nullable().optional(),
  pieces_have: z.number().nullable().optional(),
  piece_length: z.number().nullable().optional(),
  file_stats: z.array(EngineTorrentFileLiveSchema).default([]),
});

export const EngineAlertEntrySchema = z.object({
  type: z.string(),
  message: z.string(),
  at: z.number(),
  category: z.number().nullable().optional(),
  info_hash: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export const EngineOrchestratorSnapshotSchema = z.object({
  activity_label: z.string().nullable().optional(),
  activity_detail: z.string().nullable().optional(),
  transcode_sessions: z.number().default(0),
  transcode_max: z.number().default(0),
  warm_probe_active: z.boolean().default(false),
  warm_probe_detail: z.string().nullable().optional(),
  warm_probe_queue: z.number().default(0),
});

export const EngineDiagnosticsResponseSchema = z.object({
  session: EngineSessionStatusSchema.nullable().optional(),
  torrents: z.array(EngineTorrentLiveSchema).default([]),
  alerts: z.array(EngineAlertEntrySchema).default([]),
  orchestrator: EngineOrchestratorSnapshotSchema,
  engine_error: z.string().nullable().optional(),
  polled_at: z.string(),
});

export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;
export type EngineSessionStatus = z.infer<typeof EngineSessionStatusSchema>;
export type EngineTorrentFileLive = z.infer<typeof EngineTorrentFileLiveSchema>;
export type EngineTorrentLive = z.infer<typeof EngineTorrentLiveSchema>;
export type EngineAlertEntry = z.infer<typeof EngineAlertEntrySchema>;
export type EngineOrchestratorSnapshot = z.infer<typeof EngineOrchestratorSnapshotSchema>;
export type EngineDiagnosticsResponse = z.infer<typeof EngineDiagnosticsResponseSchema>;
