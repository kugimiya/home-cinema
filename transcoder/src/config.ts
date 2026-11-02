export type Settings = {
  torrentsPath: string;
  workDir: string;
  maxSessions: number;
  host: string;
  port: number;
  torrentEngineUrl: string;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadSettings(): Settings {
  return {
    torrentsPath: process.env.TR_TORRENTS_PATH ?? "/torrents",
    workDir: process.env.TR_WORK_DIR ?? "/transcode",
    maxSessions: envInt("TR_MAX_SESSIONS", 4),
    host: process.env.TR_HOST ?? "0.0.0.0",
    port: envInt("TR_PORT", 8091),
    torrentEngineUrl:
      process.env.TR_TORRENT_ENGINE_URL ?? "http://torrent-engine:8090",
  };
}
