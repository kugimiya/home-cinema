import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { accumulateUpload } from "./lib/upload-stats.js";

export interface TorrentMeta {
  info_hash: string;
  title: string;
  provider?: string | null;
  external_id?: string | null;
  search_query?: string | null;
  quality?: string | null;
  voice?: string | null;
}

export class MetaStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS torrent_meta (
        info_hash TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT,
        external_id TEXT,
        search_query TEXT,
        quality TEXT,
        voice TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS torrent_upload (
        info_hash TEXT PRIMARY KEY,
        lifetime_bytes INTEGER NOT NULL DEFAULT 0,
        last_reported_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  syncUploadLifetime(infoHash: string, reportedBytes: number): number {
    const h = infoHash.toLowerCase();
    const row = this.db
      .prepare(
        "SELECT lifetime_bytes, last_reported_bytes FROM torrent_upload WHERE info_hash = ?",
      )
      .get(h) as
      | { lifetime_bytes: number; last_reported_bytes: number }
      | undefined;

    if (row) {
      const [lifetime, last] = accumulateUpload(
        row.lifetime_bytes,
        row.last_reported_bytes,
        reportedBytes,
      );
      this.db
        .prepare(
          `UPDATE torrent_upload SET lifetime_bytes = ?, last_reported_bytes = ? WHERE info_hash = ?`,
        )
        .run(lifetime, last, h);
      return lifetime;
    }

    const [lifetime, last] = accumulateUpload(0, 0, reportedBytes);
    this.db
      .prepare(
        `INSERT INTO torrent_upload (info_hash, lifetime_bytes, last_reported_bytes) VALUES (?, ?, ?)`,
      )
      .run(h, lifetime, last);
    return lifetime;
  }

  upsert(meta: TorrentMeta): void {
    this.db
      .prepare(
        `INSERT INTO torrent_meta (
          info_hash, title, provider, external_id, search_query, quality, voice
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(info_hash) DO UPDATE SET
          title=excluded.title,
          provider=COALESCE(excluded.provider, torrent_meta.provider),
          external_id=COALESCE(excluded.external_id, torrent_meta.external_id),
          search_query=COALESCE(excluded.search_query, torrent_meta.search_query),
          quality=COALESCE(excluded.quality, torrent_meta.quality),
          voice=COALESCE(excluded.voice, torrent_meta.voice)`,
      )
      .run(
        meta.info_hash.toLowerCase(),
        meta.title,
        meta.provider ?? null,
        meta.external_id ?? null,
        meta.search_query ?? null,
        meta.quality ?? null,
        meta.voice ?? null,
      );
  }

  get(infoHash: string): TorrentMeta | null {
    const row = this.db
      .prepare("SELECT * FROM torrent_meta WHERE info_hash = ?")
      .get(infoHash.toLowerCase()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      info_hash: String(row.info_hash),
      title: String(row.title),
      provider: row.provider != null ? String(row.provider) : null,
      external_id: row.external_id != null ? String(row.external_id) : null,
      search_query: row.search_query != null ? String(row.search_query) : null,
      quality: row.quality != null ? String(row.quality) : null,
      voice: row.voice != null ? String(row.voice) : null,
    };
  }

  delete(infoHash: string): void {
    const h = infoHash.toLowerCase();
    this.db.prepare("DELETE FROM torrent_meta WHERE info_hash = ?").run(h);
    this.db.prepare("DELETE FROM torrent_upload WHERE info_hash = ?").run(h);
  }
}
