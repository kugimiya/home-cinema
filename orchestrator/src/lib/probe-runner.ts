import { statSync } from "node:fs";
import type { Settings } from "../config.js";
import type { TorrentEngineClient } from "../clients/torrent-engine.js";
import { progressFromCache } from "./file-progress.js";
import { findTorrentMediaFile } from "./media-paths.js";
import {
  ffprobePath,
  parseProbePayload,
  probePlayback,
  resolveProbeDuration,
  type ProbeResult,
} from "./playback-probe.js";
import { ensureHeadFile, headCachePath } from "./probe-head.js";
import { newProbeLiveStats, probePrefixBytesFromStart, type ProbeLiveStats } from "./probe-messages.js";
import { ProbeCacheStore, defaultWarmHeadBytes } from "./probe-store.js";
import { TorrentStateCache } from "./torrent-cache.js";
import { extractFiles } from "./torrent-files.js";

export function durationLikelyIncomplete(
  durationSec: number | null | undefined,
  fileLength: number,
): boolean {
  if (fileLength <= 0) return false;
  if (durationSec == null) return true;
  if (fileLength > 100 * 1024 * 1024 && durationSec < 300) return true;
  if (fileLength > 500 * 1024 * 1024 && durationSec < 900) return true;
  const megabytes = fileLength / (1024 * 1024);
  const expectedMin = Math.max(60, megabytes * 1.5);
  return durationSec < expectedMin;
}

export class ProbeRunner {
  private readonly torrentsRoot: string;

  constructor(
    private readonly store: ProbeCacheStore,
    private readonly torrentEngine: TorrentEngineClient,
    private readonly torrentCache: TorrentStateCache,
    private readonly settings: Settings,
    private readonly headDir: string,
  ) {
    this.torrentsRoot = settings.torrentEngineSavePath;
  }

  cachedProbeOk(
    infoHash: string,
    fileId: number,
    filePath: string,
    fileLength: number,
  ): ProbeResult | null {
    const cached = this.store.getCachedProbe(infoHash, fileId, filePath, fileLength);
    if (cached?.status === "ok") return cached;
    return null;
  }

  private finalizeProbeResult(
    infoHash: string,
    fileId: number,
    filePath: string,
    fileLength: number,
    result: ProbeResult,
    warmHeadBytes: number,
  ): ProbeResult {
    const duration = resolveProbeDuration(result.duration_sec, fileLength);
    if (duration != null && duration !== result.duration_sec) {
      console.info(
        `probe duration estimate ${infoHash.slice(0, 8)} file ${fileId}: ${result.duration_sec ?? 0} -> ${duration}`,
      );
      result = { ...result, duration_sec: duration };
    }
    this.store.saveProbe(infoHash, fileId, filePath, fileLength, result, {
      warmHeadBytes,
    });
    return result;
  }

  warmTargetBytes(
    infoHash: string,
    fileId: number,
    filePath: string,
    fileLength: number,
  ): number {
    if (this.settings.probeWarmBytes <= 0) return 0;
    const stored = this.store.getWarmHeadBytes(infoHash, fileId);
    if (stored != null && stored > 0) return stored;
    return defaultWarmHeadBytes(filePath, fileLength, this.settings.probeWarmBytes);
  }

  private async fileDownloaded(
    infoHash: string,
    fileId: number,
    fileLength: number,
  ): Promise<number> {
    try {
      const detail = await this.torrentCache.findListItem(infoHash);
      const raw = extractFiles(detail);
      if (!raw.length) return 0;
      const cache = await this.torrentCache.getCachePieces(infoHash, { listItem: detail });
      const progress = progressFromCache(raw, cache);
      const prog = progress[fileId];
      let downloaded = prog?.downloaded ?? 0;
      if (fileLength > 0) downloaded = Math.min(downloaded, fileLength);
      return downloaded;
    } catch {
      return 0;
    }
  }

  private async liveStats(
    infoHash: string,
    fileId: number,
    filePath: string,
    fileLength: number,
    target: number,
  ): Promise<ProbeLiveStats> {
    const headPath = headCachePath(this.headDir, infoHash, fileId);
    let headBytes = 0;
    try {
      headBytes = statSync(headPath).size;
    } catch {
      headBytes = 0;
    }
    let localSize = 0;
    const localMedia = findTorrentMediaFile(this.torrentsRoot, filePath);
    if (localMedia) {
      try {
        localSize = statSync(localMedia).size;
      } catch {
        localSize = 0;
      }
    }
    const torrentDownloaded = await this.fileDownloaded(infoHash, fileId, fileLength);
    const downloaded = probePrefixBytesFromStart({
      target,
      headBytes,
      localFileSize: localSize,
      torrentDownloaded,
    });
    let speed: number | null = null;
    let peers: number | null = null;
    try {
      const item = await this.torrentCache.findListItem(infoHash);
      for (const key of ["download_speed", "DownloadSpeed"]) {
        if (item[key] != null) {
          speed = parseFloat(String(item[key]));
          break;
        }
      }
      for (const key of ["total_peers", "TotalPeers"]) {
        if (item[key] != null) {
          peers = parseInt(String(item[key]), 10);
          break;
        }
      }
    } catch {
      /* ignore */
    }
    return newProbeLiveStats({
      bytes_downloaded: downloaded,
      bytes_target: target,
      download_speed: speed,
      total_peers: peers,
    });
  }

