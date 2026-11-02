import type { ActivitySnapshot, ActivityTracker } from "./activity-tracker.js";
import type { DockerControl } from "./docker-control.js";
import type { ServiceState, ServiceStatus, SystemStatusResponse } from "./models.js";
import type { ProbeWarmManager } from "./probe-warm.js";
import type { TorrentStateCache } from "./torrent-cache.js";
import type { TranscodeSessionManager } from "./transcode-sessions.js";
import { extractFiles } from "./torrent-files.js";
import { fetchWithTimeout } from "./fetch-json.js";

export const TORRENT_ENGINE_LIST_MAX_AGE_STATUS = 30;

export function truncateActivity(s: string, n = 40): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

async function probeHttp(url: string, path = ""): Promise<[boolean, number, string | null]> {
  const target = `${url.replace(/\/$/, "")}${path}`;
  const start = performance.now() / 1000;
  try {
    const r = await fetchWithTimeout(target, { timeoutMs: 3000 });
    const elapsed = performance.now() / 1000 - start;
    if (r.status >= 500) return [false, elapsed, `HTTP ${r.status}`];
    return [true, elapsed, null];
  } catch (e) {
    return [false, performance.now() / 1000 - start, String(e)];
  }
}

function torrentEngineActivity(
  items: Array<Record<string, unknown>>,
  cacheAge: number | null,
): string {
  const n = items.length;
  let active = 0;
  let waiting = 0;
  for (const item of items) {
    const speed = item.download_speed ?? 0;
    try {
      if (parseFloat(String(speed)) > 0) {
        active++;
        continue;
      }
    } catch {
      /* ignore */
    }
    if (!extractFiles(item).length) waiting++;
  }
  const parts: string[] = [];
  if (active) parts.push(`Качает ${active} раздач(и)`);
  if (waiting) parts.push(`метаданные: ${waiting}`);
  if (!parts.length) parts.push("Свободен");
  parts.push(`${n} торрентов`);
  if (cacheAge != null) parts.push(`list ${cacheAge.toFixed(0)}s назад`);
  return parts.join(" · ");
}

function orchestratorActivity(
  activity: ActivitySnapshot,
  transcodeCount: number,
  transcodeMax: number,
  listInProgress: boolean,
  warmDetail: string | null,
  warmQueue: number,
): string {
  const parts: string[] = [];
  if (transcodeCount) parts.push(`Transcode ${transcodeCount}/${transcodeMax}`);
  if (activity.label === "warm_probe") {
    const detail = activity.detail ?? warmDetail;
    parts.push(detail ? `Прогрев probe: ${detail}` : "Прогрев probe");
  } else if (activity.label) {
    parts.push(`${activity.label}${activity.detail ? ` (${activity.detail})` : ""}`);
  } else if (warmDetail) {
    parts.push(`Прогрев probe: ${warmDetail}`);
  } else if (warmQueue > 0) {
    parts.push(`Прогрев probe: очередь ${warmQueue}`);
  } else if (listInProgress) {
    parts.push("torrent-engine: list");
  }
  return parts.length ? parts.join(" · ") : "Свободен";
}

export async function buildSystemStatus(opts: {
  torrentEngineUrl: string;
  torapiUrl: string;
  torrentCache: TorrentStateCache;
  activity: ActivityTracker;
  transcodeMgr: TranscodeSessionManager;
  docker: DockerControl;
  probeWarm: ProbeWarmManager;
  lastSearchQuery: string | null;
  lastSearchAt: number | null;
}): Promise<SystemStatusResponse> {
  const [engineOk, engineElapsed, engineErr] = await probeHttp(opts.torrentEngineUrl, "/");
  const [torapiOk, torapiElapsed, torapiErr] = await probeHttp(
    opts.torapiUrl,
    "/api/provider/list",
  );

  let items: Array<Record<string, unknown>> = [];
  let cacheAge = opts.torrentCache.snapshotAgeSec();
  if (engineOk) {
    try {
      const snapshot = await opts.torrentCache.listSnapshot({
        maxAge: TORRENT_ENGINE_LIST_MAX_AGE_STATUS,
      });
      items = [...snapshot.values()];
      cacheAge = opts.torrentCache.snapshotAgeSec();
    } catch {
      /* ignore */
    }
  }

  const act = opts.activity.snapshot();
  const tcCount = await opts.transcodeMgr.sessionCount();
  const warmSnap = opts.probeWarm.activitySnapshot();

  let engineState: ServiceState = "down";
  if (engineOk) {
    engineState = engineElapsed > 2 ? "degraded" : "ok";
    const anyDl = items.some((it) => {
      const v = it.download_speed;
      try {
        return parseFloat(String(v ?? 0)) > 0;
      } catch {
        return false;
      }
    });
    if (anyDl && engineState === "ok") engineState = "busy";
  }

  let torapiState: ServiceState = "down";
  if (torapiOk) torapiState = torapiElapsed > 2 ? "degraded" : "ok";
  if (act.label === "search" && torapiState !== "down") torapiState = "busy";

  let orchState: ServiceState = "ok";
  if (act.label || tcCount || opts.torrentCache.listFetchInProgress || warmSnap.active) {
    orchState = "busy";
  }

  let torapiActivity = "Свободен";
  if (act.label === "search" && act.detail) {
    torapiActivity = `Поиск: "${act.detail}"`;
  } else if (!torapiOk) {
    torapiActivity = `Недоступен: ${torapiErr ?? "ошибка"}`;
  } else if (opts.lastSearchQuery && opts.lastSearchAt) {
    const ageMin = Math.max(0, Math.floor((Date.now() / 1000 - opts.lastSearchAt) / 60));
    torapiActivity = `Последний поиск: «${truncateActivity(opts.lastSearchQuery)}» (${ageMin} мин назад)`;
  }

  const services: ServiceStatus[] = [
    {
      id: "torrent-engine",
      label: "Torrent engine",
      state: engineState,
      activity: engineOk
        ? torrentEngineActivity(items, cacheAge)
        : `Недоступен: ${engineErr ?? "ошибка"}`,
      restart_allowed: opts.docker.restartAllowed("torrent-engine"),
    },
    {
      id: "torapi",
      label: "TorAPI",
      state: torapiState,
      activity: torapiActivity,
      restart_allowed: opts.docker.restartAllowed("torapi"),
    },
    {
      id: "orchestrator",
      label: "Orchestrator",
      state: orchState,
      activity: orchestratorActivity(
        act,
        tcCount,
        opts.transcodeMgr.maxSessions,
        opts.torrentCache.listFetchInProgress,
        warmSnap.detail,
        warmSnap.queue_size,
      ),
      restart_allowed: opts.docker.restartAllowed("orchestrator"),
    },
  ];

  return {
    services,
    polled_at: new Date().toISOString(),
  };
}
