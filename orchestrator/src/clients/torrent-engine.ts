import { rmSync } from "node:fs";
import { join } from "node:path";
import { fetchJson, fetchWithTimeout, HttpError } from "../lib/fetch-json.js";
import {
  extractFiles,
  infoHashFromMagnet,
  PRIORITY_STREAM,
} from "../lib/torrent-files.js";

export class TorrentEngineClient {
  readonly baseUrl: string;
  readonly publicBaseUrl: string;
  readonly torrentsSavePath: string;
  readonly metadataTimeout: number;
  readonly requestTimeout: number;
  readonly listTimeout: number;
  readonly connectionsLimit: number;
  readonly priorityConcurrency: number;

  constructor(
    baseUrl: string,
    opts: {
      publicBaseUrl: string;
      torrentsSavePath: string;
      metadataTimeout: number;
      requestTimeout?: number;
      listTimeout?: number;
      connectionsLimit?: number;
      priorityConcurrency?: number;
    },
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, "");
    this.torrentsSavePath = opts.torrentsSavePath;
    this.metadataTimeout = opts.metadataTimeout;
    this.requestTimeout = opts.requestTimeout ?? 120;
    this.listTimeout = opts.listTimeout ?? 45;
    this.connectionsLimit = Math.max(
      10,
      Math.min(500, opts.connectionsLimit ?? 500),
    );
    this.priorityConcurrency = Math.max(
      1,
      Math.min(16, opts.priorityConcurrency ?? 4),
    );
  }

  async waitReady(attempts = 30, delay = 2): Promise<void> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetchWithTimeout(`${this.baseUrl}/health`, { timeoutMs: 5000 });
        if (r.status === 200) return;
      } catch (e) {
        last = e;
      }
      await sleep(delay * 1000);
    }
    if (last) throw last;
    throw new Error("torrent-engine not ready");
  }

  async bootstrapDiskSettings(): Promise<void> {
    console.info(
      `torrent-engine: disk path=${this.torrentsSavePath} (configured in engine)`,
    );
  }

  async addTorrent(
    link: string,
    title: string,
    saveToDb = true,
  ): Promise<Record<string, unknown>> {
    return fetchJson(`${this.baseUrl}/v1/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link, title, save_to_db: saveToDb }),
      timeoutMs: this.requestTimeout * 1000,
    });
  }

  async addTorrentBytes(
    data: Buffer,
    title: string,
    opts: { magnet?: string; saveToDb?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    return fetchJson(`${this.baseUrl}/v1/torrents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        save_to_db: opts.saveToDb ?? true,
        torrent_b64: data.toString("base64"),
        magnet: opts.magnet ?? "",
      }),
      timeoutMs: this.requestTimeout * 1000,
    });
  }

  async ensureTorrent(
    link: string,
    title: string,
    saveToDb = true,
  ): Promise<Record<string, unknown>> {
    const infoHash = infoHashFromMagnet(link);
    if (infoHash) {
      const existing = await this.findListItem(infoHash);
      if (Object.keys(existing).length > 0) {
        const merged = { ...existing };
        if (!merged.hash) merged.hash = infoHash;
        return merged;
      }
    }
    const added = await this.addTorrent(link, title, saveToDb);
    if (!added.hash && infoHash) added.hash = infoHash;
    return added;
  }

  async getTorrent(infoHash: string): Promise<Record<string, unknown>> {
    const r = await fetchWithTimeout(
      `${this.baseUrl}/v1/torrents/${infoHash.toLowerCase()}`,
      { timeoutMs: this.requestTimeout * 1000 },
    );
    if (r.status === 404) return {};
    if (!r.ok) throw new HttpError(await r.text(), r.status);
    return (await r.json()) as Record<string, unknown>;
  }

  async getCache(infoHash: string): Promise<Record<string, unknown>> {
    const detail = await this.getTorrent(infoHash);
    const files = detail.file_stats;
    if (Array.isArray(files) && files.length > 0) {
      return { _engine_files: files };
    }
    return {};
  }

  async listTorrents(): Promise<Array<Record<string, unknown>>> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/v1/torrents`, {
      timeoutMs: this.listTimeout * 1000,
    });
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  }

  async findListItem(infoHash: string): Promise<Record<string, unknown>> {
    const h = infoHash.toLowerCase();
    for (const item of await this.listTorrents()) {
      if (String(item.hash ?? "").toLowerCase() === h) return item;
    }
    return {};
  }

  async getTorrentStatus(infoHash: string): Promise<Record<string, unknown>> {
    const listed = await this.findListItem(infoHash);
    if (listed && extractFiles(listed).length > 0) return listed;
    const detail = await this.getTorrent(infoHash);
    if (Object.keys(detail).length > 0) return detail;
    return listed;
  }

  async dropTorrent(infoHash: string): Promise<void> {
    await this.removeTorrent(infoHash);
  }

  async removeTorrent(infoHash: string): Promise<void> {
    const r = await fetchWithTimeout(
      `${this.baseUrl}/v1/torrents/${infoHash.toLowerCase()}`,
      { method: "DELETE", timeoutMs: this.requestTimeout * 1000 },
    );
    if (!r.ok) throw new HttpError(await r.text(), r.status);
  }

  async setFilePriority(
    infoHash: string,
    fileIndex: number,
    priority: number,
  ): Promise<void> {
    const h = infoHash.toLowerCase();
    const detail = await this.getTorrent(h);
    const files = extractFiles(detail);
    const active = new Set<number>();
    for (const f of files) {
      const pri = parseInt(String(f.priority ?? 0), 10);
      const fid = parseInt(String(f.id ?? 0), 10);
      if (pri >= PRIORITY_STREAM) active.add(fid);
    }
    if (priority >= PRIORITY_STREAM) active.add(fileIndex);
    else active.delete(fileIndex);
    await this.configureDownloadFiles(h, [...active], files);
  }

  async configureDownloadFiles(
    infoHash: string,
    activeFileIndices: number[],
    _rawFiles?: Array<Record<string, unknown>>,
  ): Promise<void> {
    const h = infoHash.toLowerCase();
    const scopeBody = JSON.stringify({
      file_ids: activeFileIndices.map((i) => parseInt(String(i), 10)),
    });
    const r1 = await fetchWithTimeout(`${this.baseUrl}/v1/torrents/${h}/scope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: scopeBody,
      timeoutMs: this.requestTimeout * 1000,
    });
    if (!r1.ok) throw new HttpError(await r1.text(), r1.status);
    const mode = activeFileIndices.length ? "streaming" : "paused";
    const r2 = await fetchWithTimeout(`${this.baseUrl}/v1/torrents/${h}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      timeoutMs: this.requestTimeout * 1000,
    });
    if (!r2.ok) throw new HttpError(await r2.text(), r2.status);
  }

  async setMode(infoHash: string, mode: string): Promise<void> {
    const r = await fetchWithTimeout(
      `${this.baseUrl}/v1/torrents/${infoHash.toLowerCase()}/mode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
        timeoutMs: this.requestTimeout * 1000,
      },
    );
    if (!r.ok) throw new HttpError(await r.text(), r.status);
  }

  async playbackEnded(infoHash: string, fileIds: number[]): Promise<void> {
    const h = infoHash.toLowerCase();
    await fetchWithTimeout(`${this.baseUrl}/v1/torrents/${h}/scope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: fileIds }),
      timeoutMs: 30_000,
    });
    await fetchWithTimeout(`${this.baseUrl}/v1/torrents/${h}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "completing" }),
      timeoutMs: 30_000,
    });
  }

  async heartbeat(
    infoHash: string,
    fileIds: number[],
    streamActive: boolean,
  ): Promise<void> {
    await fetchWithTimeout(
      `${this.baseUrl}/v1/torrents/${infoHash.toLowerCase()}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: fileIds, stream_active: streamActive }),
        timeoutMs: 15_000,
      },
    );
  }

  async pauseAllFiles(infoHash: string): Promise<void> {
    await this.setMode(infoHash.toLowerCase(), "paused");
    await fetchWithTimeout(
      `${this.baseUrl}/v1/torrents/${infoHash.toLowerCase()}/scope`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: [] }),
        timeoutMs: this.requestTimeout * 1000,
      },
    );
  }

  async waitForFiles(infoHash: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.metadataTimeout * 1000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const st = await this.getTorrent(infoHash);
        if (Object.keys(st).length > 0 && extractFiles(st).length > 0) return st;
      } catch (e) {
        lastError = e;
      }
      await sleep(2000);
    }
    const st = await this.getTorrent(infoHash);
    if (extractFiles(st).length > 0) return st;
    if (lastError) throw new TimeoutError(String(lastError));
    throw new TimeoutError("Timed out waiting for torrent metadata");
  }

  private streamPath(infoHash: string, filePath: string, fileIndex: number): string {
    const encoded = encodeURIComponent(filePath).replace(/%2F/g, "/");
    return `/stream/${encoded}?link=${infoHash.toLowerCase()}&index=${fileIndex}&play`;
  }

  buildStreamUrl(infoHash: string, filePath: string, fileIndex: number): string {
    return `${this.publicBaseUrl}${this.streamPath(infoHash, filePath, fileIndex)}`;
  }

  buildInternalStreamUrl(
    infoHash: string,
    filePath: string,
    fileIndex: number,
  ): string {
    return `${this.baseUrl}/v1/torrents/${infoHash.toLowerCase()}/files/${fileIndex}/stream`;
  }

  deleteCacheDir(infoHash: string): void {
    const path = join(this.torrentsSavePath, infoHash.toLowerCase());
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function buildTorrentEngineClient(settings: {
  torrentEngineUrl: string;
  torrentEnginePublicUrl: string;
  torrentEngineSavePath: string;
  playMetadataTimeout: number;
  torrentEngineRequestTimeout: number;
  torrentEngineListTimeout: number;
  torrentEngineConnectionsLimit: number;
  torrentEnginePriorityConcurrency: number;
}): TorrentEngineClient {
  return new TorrentEngineClient(settings.torrentEngineUrl, {
    publicBaseUrl: settings.torrentEnginePublicUrl,
    torrentsSavePath: settings.torrentEngineSavePath,
    metadataTimeout: settings.playMetadataTimeout,
    requestTimeout: settings.torrentEngineRequestTimeout,
    listTimeout: settings.torrentEngineListTimeout,
    connectionsLimit: settings.torrentEngineConnectionsLimit,
    priorityConcurrency: settings.torrentEnginePriorityConcurrency,
  });
}