  async probeFile(
    infoHash: string,
    fileId: number,
    filePath: string,
    fileLength: number,
    opts: {
      allowHevc: boolean;
      onAttempt?: (attempt: number, total: number) => void;
      onLive?: (stats: ProbeLiveStats) => void;
    },
  ): Promise<ProbeResult> {
    const h = infoHash.toLowerCase();
    let cached = this.store.getCachedProbe(h, fileId, filePath, fileLength);
    if (cached) {
      const duration = resolveProbeDuration(cached.duration_sec, fileLength);
      if (duration != null && duration !== cached.duration_sec) {
        cached = { ...cached, duration_sec: duration };
      }
    }
    if (cached && !durationLikelyIncomplete(cached.duration_sec, fileLength)) {
      console.info(`probe cache hit ${h.slice(0, 8)} file ${fileId}`);
      opts.onLive?.(newProbeLiveStats({ subphase: "cache" }));
      return cached;
    }
    if (cached) {
      console.info(`probe cache skipped (short duration) ${h.slice(0, 8)} file ${fileId}`);
    }

    const target = this.warmTargetBytes(h, fileId, filePath, fileLength);
    const internalUrl = this.torrentEngine.buildInternalStreamUrl(h, filePath, fileId);

    const localMedia = findTorrentMediaFile(this.torrentsRoot, filePath);
    if (localMedia) {
      try {
        const localStat = statSync(localMedia);
        const minOnDisk = target > 0 ? Math.min(target, 512 * 1024) : 512 * 1024;
        if (localStat.size >= minOnDisk) {
          opts.onLive?.(
            newProbeLiveStats({
              bytes_downloaded: probePrefixBytesFromStart({
                target,
                localFileSize: localStat.size,
              }),
              bytes_target: target > 0 ? target : localStat.size,
              subphase: "analyze_head",
            }),
          );
          try {
            const data = await ffprobePath(
              localMedia,
              Math.min(60, this.settings.transcodeProbeTimeout),
            );
            const result = parseProbePayload(data, filePath, opts.allowHevc);
            return this.finalizeProbeResult(
              h,
              fileId,
              filePath,
              fileLength,
              result,
              Math.max(target, localStat.size),
            );
          } catch (e) {
            console.info("local ffprobe failed, continuing:", e);
          }
        }
      } catch {
        /* ignore */
      }
    }

    const tick = async (subphase: string, elapsed: number) => {
      if (!opts.onLive) return;
      const stats = await this.liveStats(h, fileId, filePath, fileLength, target);
      stats.subphase = subphase;
      stats.elapsed_sec = elapsed;
      opts.onLive(stats);
    };

    if (target > 0) {
      opts.onLive?.(
        newProbeLiveStats({
          bytes_target: target,
          subphase: "prefetch_head",
        }),
      );
      const [headPath, headSize] = await ensureHeadFile(
        this.torrentEngine,
        this.headDir,
        h,
        filePath,
        fileId,
        fileLength,
        target,
      );
      if (headPath && headSize > 0) {
        const stats = await this.liveStats(h, fileId, filePath, fileLength, target);
        stats.subphase = "analyze_head";
        opts.onLive?.(stats);
        try {
          const data = await ffprobePath(
            headPath,
            Math.min(30, this.settings.transcodeProbeTimeout),
          );
          const result = parseProbePayload(data, filePath, opts.allowHevc);
          return this.finalizeProbeResult(
            h,
            fileId,
            filePath,
            fileLength,
            result,
            Math.max(headSize, target),
          );
        } catch (e) {
          console.info("head ffprobe failed, trying stream:", e);
        }
      }
    }

    const result = await probePlayback({
      url: internalUrl,
      filePath,
      allowHevc: opts.allowHevc,
      timeout: this.settings.transcodeProbeTimeout,
      retries: this.settings.transcodeProbeRetries,
      retryDelay: this.settings.transcodeProbeRetryDelay,
      onAttempt: opts.onAttempt,
      onTick: opts.onLive
        ? (elapsed, subphase) => {
            void tick(subphase, elapsed);
          }
        : undefined,
    });

    if (result.status === "ok") {
      const downloaded = await this.fileDownloaded(h, fileId, fileLength);
      const hp = headCachePath(this.headDir, h, fileId);
      let headSize = 0;
      try {
        headSize = statSync(hp).size;
      } catch {
        headSize = 0;
      }
      const warmSaved = Math.max(target, downloaded, headSize);
      const needsTail =
        warmSaved > target * 2 || (fileLength > 0 && warmSaved >= fileLength * 0.5);
      this.store.saveProbe(h, fileId, filePath, fileLength, result, {
        warmHeadBytes: warmSaved,
        needsStreamTail: needsTail,
      });
    }
    return result;
  }
}
