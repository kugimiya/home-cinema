const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type Provider =
  | "rutracker"
  | "kinozal"
  | "rutor"
  | "nonameclub"
  | "rutor_direct";

export type MediaKind = "video" | "subtitle" | "audio" | "other";

export interface Release {
  provider: Provider;
  external_id: string;
  title: string;
  quality?: string | null;
  voice?: string | null;
  size?: string | null;
  seeds?: string | null;
  peers?: string | null;
  magnet?: string | null;
  url?: string | null;
  torrent_url?: string | null;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  rutracker: "RuTracker",
  kinozal: "Kinozal",
  rutor: "RuTor",
  nonameclub: "NoNameClub",
  rutor_direct: "RuTor",
};

export function providerLabel(provider: Provider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export interface SearchResponse {
  query: string;
  source: string;
  releases: Release[];
}

export interface TorrentMediaFile {
  id: number;
  path: string;
  name: string;
  length: number;
  kind: MediaKind;
  quality?: string | null;
  voice?: string | null;
  stream_url?: string | null;
}

export interface PrepareResponse {
  hash: string;
  title: string;
  phase: string;
  message: string;
  stat_string?: string | null;
  total_peers?: number | null;
  files: TorrentMediaFile[];
  ready: boolean;
}

export type PlaybackMode = "direct" | "hls_transcode" | "hls_remux" | "hls_audio";

export interface AudioTrackInfo {
  index: number;
  stream_index?: number;
  codec?: string | null;
  language?: string | null;
  title?: string | null;
  label: string;
}

export interface PlayResponse {
  hash: string;
  title: string;
  files: TorrentMediaFile[];
  stream_url?: string | null;
  file_name?: string | null;
  file_index?: number | null;
  playback_mode?: PlaybackMode;
  playback_url?: string | null;
  transcode_session_id?: string | null;
  direct_playable?: boolean;
  probe_status?: string;
  audio_tracks?: AudioTrackInfo[];
  selected_audio_index?: number;
  duration_sec?: number | null;
  file_length?: number | null;
}

export interface TranscodeSessionResponse {
  session_id: string;
  playback_url: string;
  playback_mode: PlaybackMode;
  selected_audio_index: number;
  start_sec: number;
  audio_tracks: AudioTrackInfo[];
  duration_sec?: number | null;
  file_length?: number | null;
}

export interface PlayerState {
  hash: string;
  title: string;
  stream_url: string;
  file_name: string;
  file_index: number;
  files: TorrentMediaFile[];
  playback_mode: PlaybackMode;
  playback_url?: string | null;
  transcode_session_id?: string | null;
  direct_playable: boolean;
  audio_tracks: AudioTrackInfo[];
  selected_audio_index: number;
  duration_sec?: number | null;
  file_length?: number | null;
}

/** Navigate from search — prepare runs on /watch */
export interface WatchPendingState {
  provider?: Provider;
  external_id?: string;
  title?: string;
  hash?: string;
}

export type WarmStatus =
  | "off"
  | "idle"
  | "queued"
  | "warming"
  | "ready"
  | "failed";

export interface TorrentFileStat {
  id: number;
  path: string;
  length: number;
  downloaded_bytes: number;
  completed: boolean;
  priority: number;
  download_speed?: number | null;
  kind: MediaKind;
  warm_status?: WarmStatus;
  warm_bytes?: number;
  warm_target_bytes?: number;
  uploaded_bytes?: number;
}

export interface StorageSummary {
  disk_total_bytes: number;
  disk_free_bytes: number;
  disk_used_bytes: number;
  torrents_data_bytes: number;
}

export interface TorrentEntry {
  hash: string;
  title: string;
  stat_string?: string | null;
  torrent_size?: number | null;
  loaded_size?: number | null;
  preloaded_bytes?: number | null;
  bytes_written_data?: number | null;
  uploaded_bytes?: number;
  download_speed?: number | null;
  upload_speed?: number | null;
  total_peers?: number | null;
  quality?: string | null;
  voice?: string | null;
  file_stats?: TorrentFileStat[];
  on_disk_bytes?: number | null;
  warm_summary?: string | null;
  probe_warm_enabled?: boolean;
}

export interface WarmProbeStatus {
  enabled: boolean;
  active: boolean;
  current_path?: string | null;
  done: number;
  total: number;
  files: {
    id: number;
    path: string;
    status: WarmStatus;
    warmed_bytes: number;
    target_bytes: number;
    error?: string | null;
  }[];
}

export interface WarmProbeStartResult {
  status: string;
  queued: number;
  skipped: number;
}

export interface TorrentListResponse {
  storage: StorageSummary;
  torrents: TorrentEntry[];
}

function formatApiError(body: string, statusText: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return statusText || "Ошибка сервера";
  }
  try {
    const data = JSON.parse(trimmed) as { detail?: unknown };
    if (typeof data.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
    if (data.detail != null) {
      return JSON.stringify(data.detail);
    }
  } catch {
    /* plain text */
  }
  return trimmed;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const hasBody = init?.body != null && init.body !== "";
  if (hasBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(formatApiError(text, res.statusText));
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export function search(q: string) {
  return request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
}

export function preparePlay(provider: Provider, externalId: string) {
  return request<PrepareResponse>("/api/play/prepare", {
    method: "POST",
    body: JSON.stringify({ provider, external_id: externalId }),
  });
}

export function preparePlayMagnet(magnet: string, title?: string) {
  const body: { magnet: string; title?: string } = { magnet };
  if (title?.trim()) body.title = title.trim();
  return request<PrepareResponse>("/api/play/prepare", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchPrepare(hash: string) {
  return request<PrepareResponse>(`/api/torrents/${encodeURIComponent(hash)}/prepare`);
}

export interface PlaySelectStatus {
  active: boolean;
  hash?: string;
  step?: number;
  step_total?: number;
  phase?: string;
  message?: string;
  probe_attempt?: number;
  probe_max?: number;
  probe_bytes_downloaded?: number;
  probe_bytes_target?: number;
  probe_download_speed?: number | null;
  probe_total_peers?: number | null;
  probe_subphase?: string;
  probe_elapsed_sec?: number;
}

export function fetchPlaySelectStatus(hash: string) {
  return request<PlaySelectStatus>(
    `/api/play/select/status?hash=${encodeURIComponent(hash)}`,
  );
}

export const VIDEO_QUALITY_PRESETS = [240, 320, 480, 720, 1080, 1440] as const;
export type VideoQualityPreset = (typeof VIDEO_QUALITY_PRESETS)[number] | "auto";

export function selectPlayFile(
  hash: string,
  fileIndex: number,
  subtitleFileIds: number[] = [],
  videoHeight?: number | null,
) {
  return request<PlayResponse>("/api/play/select", {
    method: "POST",
    body: JSON.stringify({
      hash,
      file_index: fileIndex,
      subtitle_file_ids: subtitleFileIds,
      video_height: videoHeight ?? undefined,
    }),
  });
}

export function createTranscodeSession(
  hash: string,
  fileIndex: number,
  audioIndex: number,
  startSec: number,
  replaceSessionId?: string | null,
  videoHeight?: number | null,
) {
  return request<TranscodeSessionResponse>("/api/transcode/session", {
    method: "POST",
    body: JSON.stringify({
      hash,
      file_index: fileIndex,
      audio_index: audioIndex,
      start_sec: startSec,
      video_height: videoHeight ?? undefined,
      replace_session_id: replaceSessionId ?? undefined,
    }),
  });
}

export function notifyPlaybackEnded(hash: string, fileIds: number[]) {
  return request<{ status: string }>(
    `/api/torrents/${encodeURIComponent(hash)}/playback-ended`,
    {
      method: "POST",
      body: JSON.stringify({ file_ids: fileIds }),
    },
  );
}

export function deleteTranscodeSession(sessionId: string) {
  return request<{ status: string }>(
    `/api/transcode/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

export function setDownloadScope(hash: string, fileIds: number[]) {
  return request<{ status: string }>(
    `/api/torrents/${encodeURIComponent(hash)}/download-scope`,
    {
      method: "POST",
      body: JSON.stringify({ file_ids: fileIds }),
    },
  );
}

export function pauseTorrentDownload(hash: string) {
  return request<{ status: string }>(
    `/api/torrents/${encodeURIComponent(hash)}/pause-download`,
    { method: "POST", body: "{}" },
  );
}

export function startWarmProbe(hash: string) {
  return request<WarmProbeStartResult>(
    `/api/torrents/${encodeURIComponent(hash)}/warm-probe`,
    { method: "POST", body: "{}" },
  );
}

export function fetchWarmProbeStatus(hash: string) {
  return request<WarmProbeStatus>(
    `/api/torrents/${encodeURIComponent(hash)}/warm-probe`,
  );
}

export function torrentMedia(hash: string) {
  return request<PlayResponse>(`/api/torrents/${encodeURIComponent(hash)}/media`);
}

export type ServiceState = "ok" | "busy" | "degraded" | "down" | "unknown";

export interface ServiceStatus {
  id: string;
  label: string;
  state: ServiceState;
  activity: string;
  restart_allowed: boolean;
}

export interface SystemStatusResponse {
  services: ServiceStatus[];
  polled_at: string;
}

export interface EngineSessionStatus {
  save_path: string;
  connections_limit: number;
  listen: string;
  enable_dht: boolean;
  enable_lsd: boolean;
  enable_upnp: boolean;
  enable_natpmp: boolean;
  torrent_count: number;
  download_rate: number;
  upload_rate: number;
  active_downloads: number;
  waiting_metadata: number;
  seeding_count: number;
  alert_buffer_size: number;
  collected_at: number;
  user_agent?: string | null;
  peer_fingerprint?: string | null;
  handshake_client_version?: string | null;
  dht_bootstrap_nodes?: string | null;
}

export interface EngineTorrentFileLive {
  id: number;
  path: string;
  length: number;
  downloaded_bytes: number;
  completed: boolean;
  priority: number;
}

export interface EngineTorrentLive {
  hash: string;
  title: string;
  stat_string?: string | null;
  mode?: string | null;
  torrent_size?: number | null;
  loaded_size?: number | null;
  download_speed?: number | null;
  upload_speed?: number | null;
  total_peers?: number | null;
  connected_seeders?: number | null;
  bytes_written_data?: number | null;
  all_time_download?: number | null;
  has_metadata?: boolean | null;
  is_seeding?: boolean | null;
  is_finished?: boolean | null;
  is_paused?: boolean | null;
  progress?: number | null;
  num_connections?: number | null;
  error?: string | null;
  save_path?: string | null;
  torrent_name?: string | null;
  scope_file_ids: number[];
  last_heartbeat_age_sec?: number | null;
  sequential_download?: boolean | null;
  pieces_total?: number | null;
  pieces_have?: number | null;
  piece_length?: number | null;
  file_stats: EngineTorrentFileLive[];
}

export interface EngineAlertEntry {
  type: string;
  message: string;
  at: number;
  category?: number | null;
  info_hash?: string | null;
  error?: string | null;
}

export interface EngineOrchestratorSnapshot {
  activity_label?: string | null;
  activity_detail?: string | null;
  transcode_sessions: number;
  transcode_max: number;
  warm_probe_active: boolean;
  warm_probe_detail?: string | null;
  warm_probe_queue: number;
}

export interface EngineDiagnosticsResponse {
  session: EngineSessionStatus | null;
  torrents: EngineTorrentLive[];
  alerts: EngineAlertEntry[];
  orchestrator: EngineOrchestratorSnapshot;
  engine_error?: string | null;
  polled_at: string;
}

export function listTorrents(detail?: string[]) {
  const params = new URLSearchParams();
  if (detail?.length) {
    params.set("detail", detail.join(","));
  }
  const qs = params.toString();
  return request<TorrentListResponse>(`/api/torrents${qs ? `?${qs}` : ""}`, {
    signal: AbortSignal.timeout(90_000),
  });
}

export function fetchSystemStatus() {
  return request<SystemStatusResponse>("/api/system/status");
}

export function fetchEngineDiagnostics(alertLimit = 120) {
  return request<EngineDiagnosticsResponse>(
    `/api/engine/diagnostics?alert_limit=${alertLimit}`,
    { signal: AbortSignal.timeout(20_000) },
  );
}

export function restartService(serviceId: string) {
  return request<{ status: string; id: string }>(
    `/api/system/services/${encodeURIComponent(serviceId)}/restart`,
    { method: "POST", body: "{}" },
  );
}

export function deleteTorrent(hash: string, deleteFiles = true) {
  return request<{ status: string }>(
    `/api/torrents/${hash}?deleteFiles=${deleteFiles ? "true" : "false"}`,
    { method: "DELETE" },
  );
}

export function formatBytes(n?: number | null) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** torrent-engine reports speeds in bytes per second. */
export function formatSpeed(bytesPerSec?: number | null) {
  if (bytesPerSec == null || bytesPerSec <= 0) return null;
  return `${formatBytes(bytesPerSec)}/s`;
}

export function fileStatusLabel(f: TorrentFileStat): string {
  const warm = f.warm_status ?? "off";
  if (warm === "warming") {
    const target = f.warm_target_bytes ?? 0;
    const got = f.warm_bytes ?? 0;
    return target > 0
      ? `Прогрев ffprobe · ${formatBytes(got)} / ${formatBytes(target)}`
      : "Прогрев ffprobe…";
  }
  if (warm === "queued") return "В очереди на прогрев ffprobe";
  if (warm === "failed") return "Ошибка прогрева ffprobe";
  if (warm === "ready" && !f.completed) {
    const head = formatBytes(Math.max(f.warm_bytes ?? 0, f.downloaded_bytes));
    if (f.download_speed && f.download_speed > 0) {
      const spd = formatSpeed(f.download_speed);
      return spd
        ? `Готов к анализу · ${head} · качается ${spd}`
        : `Готов к анализу · ${head}`;
    }
    if ((f.downloaded_bytes ?? 0) < (f.length ?? 0) * 0.995) {
      return `Готов к анализу · ${head}`;
    }
  }
  if (f.completed) return "Скачан";
  if (f.download_speed && f.download_speed > 0) {
    const spd = formatSpeed(f.download_speed);
    return spd
      ? `Качается · ${formatBytes(f.downloaded_bytes)} · ${spd}`
      : `Качается · ${formatBytes(f.downloaded_bytes)}`;
  }
  if (f.downloaded_bytes > 0) {
    return `Частично · ${formatBytes(f.downloaded_bytes)} / ${formatBytes(f.length)}`;
  }
  return "Не скачан";
}

export function fileBasename(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function videoFiles(files: TorrentMediaFile[]) {
  return files.filter((f) => f.kind === "video");
}

export function audioFiles(files: TorrentMediaFile[]) {
  return files.filter((f) => f.kind === "audio");
}

export function playableFiles(files: TorrentMediaFile[]) {
  return files.filter((f) => f.kind === "video" || f.kind === "audio");
}

/** Previous/next playable file in torrent list order (video + audio). */
export function adjacentPlayableFile(
  files: TorrentMediaFile[],
  currentFileId: number,
  direction: -1 | 1,
): TorrentMediaFile | null {
  const list = playableFiles(files);
  const idx = list.findIndex((f) => f.id === currentFileId);
  if (idx < 0) return null;
  const next = idx + direction;
  if (next < 0 || next >= list.length) return null;
  return list[next];
}

export function subtitleFiles(files: TorrentMediaFile[]) {
  return files.filter((f) => f.kind === "subtitle");
}

/** Resolve API media paths against the current page origin (nginx → orchestrator). */
export function absoluteMediaUrl(pathOrUrl: string | null | undefined): string {
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) {
    if (typeof window !== "undefined") {
      try {
        const parsed = new URL(pathOrUrl);
        const pageHost = window.location.hostname;
        if (
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
          pageHost !== parsed.hostname
        ) {
          return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
        }
      } catch {
        /* keep original */
      }
    }
    return pathOrUrl;
  }
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

export function toPlayerState(session: PlayResponse): PlayerState {
  const streamUrl = absoluteMediaUrl(session.stream_url);
  const fileIndex = session.file_index;
  const fileName = session.file_name;
  const playbackMode = session.playback_mode ?? "direct";
  const playbackUrl = absoluteMediaUrl(session.playback_url);
  if (fileIndex == null || !fileName) {
    throw new Error("Нет данных о выбранном файле");
  }
  if (playbackMode !== "direct" && !playbackUrl) {
    throw new Error("Нет URL перекодированного потока");
  }
  if (playbackMode === "direct" && !streamUrl) {
    throw new Error("Нет URL потока для выбранного файла");
  }
  return {
    hash: session.hash,
    title: session.title,
    stream_url: streamUrl ?? "",
    file_name: fileName,
    file_index: fileIndex,
    files: session.files,
    playback_mode: playbackMode,
    playback_url: playbackUrl,
    transcode_session_id: session.transcode_session_id,
    direct_playable: session.direct_playable ?? playbackMode === "direct",
    audio_tracks: session.audio_tracks ?? [],
    selected_audio_index: session.selected_audio_index ?? 0,
    duration_sec: session.duration_sec ?? null,
    file_length:
      session.file_length ??
      session.files.find((f) => f.id === fileIndex)?.length ??
      null,
  };
}

export function fileLengthBytesFromState(state: PlayerState): number {
  if (state.file_length != null && state.file_length > 0) return state.file_length;
  const f = state.files.find((x) => x.id === state.file_index);
  return f?.length ?? 0;
}

/** When ffprobe only saw a partial download, infer duration from torrent file size. */
export function resolveFileDurationSec(
  apiDurationSec: number | null | undefined,
  fileLengthBytes: number,
): number {
  const api = apiDurationSec != null && apiDurationSec > 0 ? apiDurationSec : 0;
  if (fileLengthBytes <= 0) return api;
  const megabytes = fileLengthBytes / (1024 * 1024);
  const estimate = megabytes * 2;
  if (api <= 0) return estimate;
  if (api < 120 && estimate > api * 2.5) return estimate;
  if (fileLengthBytes > 100 * 1024 * 1024 && api < 300 && estimate > api) return estimate;
  return Math.max(api, estimate);
}

export function formatPlaybackTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
