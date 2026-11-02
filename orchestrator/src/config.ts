import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

function envStr(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface Settings {
  torapiUrl: string;
  torrentEngineUrl: string;
  torrentEnginePublicUrl: string;
  transcoderUrl: string;
  transcoderEnabled: boolean;
  completeScope: string;
  torrentEngineSavePath: string;
  databasePath: string;
  searchTimeout: number;
  playMetadataTimeout: number;
  torrentEngineRequestTimeout: number;
  torrentEngineListTimeout: number;
  torrentEngineConnectionsLimit: number;
  torrentEnginePriorityConcurrency: number;
  orchestratorPublicUrl: string;
  transcodeEnabled: boolean;
  transcodeWorkDir: string;
  transcodeMaxSessions: number;
  transcodeSessionTtlSec: number;
  transcodeAllowHevcDirect: boolean;
  transcodeProbeTimeout: number;
  transcodeProbeRetries: number;
  transcodeProbeRetryDelay: number;
  probeWarmBytes: number;
  probeWarmFiles: number;
  probeWarmManualFiles: number;
  probeWarmConcurrency: number;
  serviceRestartEnabled: boolean;
  dockerSocketPath: string;
  dockerContainerTorrentEngine: string;
  dockerContainerTranscoder: string;
  dockerContainerTorapi: string;
  dockerContainerOrchestrator: string;
  discoveryMdnsEnabled: boolean;
  orchestratorListenPort: number;
}

export function loadSettings(): Settings {
  return {
    torapiUrl: envStr("TORAPI_URL", "http://torapi:8443"),
    torrentEngineUrl: envStr("TORRENT_ENGINE_URL", "http://torrent-engine:8090"),
    torrentEnginePublicUrl: envStr(
      "TORRENT_ENGINE_PUBLIC_URL",
      "http://localhost:3000",
    ),
    transcoderUrl: envStr("TRANSCODER_URL", "http://transcoder:8091"),
    transcoderEnabled: envBool("TRANSCODER_ENABLED", true),
    completeScope: envStr("COMPLETE_SCOPE", "active_only"),
    torrentEngineSavePath: envStr("TORRENT_ENGINE_SAVE_PATH", "/torrents"),
    databasePath: envStr("DATABASE_PATH", "/data/orchestrator.sqlite3"),
    searchTimeout: envFloat("SEARCH_TIMEOUT", 60),
    playMetadataTimeout: envFloat("PLAY_METADATA_TIMEOUT", 180),
    torrentEngineRequestTimeout: envFloat("TORRENT_ENGINE_REQUEST_TIMEOUT", 120),
    torrentEngineListTimeout: envFloat("TORRENT_ENGINE_LIST_TIMEOUT", 45),
    torrentEngineConnectionsLimit: envInt("TORRENT_ENGINE_CONNECTIONS_LIMIT", 500),
    torrentEnginePriorityConcurrency: envInt(
      "TORRENT_ENGINE_PRIORITY_CONCURRENCY",
      4,
    ),
    orchestratorPublicUrl: envStr("ORCHESTRATOR_PUBLIC_URL", "http://localhost:3000"),
    transcodeEnabled: envBool("TRANSCODE_ENABLED", true),
    transcodeWorkDir: envStr("TRANSCODE_WORK_DIR", "/tmp/transcode"),
    transcodeMaxSessions: envInt("TRANSCODE_MAX_SESSIONS", 4),
    transcodeSessionTtlSec: envInt("TRANSCODE_SESSION_TTL_SEC", 300),
    transcodeAllowHevcDirect: envBool("TRANSCODE_ALLOW_HEVC_DIRECT", false),
    transcodeProbeTimeout: envFloat("TRANSCODE_PROBE_TIMEOUT", 45),
    transcodeProbeRetries: envInt("TRANSCODE_PROBE_RETRIES", 6),
    transcodeProbeRetryDelay: envFloat("TRANSCODE_PROBE_RETRY_DELAY", 3),
    probeWarmBytes: envInt("PROBE_WARM_BYTES", 4_194_304),
    probeWarmFiles: envInt("PROBE_WARM_FILES", 2),
    probeWarmManualFiles: envInt("PROBE_WARM_MANUAL_FILES", -1),
    probeWarmConcurrency: envInt("PROBE_WARM_CONCURRENCY", 1),
    serviceRestartEnabled: envBool("SERVICE_RESTART_ENABLED", false),
    dockerSocketPath: envStr("DOCKER_SOCKET_PATH", "/var/run/docker.sock"),
    dockerContainerTorrentEngine: envStr(
      "DOCKER_CONTAINER_TORRENT_ENGINE",
      "home-cinema-torrent-engine",
    ),
    dockerContainerTranscoder: envStr(
      "DOCKER_CONTAINER_TRANSCODER",
      "home-cinema-transcoder",
    ),
    dockerContainerTorapi: envStr("DOCKER_CONTAINER_TORAPI", "home-cinema-torapi"),
    dockerContainerOrchestrator: envStr(
      "DOCKER_CONTAINER_ORCHESTRATOR",
      "home-cinema-orchestrator",
    ),
    discoveryMdnsEnabled: envBool("DISCOVERY_MDNS_ENABLED", false),
    orchestratorListenPort: envInt("ORCHESTRATOR_LISTEN_PORT", 8080),
  };
}
