import Database from "better-sqlite3";
import { extname } from "node:path";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AudioTrackInfo } from "./models.js";
import { mediaKindForPath } from "./media-files.js";
import type { ProbeResult } from "./playback-probe.js";

export function defaultWarmHeadBytes(
  filePath: string,
  fileLength: number,
  fallback: number,
): number {
  const ext = extname(filePath).toLowerCase();
  let base = fallback;
  if ([".mp4", ".m4v", ".mov"].includes(ext)) base = Math.max(base, 8 * 1024 * 1024);
  if (fileLength > 0) return Math.min(base, fileLength);
  return base;
}

export class ProbeCacheStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_probe_cache (
        info_hash TEXT NOT NULL,
        file_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        file_length INTEGER NOT NULL DEFAULT 0,
        playback_mode TEXT NOT NULL,
        direct_playable INTEGER NOT NULL,
        video_copy INTEGER NOT NULL,
        audio_copy INTEGER NOT NULL,
        duration_sec REAL,
        audio_tracks_json TEXT NOT NULL,
        warm_head_bytes INTEGER NOT NULL,
        needs_stream_tail INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (info_hash, file_id)
      );
    `);
  }

  getWarmHeadBytes(infoHash: string, fileId: number): number | null {
    const row = this.db
      .prepare(
        "SELECT warm_head_bytes FROM file_probe_cache WHERE info_hash = ? AND file_id = ?",
      )
      .get(infoHash.toLowerCase(), fileId) as { warm_head_bytes: number } | undefined;
    return row ? row.warm_head_bytes : null;
  }

  getCachedProbe(
    infoHash: string,
    fileId: number,
    filePath: string,
    fileLength: number,
  ): ProbeResult | null {
    const row = this.db
      .prepare("SELECT * FROM file_probe_cache WHERE info_hash = ? AND file_id = ?")
      .get(infoHash.toLowerCase(), fileId) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (row.file_path !== filePath) return null;
    if (fileLength > 0 && parseInt(String(row.file_length), 10) !== fileLength) return null;
    const tracksRaw = JSON.parse(String(row.audio_tracks_json || "[]")) as AudioTrackInfo[];
    const filePathCached = String(row.file_path);
    const isAudioFile = mediaKindForPath(filePathCached) === "audio";
    return {
      status: "ok",
      media_kind: isAudioFile ? "audio" : "video",
      playback_mode: row.playback_mode as ProbeResult["playback_mode"],
      direct_playable: Boolean(row.direct_playable),
      audio_tracks: tracksRaw,
      video_copy: Boolean(row.video_copy),
      audio_copy: Boolean(row.audio_copy),
      duration_sec: row.duration_sec != null ? Number(row.duration_sec) : null,
    };
  }

  saveProbe(
    infoHash: string,
    fileId: number,
    filePath: string,
    fileLength: number,
    result: ProbeResult,
    opts: { warmHeadBytes: number; needsStreamTail?: boolean },
  ): void {
    if (result.status !== "ok") return;
    const tracksJson = JSON.stringify(result.audio_tracks);
    this.db
      .prepare(
        `INSERT INTO file_probe_cache (
          info_hash, file_id, file_path, file_length,
          playback_mode, direct_playable, video_copy, audio_copy,
          duration_sec, audio_tracks_json, warm_head_bytes, needs_stream_tail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(info_hash, file_id) DO UPDATE SET
          file_path=excluded.file_path,
          file_length=excluded.file_length,
          playback_mode=excluded.playback_mode,
          direct_playable=excluded.direct_playable,
          video_copy=excluded.video_copy,
          audio_copy=excluded.audio_copy,
          duration_sec=CASE
            WHEN excluded.duration_sec IS NULL THEN file_probe_cache.duration_sec
            WHEN file_probe_cache.duration_sec IS NULL THEN excluded.duration_sec
            ELSE MAX(excluded.duration_sec, file_probe_cache.duration_sec)
          END,
          audio_tracks_json=excluded.audio_tracks_json,
          warm_head_bytes=excluded.warm_head_bytes,
          needs_stream_tail=excluded.needs_stream_tail,
          updated_at=CURRENT_TIMESTAMP`,
      )
      .run(
        infoHash.toLowerCase(),
        fileId,
        filePath,
        fileLength,
        result.playback_mode,
        result.direct_playable ? 1 : 0,
        result.video_copy ? 1 : 0,
        result.audio_copy ? 1 : 0,
        result.duration_sec,
        tracksJson,
        Math.max(0, opts.warmHeadBytes),
        opts.needsStreamTail ? 1 : 0,
      );
  }

  deleteHash(infoHash: string): void {
    this.db
      .prepare("DELETE FROM file_probe_cache WHERE info_hash = ?")
      .run(infoHash.toLowerCase());
  }
}
