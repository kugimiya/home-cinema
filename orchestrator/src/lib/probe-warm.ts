import { basename } from "node:path";
import type { TorrentEngineClient } from "../clients/torrent-engine.js";
import type { ActivityTracker } from "./activity-tracker.js";
import { progressFromCache } from "./file-progress.js";
import { mediaKindForPath } from "./media-files.js";
import type { TorrentFileStat, TorrentMediaFile, WarmStatus } from "./models.js";
import { ensureHeadFile } from "./probe-head.js";
import { fetchWithTimeout } from "./fetch-json.js";

export interface FileWarmState {
  status: WarmStatus;
  warmed_bytes: number;
  target_bytes: number;
  error: string | null;
  path: string;
  updated_at: number;
}

interface WarmQueueItem {
  info_hash: string;
  file_id: number;
  path: string;
  length: number;
  target_bytes: number;
}

export interface WarmActivitySnapshot {
  active: boolean;
  detail: string | null;
  queue_size: number;
}

export function selectAutoVideoIds(
  catalog: TorrentMediaFile[],
  currentFileId: number,
  limit: number,
): number[] {
  if (limit === 0) return [];
  const videos = catalog.filter((f) => f.kind === "video").sort((a, b) => a.id - b.id);
  const ids = videos.map((f) => f.id);
  const idx = ids.indexOf(currentFileId);
  const candidates = idx >= 0 ? ids.slice(idx + 1) : ids;
  if (limit < 0) return candidates;
  return candidates.slice(0, limit);
}

export function selectManualVideoIds(
  rawFiles: Array<Record<string, unknown>>,
  limit: number,
  isReady: (hash: string, fid: number, length: number, d: number) => boolean,
  infoHash: string,
): Array<[number, string, number]> {
  if (limit === 0) return [];
  const videos: Array<[number, string, number]> = [];
  for (const f of rawFiles) {
    const path = String(f.path ?? f.Path ?? "");
    if (mediaKindForPath(path) !== "video") continue;
    const fid = parseInt(String(f.id ?? f.Id ?? 0), 10);
    if (fid <= 0) continue;
    const length = parseInt(String(f.length ?? f.Length ?? 0), 10);
    if (isReady(infoHash, fid, length, 0)) continue;
    videos.push([fid, path, length]);
  }
  videos.sort((a, b) => a[0] - b[0]);
  if (limit < 0) return videos;
  return videos.slice(0, limit);
}

export function overlayWarmOnStats(
  stats: TorrentFileStat[],
  infoHash: string,
  manager: ProbeWarmManager,
): TorrentFileStat[] {
  if (!manager.enabled) {
    return stats.map((s) => ({
      ...s,
      warm_status: "off" as const,
      warm_bytes: s.warm_bytes ?? 0,
      warm_target_bytes: 0,
    }));
  }
  const h = infoHash.toLowerCase();
  return stats.map((s) => {
    const st = manager.getFileState(h, s.id, s.length, s.downloaded_bytes, s.completed, s.path);
    return {
      ...s,
      warm_status: st.status,
      warm_bytes: st.warmed_bytes,
      warm_target_bytes: st.target_bytes,
    };
  });
}

export function warmSummaryForHash(
  infoHash: string,
  manager: ProbeWarmManager,
  videoCount: number,
): string | null {
  if (!manager.enabled || videoCount <= 0) return null;
  const snap = manager.hashProgress(infoHash);
  if (snap.total <= 0 && snap.queue <= 0) return null;
  const done = snap.ready;
  const total = Math.max(snap.total, videoCount);
  if (snap.active) {
    const cur = snap.current_path ?? "…";
    return `Прогрев ffprobe: ${basename(cur)} (${done}/${total})`;
  }
  if (done >= total) return `Прогрев ffprobe: готово (${done}/${total})`;
  if (snap.queue > 0 || done > 0) return `Прогрев ffprobe: ${done}/${total}`;
  return null;
}

export class ProbeWarmManager {
  readonly warmBytes: number;
  readonly autoFiles: number;
  readonly manualFiles: number;
  readonly concurrency: number;

