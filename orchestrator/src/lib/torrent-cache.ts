import { extractFiles, infoHashFromMagnet } from "./torrent-files.js";
import { fetchTorrentBytes } from "./torrent-fetch.js";

export type TorrentScope = "list" | "cache" | "files";

export interface TorrentEngineClientLike {
  listTorrents(): Promise<Array<Record<string, unknown>>>;
  getTorrent(infoHash: string): Promise<Record<string, unknown>>;
  getCache(infoHash: string): Promise<Record<string, unknown>>;
  addTorrent(link: string, title: string, saveToDb?: boolean): Promise<Record<string, unknown>>;
  addTorrentBytes(
    data: Buffer,
    title: string,
    opts?: { magnet?: string; saveToDb?: boolean },
  ): Promise<Record<string, unknown>>;
  requestTimeout: number;
}

interface ListSnapshot {
  itemsByHash: Map<string, Record<string, unknown>>;
  fetchedAt: number;
}

interface HashEntry {
  listItem?: Record<string, unknown> | null;
  cachePieces?: Record<string, unknown> | null;
  filesRaw?: Array<Record<string, unknown>> | null;
  listUpdatedAt: number;
  cacheUpdatedAt: number;
  filesUpdatedAt: number;
}

export class TorrentStateCache {
  static LIST_TTL_HOT = 3;
  static LIST_TTL_LIBRARY = 8;
  static CACHE_TTL_ACTIVE = 4;
  static CACHE_TTL_IDLE = 45;

  listFetchInProgress = false;

  private snapshot: ListSnapshot | null = null;
  private entries = new Map<string, HashEntry>();
  private listTask: Promise<Map<string, Record<string, unknown>>> | null = null;
  private cacheTasks = new Map<string, Promise<Record<string, unknown>>>();
  private getTasks = new Map<string, Promise<Record<string, unknown>>>();

  constructor(private readonly client: TorrentEngineClientLike) {}

  snapshotAgeSec(): number | null {
    if (!this.snapshot) return null;
    return performance.now() / 1000 - this.snapshot.fetchedAt;
  }

  invalidateList(): void {
    this.snapshot = null;
  }

  invalidateHash(infoHash: string, scopes?: TorrentScope[]): void {
    const h = infoHash.toLowerCase();
    const all = scopes == null;
    if (all || scopes.includes("list")) {
      const entry = this.entries.get(h);
      if (entry) {
        entry.listItem = null;
        entry.listUpdatedAt = 0;
      }
    }
    if (all || scopes.includes("cache")) {
      const entry = this.entries.get(h) ?? this.newEntry();
      entry.cachePieces = null;
      entry.cacheUpdatedAt = 0;
      this.entries.set(h, entry);
    }
    if (all || scopes.includes("files")) {
      const entry = this.entries.get(h) ?? this.newEntry();
      entry.filesRaw = null;
      entry.filesUpdatedAt = 0;
      this.entries.set(h, entry);
    }
    if (all) this.entries.delete(h);
  }

  removeHash(infoHash: string): void {
    const h = infoHash.toLowerCase();
    this.entries.delete(h);
    if (this.snapshot) this.snapshot.itemsByHash.delete(h);
  }

  async listSnapshot(opts: {
    maxAge?: number | null;
    force?: boolean;
  } = {}): Promise<Map<string, Record<string, unknown>>> {
    const ttl = opts.maxAge ?? TorrentStateCache.LIST_TTL_LIBRARY;
    const now = performance.now() / 1000;
    if (
      !opts.force &&
      this.snapshot &&
      now - this.snapshot.fetchedAt <= ttl
    ) {
      return this.snapshot.itemsByHash;
    }

    let task: Promise<Map<string, Record<string, unknown>>>;
    if (this.listTask) {
      task = this.listTask;
    } else {
      this.listFetchInProgress = true;
      task = this.loadList();
      this.listTask = task;
    }

    try {
      return await task;
    } finally {
      if (this.listTask === task) {
        await task.catch(() => {});
        if (this.listTask === task) {
          this.listTask = null;
          this.listFetchInProgress = false;
        }
      }
    }
  }

  private async loadList(): Promise<Map<string, Record<string, unknown>>> {
    const items = await this.client.listTorrents();
    const byHash = new Map<string, Record<string, unknown>>();
    const now = performance.now() / 1000;
    for (const item of items) {
      const h = String(item.hash ?? "").toLowerCase();
      if (!h) continue;
      byHash.set(h, item);
      const entry = this.entries.get(h) ?? this.newEntry();
      entry.listItem = item;
      entry.listUpdatedAt = now;
      const raw = extractFiles(item);
      if (raw.length > 0) {
        entry.filesRaw = raw;
        entry.filesUpdatedAt = now;
      }
      this.entries.set(h, entry);
    }
    this.snapshot = { itemsByHash: byHash, fetchedAt: now };
    return byHash;
  }

