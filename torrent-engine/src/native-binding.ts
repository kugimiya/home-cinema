import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export type NativeLt = {
  initSession(configJson: string, savePath: string): void;
  ping(): { status: string };
  drainAlerts(limit: number): { alerts: unknown[] };
  sessionStatus(): Record<string, unknown>;
  addTorrent(link: string, title: string, saveToDb: boolean): Record<string, unknown>;
  addTorrentBytes(
    data: Buffer,
    title: string,
    magnet: string,
    saveToDb: boolean,
  ): Record<string, unknown>;
  listTorrents(): Record<string, unknown>[];
  getTorrent(infoHash: string): Record<string, unknown>;
  removeTorrent(infoHash: string): void;
  setScope(infoHash: string, fileIds: number[]): void;
  setMode(infoHash: string, mode: string): void;
  heartbeat(infoHash: string, fileIds: number[], streamActive: boolean): void;
  tickModes(): void;
  flushPersistence(): void;
  readFileRange(
    infoHash: string,
    fileIndex: number,
    start: number,
    end: number,
    timeout: number,
  ): Promise<Buffer>;
};

function addonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "build", "Release", "lt_session.node"),
    join(here, "..", "build", "Debug", "lt_session.node"),
    join(process.cwd(), "build", "Release", "lt_session.node"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]!;
}

let cached: NativeLt | null = null;

export function loadNativeAddon(): NativeLt {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  cached = require(addonPath()) as NativeLt;
  return cached;
}