  private readonly warmTargetFn?: (
    hash: string,
    fid: number,
    path: string,
    length: number,
  ) => number;
  private readonly headDir: string | null;
  private readonly fetchCache: (hash: string) => Promise<Record<string, unknown>>;

  private queue: WarmQueueItem[] = [];
  private workersRunning = 0;
  private started = false;
  private fileStates = new Map<string, FileWarmState>();
  private cancelledHashes = new Set<string>();
  private activeDetail: string | null = null;
  private warmingCount = 0;

  constructor(
    private readonly torrentEngine: TorrentEngineClient,
    private readonly activity: ActivityTracker,
    opts: {
      warmBytes: number;
      autoFiles: number;
      manualFiles: number;
      concurrency: number;
      fetchCache: (hash: string) => Promise<Record<string, unknown>>;
      warmTargetFn?: (hash: string, fid: number, path: string, length: number) => number;
      headDir?: string | null;
    },
  ) {
    this.warmBytes = Math.max(0, opts.warmBytes);
    this.autoFiles = opts.autoFiles;
    this.manualFiles = opts.manualFiles;
    this.concurrency = Math.max(1, Math.min(8, opts.concurrency));
    this.fetchCache = opts.fetchCache;
    this.warmTargetFn = opts.warmTargetFn;
    this.headDir = opts.headDir ?? null;
  }

  get enabled(): boolean {
    return this.warmBytes > 0;
  }

  private key(infoHash: string, fileId: number): string {
    return `${infoHash.toLowerCase()}:${fileId}`;
  }

  private getState(infoHash: string, fileId: number): FileWarmState {
    const k = this.key(infoHash, fileId);
    if (!this.fileStates.has(k)) {
      this.fileStates.set(k, {
        status: "idle",
        warmed_bytes: 0,
        target_bytes: this.warmBytes,
        error: null,
        path: "",
        updated_at: 0,
      });
    }
    return this.fileStates.get(k)!;
  }

  private resolveTarget(infoHash: string, fileId: number, path: string, length: number): number {
    if (!this.enabled) return 0;
    let target = this.warmBytes;
    if (this.warmTargetFn) target = Math.max(0, this.warmTargetFn(infoHash, fileId, path, length));
    if (target <= 0) return 0;
    if (length <= 0) return target;
    return Math.min(target, length);
  }

  getFileState(
    infoHash: string,
    fileId: number,
    length: number,
    downloadedBytes: number,
    completed: boolean,
    path = "",
  ): FileWarmState {
    const target = this.resolveTarget(infoHash, fileId, path, length);
    if (!this.enabled) {
      return { status: "off", warmed_bytes: 0, target_bytes: 0, error: null, path: "", updated_at: 0 };
    }
    const st = this.getState(infoHash, fileId);
    st.target_bytes = target;
    const effective = Math.max(st.warmed_bytes, downloadedBytes);
    if (completed || effective >= target) {
      st.status = "ready";
      st.warmed_bytes = Math.max(st.warmed_bytes, Math.min(effective, target || effective));
    } else if (!["queued", "warming"].includes(st.status)) {
      st.status = "idle";
    }
    return st;
  }

  isFileReady(infoHash: string, fileId: number, length: number, downloadedBytes: number): boolean {
    const target = this.resolveTarget(infoHash, fileId, "", length);
    if (target <= 0) return true;
    const st = this.getState(infoHash, fileId);
    if (st.status === "ready") return true;
    return Math.max(st.warmed_bytes, downloadedBytes) >= target;
  }

  private ensureStarted(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    for (let i = 0; i < this.concurrency; i++) {
      void this.workerLoop();
    }
  }

  async scheduleAuto(
    infoHash: string,
    catalog: TorrentMediaFile[],
    currentFileId: number,
  ): Promise<number> {
    if (!this.enabled || this.autoFiles === 0) return 0;
    const ids = selectAutoVideoIds(catalog, currentFileId, this.autoFiles);
    return this.enqueueIds(infoHash, catalog, ids);
  }

