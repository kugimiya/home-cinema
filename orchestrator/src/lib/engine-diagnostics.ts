import type { ActivityTracker } from "./activity-tracker.js";
import type {
  EngineAlertEntry,
  EngineDiagnosticsResponse,
  EngineOrchestratorSnapshot,
  EngineSessionStatus,
  EngineTorrentFileLive,
  EngineTorrentLive,
} from "./models.js";
import type { ProbeWarmManager } from "./probe-warm.js";
import type { TranscodeSessionManager } from "./transcode-sessions.js";
import { fetchJson, fetchWithTimeout, HttpError } from "./fetch-json.js";

export async function fetchEngineDiagnostics(opts: {
  torrentEngineUrl: string;
  activity: ActivityTracker;
  transcodeMgr: TranscodeSessionManager;
  probeWarm: ProbeWarmManager;
  alertLimit?: number;
}): Promise<EngineDiagnosticsResponse> {
  const base = opts.torrentEngineUrl.replace(/\/$/, "");
  const alertLimit = opts.alertLimit ?? 120;
  let session: EngineSessionStatus | null = null;
  let torrents: EngineTorrentLive[] = [];
  let alerts: EngineAlertEntry[] = [];
  let engineError: string | null = null;

  try {
    session = (await fetchJson(`${base}/v1/session/status`, {
      timeoutMs: 15_000,
    })) as EngineSessionStatus;
  } catch (e) {
    engineError = String(e instanceof HttpError ? e.message : e);
  }

  if (!engineError) {
    try {
      const rawList = await fetchJson<unknown>(`${base}/v1/torrents`, { timeoutMs: 15_000 });
      if (Array.isArray(rawList)) {
        torrents = rawList.map((item) => torrentFromEngine(item as Record<string, unknown>));
      }
    } catch (e) {
      engineError = String(e instanceof HttpError ? e.message : e);
    }
  }

  if (!engineError) {
    try {
      const r = await fetchWithTimeout(`${base}/v1/alerts?limit=${alertLimit}`, {
        timeoutMs: 15_000,
      });
      const data = (await r.json()) as { alerts?: unknown };
      const rawAlerts = data.alerts;
      if (Array.isArray(rawAlerts)) {
        alerts = rawAlerts as EngineAlertEntry[];
      }
    } catch (e) {
      engineError = String(e instanceof HttpError ? e.message : e);
    }
  }

  const act = opts.activity.snapshot();
  const warm = opts.probeWarm.activitySnapshot();
  const tcCount = await opts.transcodeMgr.sessionCount();

  const orchestrator: EngineOrchestratorSnapshot = {
    activity_label: act.label,
    activity_detail: act.detail,
    transcode_sessions: tcCount,
    transcode_max: opts.transcodeMgr.maxSessions,
    warm_probe_active: warm.active,
    warm_probe_detail: warm.detail,
    warm_probe_queue: warm.queue_size,
  };

  return {
    session: session ?? undefined,
    torrents,
    alerts,
    orchestrator,
    engine_error: engineError,
    polled_at: new Date().toISOString(),
  };
}

function torrentFromEngine(item: Record<string, unknown>): EngineTorrentLive {
  const filesRaw = item.file_stats;
  const files: EngineTorrentFileLive[] = [];
  if (Array.isArray(filesRaw)) {
    for (const f of filesRaw) {
      if (typeof f !== "object" || f === null) continue;
      const row = f as Record<string, unknown>;
      files.push({
        id: parseInt(String(row.id ?? 0), 10),
        path: String(row.path ?? ""),
        length: parseInt(String(row.length ?? 0), 10),
        downloaded_bytes: parseInt(String(row.downloaded_bytes ?? 0), 10),
        completed: Boolean(row.completed),
        priority: parseInt(String(row.priority ?? 0), 10),
      });
    }
  }
  return {
    hash: String(item.hash ?? "").toLowerCase(),
    title: String(item.title ?? ""),
    stat_string: item.stat_string != null ? String(item.stat_string) : null,
    mode: item.mode != null ? String(item.mode) : null,
    torrent_size: optionalInt(item.torrent_size),
    loaded_size: optionalInt(item.loaded_size),
    download_speed: optionalFloat(item.download_speed),
    upload_speed: optionalFloat(item.upload_speed),
    total_peers: optionalInt(item.total_peers),
    connected_seeders: optionalInt(item.connected_seeders),
    bytes_written_data: optionalInt(item.bytes_written_data),
    all_time_download: optionalInt(item.all_time_download),
    has_metadata: item.has_metadata as boolean | undefined,
    is_seeding: item.is_seeding as boolean | undefined,
    is_finished: item.is_finished as boolean | undefined,
    is_paused: item.is_paused as boolean | undefined,
    progress: optionalFloat(item.progress),
    num_connections: optionalInt(item.num_connections),
    error: item.error != null ? String(item.error) : null,
    save_path: item.save_path != null ? String(item.save_path) : null,
    torrent_name: item.torrent_name != null ? String(item.torrent_name) : null,
    scope_file_ids: (item.scope_file_ids as number[]) ?? [],
    last_heartbeat_age_sec: optionalFloat(item.last_heartbeat_age_sec),
    sequential_download: item.sequential_download as boolean | undefined,
    pieces_total: optionalInt(item.pieces_total),
    pieces_have: optionalInt(item.pieces_have),
    piece_length: optionalInt(item.piece_length),
    file_stats: files,
  };
}

function optionalInt(v: unknown): number | null {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function optionalFloat(v: unknown): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