  async findListItem(
    infoHash: string,
    opts: { maxAge?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const h = infoHash.toLowerCase();
    const snapshot = await this.listSnapshot({ maxAge: opts.maxAge });
    return { ...(snapshot.get(h) ?? {}) };
  }

  async getTorrentDetail(
    infoHash: string,
    opts: { maxAgeList?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const h = infoHash.toLowerCase();
    const listed = await this.findListItem(h, {
      maxAge: opts.maxAgeList ?? TorrentStateCache.LIST_TTL_HOT,
    });
    if (Object.keys(listed).length > 0 && extractFiles(listed).length > 0) {
      return listed;
    }

    const entry = this.entries.get(h);
    if (entry?.filesRaw?.length) {
      let base = { ...listed };
      if (extractFiles(base).length === 0 && entry.listItem) {
        base = { ...entry.listItem };
      }
      return base;
    }

    const detail = await this.getTorrentCoalesced(h);
    if (Object.keys(detail).length > 0) {
      const now = performance.now() / 1000;
      const ent = this.entries.get(h) ?? this.newEntry();
      ent.listItem = detail;
      ent.listUpdatedAt = now;
      const raw = extractFiles(detail);
      if (raw.length > 0) {
        ent.filesRaw = raw;
        ent.filesUpdatedAt = now;
      }
      this.entries.set(h, ent);
      return detail;
    }
    if (Object.keys(listed).length > 0 && extractFiles(listed).length === 0) {
      this.invalidateHash(h);
      this.invalidateList();
      return {};
    }
    return listed;
  }

  private getTorrentCoalesced(infoHash: string): Promise<Record<string, unknown>> {
    const h = infoHash.toLowerCase();
    let task = this.getTasks.get(h);
    if (!task) {
      task = this.client.getTorrent(h).finally(() => {
        if (this.getTasks.get(h) === task) this.getTasks.delete(h);
      });
      this.getTasks.set(h, task);
    }
    return task;
  }

  private cacheTtlForItem(listItem: Record<string, unknown>): number {
    if (listItem.stat === 5) return 0;
    const speed = listItem.download_speed ?? 0;
    try {
      if (parseFloat(String(speed)) > 0) return TorrentStateCache.CACHE_TTL_ACTIVE;
    } catch {
      /* ignore */
    }
    return TorrentStateCache.CACHE_TTL_IDLE;
  }

  async getCachePieces(
    infoHash: string,
    opts: {
      listItem?: Record<string, unknown> | null;
      force?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    const h = infoHash.toLowerCase();
    let listItem = opts.listItem;
    if (!listItem) listItem = await this.findListItem(h);
    if (listItem.stat === 5) return {};

    const ttl = this.cacheTtlForItem(listItem);
    if (ttl <= 0) return {};

    const now = performance.now() / 1000;
    const entry = this.entries.get(h) ?? this.newEntry();
    if (
      !opts.force &&
      entry.cachePieces != null &&
      now - entry.cacheUpdatedAt <= ttl
    ) {
      return entry.cachePieces;
    }

    let task = this.cacheTasks.get(h);
    if (!task) {
      task = this.fetchCache(h).finally(() => {
        if (this.cacheTasks.get(h) === task) this.cacheTasks.delete(h);
      });
      this.cacheTasks.set(h, task);
    }

    const data = await task;
    entry.cachePieces = data;
    entry.cacheUpdatedAt = performance.now() / 1000;
    this.entries.set(h, entry);
    return data;
  }

  private async fetchCache(infoHash: string): Promise<Record<string, unknown>> {
    try {
      const data = await Promise.race([
        this.client.getCache(infoHash),
        new Promise<Record<string, unknown>>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 12_000),
        ),
      ]);
      return typeof data === "object" && data !== null ? data : {};
    } catch {
      return {};
    }
  }

  async listItems(opts: {
    maxAge?: number | null;
    force?: boolean;
  } = {}): Promise<Array<Record<string, unknown>>> {
    const snapshot = await this.listSnapshot(opts);
    return [...snapshot.values()];
  }

  async ensureTorrentLookup(infoHash: string): Promise<Record<string, unknown>> {
    return this.findListItem(infoHash, { maxAge: TorrentStateCache.LIST_TTL_LIBRARY });
  }

  async ensureTorrent(
    link: string,
    title: string,
    saveToDb = true,
    torrentUrl?: string | null,
  ): Promise<Record<string, unknown>> {
    const infoHash = infoHashFromMagnet(link);
    let existing: Record<string, unknown> = {};
    if (infoHash) {
      try {
        existing = await this.ensureTorrentLookup(infoHash);
      } catch {
        existing = {};
      }
      if (Object.keys(existing).length > 0 && extractFiles(existing).length > 0) {
        const merged = { ...existing };
        if (!merged.hash) merged.hash = infoHash;
        return merged;
      }
    }

    const addFromUrl = async (): Promise<Record<string, unknown> | null> => {
      if (!torrentUrl) return null;
      const data = await fetchTorrentBytes(torrentUrl, {
        timeout: Math.min(45, this.client.requestTimeout),
      });
      if (!data) return null;
      const added = await this.client.addTorrentBytes(data, title, {
        magnet: link,
        saveToDb,
      });
      this.invalidateList();
      const h = String(added.hash ?? infoHash ?? "").toLowerCase();
      if (h) this.invalidateHash(h, ["list", "cache", "files"]);
      if (!added.hash && infoHash) added.hash = infoHash;
      return added;
    };

    if (Object.keys(existing).length > 0 && extractFiles(existing).length === 0) {
      const upgraded = await addFromUrl();
      if (upgraded) return upgraded;
      const merged = { ...existing };
      if (!merged.hash && infoHash) merged.hash = infoHash;
      return merged;
    }

    const upgraded = await addFromUrl();
    if (upgraded) return upgraded;

    const added = await this.client.addTorrent(link, title, saveToDb);
    this.invalidateList();
    const h = String(added.hash ?? infoHash ?? "").toLowerCase();
    if (h) this.invalidateHash(h, ["list", "cache", "files"]);
    if (!added.hash && infoHash) added.hash = infoHash;
    return added;
  }

  private newEntry(): HashEntry {
    return {
      listUpdatedAt: 0,
      cacheUpdatedAt: 0,
      filesUpdatedAt: 0,
    };
  }
}