  async scheduleManual(
    infoHash: string,
    rawFiles: Array<Record<string, unknown>>,
  ): Promise<[number, number]> {
    if (!this.enabled) return [0, 0];
    const h = infoHash.toLowerCase();
    this.cancelledHashes.delete(h);

    let cache: Record<string, unknown> = {};
    try {
      cache = await this.fetchCache(h);
    } catch {
      cache = {};
    }
    const progress = progressFromCache(rawFiles, cache);

    const isReady = (hash_: string, fid: number, length: number) => {
      const prog = progress[fid];
      const downloaded = prog?.downloaded ?? 0;
      const completed = length > 0 && downloaded >= length * 0.995;
      return this.isFileReady(hash_, fid, length, downloaded);
    };

    const items = selectManualVideoIds(rawFiles, this.manualFiles, isReady, h);
    const skipped = Math.max(
      0,
      rawFiles.filter(
        (f) => mediaKindForPath(String(f.path ?? f.Path ?? "")) === "video",
      ).length - items.length,
    );

    let queued = 0;
    this.ensureStarted();
    for (const [fid, path, length] of items) {
      if (await this.enqueueOne(h, fid, path, length)) queued++;
    }
    return [queued, skipped];
  }

  private async enqueueIds(
    infoHash: string,
    catalog: TorrentMediaFile[],
    fileIds: number[],
  ): Promise<number> {
    if (!fileIds.length) return 0;
    const h = infoHash.toLowerCase();
    this.cancelledHashes.delete(h);
    const byId = new Map(catalog.map((f) => [f.id, f]));
    let queued = 0;
    this.ensureStarted();
    for (const fid of fileIds) {
      const f = byId.get(fid);
      if (!f) continue;
      if (await this.enqueueOne(h, f.id, f.path, f.length)) queued++;
    }
    return queued;
  }

  private async enqueueOne(
    infoHash: string,
    fileId: number,
    path: string,
    length: number,
  ): Promise<boolean> {
    if (this.cancelledHashes.has(infoHash)) return false;
    const st = this.getState(infoHash, fileId);
    const target = this.resolveTarget(infoHash, fileId, path, length);
    st.target_bytes = target;
    st.path = path;
    if (target <= 0) return false;
    if (["ready", "warming", "queued"].includes(st.status)) return false;
    st.status = "queued";
    st.updated_at = performance.now() / 1000;
    this.queue.push({
      info_hash: infoHash,
      file_id: fileId,
      path,
      length,
      target_bytes: target,
    });
    return true;
  }

  cancelHash(infoHash: string): void {
    const h = infoHash.toLowerCase();
    this.cancelledHashes.add(h);
    for (const [k, st] of this.fileStates) {
      if (k.startsWith(`${h}:`) && ["queued", "warming"].includes(st.status)) {
        st.status = "idle";
        st.error = null;
      }
    }
  }

  activitySnapshot(): WarmActivitySnapshot {
    if (!this.enabled) return { active: false, detail: null, queue_size: 0 };
    const qsize = this.queue.length;
    const active = this.warmingCount > 0 || qsize > 0;
    let detail = this.activeDetail;
    if (!detail && qsize > 0) detail = `очередь ${qsize}`;
    return { active, detail, queue_size: qsize };
  }

  hashProgress(infoHash: string): {
    ready: number;
    warming: number;
    queue: number;
    total: number;
    active: boolean;
    current_path: string | null;
  } {
    const h = infoHash.toLowerCase();
    let ready = 0;
    let warming = 0;
    let queued = 0;
    let currentPath: string | null = null;
    for (const [k, st] of this.fileStates) {
      if (!k.startsWith(`${h}:`)) continue;
      if (st.status === "ready") ready++;
      else if (st.status === "warming") {
        warming++;
        currentPath = st.path;
      } else if (st.status === "queued") queued++;
    }
    const total = ready + warming + queued;
    return {
      ready,
      warming,
      queue: queued,
      total,
      active: warming > 0,
      current_path: currentPath,
    };
  }

