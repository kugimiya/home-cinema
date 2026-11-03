import type { TorrentMode } from "./modes.js";
import { loadNativeAddon } from "./native-binding.js";
import { nativeSessionConfigJson } from "./native-init.js";
import { settings } from "./config.js";

export type TorrentDetail = Record<string, unknown>;

export interface SessionManager {
  drainAlerts(limit?: number): Promise<unknown[]>;
  sessionStatus(): Promise<Record<string, unknown>>;
  addTorrentBytes(
    data: Buffer,
    title: string,
    opts?: { magnet?: string; saveToDb?: boolean },
  ): Promise<TorrentDetail>;
  addTorrent(link: string, title: string, saveToDb?: boolean): Promise<TorrentDetail>;
  listTorrents(): Promise<TorrentDetail[]>;
  getTorrent(infoHash: string): Promise<TorrentDetail | null>;
  removeTorrent(infoHash: string): Promise<void>;
  setScope(infoHash: string, fileIds: number[]): Promise<void>;
  setMode(infoHash: string, mode: TorrentMode): Promise<void>;
  heartbeat(infoHash: string, fileIds: number[], streamActive: boolean): Promise<void>;
  tickModes(): Promise<void>;
  flushPersistence(): Promise<void>;
  readFileRange(
    infoHash: string,
    fileIndex: number,
    start: number,
    end: number,
    timeout?: number,
  ): Promise<Buffer>;
}

class NativeSessionManager implements SessionManager {
  private readonly native = loadNativeAddon();

  constructor() {
    this.native.initSession(nativeSessionConfigJson(), settings.savePath);
    this.native.ping();
  }

  async drainAlerts(limit = 100): Promise<unknown[]> {
    const res = this.native.drainAlerts(limit) as { alerts: unknown[] };
    return res.alerts ?? [];
  }

  async sessionStatus(): Promise<Record<string, unknown>> {
    return this.native.sessionStatus();
  }

  async addTorrentBytes(
    data: Buffer,
    title: string,
    opts: { magnet?: string; saveToDb?: boolean } = {},
  ): Promise<TorrentDetail> {
    return this.native.addTorrentBytes(
      data,
      title,
      opts.magnet ?? "",
      opts.saveToDb ?? true,
    ) as TorrentDetail;
  }

  async addTorrent(link: string, title: string, saveToDb = true): Promise<TorrentDetail> {
    return this.native.addTorrent(link, title, saveToDb) as TorrentDetail;
  }

  async listTorrents(): Promise<TorrentDetail[]> {
    return this.native.listTorrents() as TorrentDetail[];
  }

  async getTorrent(infoHash: string): Promise<TorrentDetail | null> {
    const detail = this.native.getTorrent(infoHash.toLowerCase()) as TorrentDetail;
    if (!detail || Object.keys(detail).length === 0) return null;
    return detail;
  }

  async removeTorrent(infoHash: string): Promise<void> {
    this.native.removeTorrent(infoHash.toLowerCase());
  }

  async setScope(infoHash: string, fileIds: number[]): Promise<void> {
    this.native.setScope(infoHash.toLowerCase(), fileIds);
  }

  async setMode(infoHash: string, mode: TorrentMode): Promise<void> {
    this.native.setMode(infoHash.toLowerCase(), mode);
  }

  async heartbeat(infoHash: string, fileIds: number[], streamActive: boolean): Promise<void> {
    this.native.heartbeat(infoHash.toLowerCase(), fileIds, streamActive);
  }

  async tickModes(): Promise<void> {
    this.native.tickModes();
  }

  async flushPersistence(): Promise<void> {
    this.native.flushPersistence();
  }

  async readFileRange(
    infoHash: string,
    fileIndex: number,
    start: number,
    end: number,
    timeout = 60,
  ): Promise<Buffer> {
    return this.native.readFileRange(
      infoHash.toLowerCase(),
      fileIndex,
      start,
      end,
      timeout,
    );
  }
}

let manager: SessionManager | null = null;

export function getManager(): SessionManager {
  if (!manager) manager = new NativeSessionManager();
  return manager;
}

export function setManagerForTests(m: SessionManager | null): void {
  manager = m;
}