  statusPayload(infoHash: string): Record<string, unknown> {
    const h = infoHash.toLowerCase();
    const prog = this.hashProgress(h);
    const files: Array<Record<string, unknown>> = [];
    for (const [k, st] of [...this.fileStates.entries()].sort((a, b) => {
      const fa = parseInt(a[0].split(":")[1]!, 10);
      const fb = parseInt(b[0].split(":")[1]!, 10);
      return fa - fb;
    })) {
      if (!k.startsWith(`${h}:`)) continue;
      const fid = parseInt(k.split(":")[1]!, 10);
      files.push({
        id: fid,
        path: st.path,
        status: st.status,
        warmed_bytes: st.warmed_bytes,
        target_bytes: st.target_bytes,
        error: st.error,
      });
    }
    return {
      enabled: this.enabled,
      active: prog.active || prog.queue > 0,
      current_path: prog.current_path,
      done: prog.ready,
      total: prog.total,
      files,
    };
  }

  private async workerLoop(): Promise<void> {
    this.workersRunning++;
    while (true) {
      const item = this.queue.shift();
      if (!item) {
        await new Promise((r) => setTimeout(r, 200));
        if (this.queue.length === 0 && this.warmingCount === 0) continue;
        continue;
      }
      try {
        if (this.cancelledHashes.has(item.info_hash)) continue;
        await this.processItem(item);
      } catch (e) {
        console.warn("warm worker error:", e);
      }
    }
  }

  private async processItem(item: WarmQueueItem): Promise<void> {
    const h = item.info_hash.toLowerCase();
    if (this.cancelledHashes.has(h)) return;
    const st = this.getState(h, item.file_id);
    const target =
      item.target_bytes || this.resolveTarget(h, item.file_id, item.path, item.length);
    st.target_bytes = target;
    st.path = item.path;

    let cache: Record<string, unknown> = {};
    try {
      cache = await this.fetchCache(h);
    } catch {
      cache = {};
    }
    const progress = progressFromCache(
      [{ id: item.file_id, length: item.length, path: item.path }],
      cache,
    );
    const prog = progress[item.file_id];
    const downloaded = prog?.downloaded ?? 0;
    if (this.isFileReady(h, item.file_id, item.length, downloaded)) {
      st.status = "ready";
      st.warmed_bytes = Math.max(st.warmed_bytes, Math.min(downloaded, target));
      return;
    }

    st.status = "warming";
    st.updated_at = performance.now() / 1000;
    const name = basename(item.path);
    const progSnap = this.hashProgress(h);
    const done = progSnap.ready + 1;
    const total = Math.max(progSnap.total, 1);
    const detail = `${h.slice(0, 8)} · ${name} (${done}/${total})`;
    this.warmingCount++;
    this.activeDetail = detail;

    try {
      await this.activity.track("warm_probe", detail, async () => {
        let warmed: number;
        if (this.headDir) {
          const [, w] = await ensureHeadFile(
            this.torrentEngine,
            this.headDir,
            h,
            item.path,
            item.file_id,
            item.length,
            target,
          );
          warmed = w;
        } else {
          warmed = await this.warmFileHttp(h, item.path, item.file_id, target);
        }
        st.warmed_bytes = warmed;
        if (warmed >= target || (item.length > 0 && warmed >= item.length)) {
          st.status = "ready";
          st.error = null;
        } else {
          st.status = "failed";
          st.error = `получено ${warmed} из ${target} байт`;
        }
      });
    } catch (e) {
      st.status = "failed";
      st.error = String(e).slice(0, 120);
      console.warn(`warm failed ${h.slice(0, 8)} file ${item.file_id}:`, e);
    } finally {
      this.warmingCount = Math.max(0, this.warmingCount - 1);
      if (this.warmingCount <= 0) this.activeDetail = null;
      st.updated_at = performance.now() / 1000;
    }
  }

  private async warmFileHttp(
    infoHash: string,
    path: string,
    fileIndex: number,
    target: number,
  ): Promise<number> {
    const url = this.torrentEngine.buildInternalStreamUrl(infoHash, path, fileIndex);
    const end = Math.max(0, target - 1);
    const r = await fetchWithTimeout(url, {
      headers: { Range: `bytes=0-${end}` },
      timeoutMs: 120_000,
    });
    if (r.status !== 200 && r.status !== 206) {
      const body = Buffer.from(await r.arrayBuffer());
      throw new Error(`HTTP ${r.status}: ${body.subarray(0, 200).toString("utf8")}`);
    }
    if (!r.body) return 0;
    const reader = r.body.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total >= target) break;
      }
    }
    return total;
  }
}
