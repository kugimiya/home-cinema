import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logging.js";

const logger = createLogger("persistence");

export interface TorrentIndexEntry {
  link: string;
  title: string;
}

export class TorrentIndex {
  private readonly dir: string;
  private readonly path: string;
  private data: Record<string, TorrentIndexEntry> = {};

  constructor(savePath: string) {
    this.dir = join(savePath, ".engine");
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, "torrents.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        this.data = raw as Record<string, TorrentIndexEntry>;
      }
    } catch (e) {
      logger.warn(`Could not load torrent index: ${e}`);
    }
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf8");
    } catch (e) {
      logger.warn(`Could not save torrent index: ${e}`);
    }
  }

  remember(infoHash: string, link: string, title: string): void {
    const h = String(infoHash).toLowerCase();
    this.data[h] = { link, title };
    this.save();
  }

  remove(infoHash: string): void {
    const h = infoHash.toLowerCase();
    if (h in this.data) {
      delete this.data[h];
      this.save();
    }
  }

  allEntries(): Array<[string, string, string]> {
    const out: Array<[string, string, string]> = [];
    for (const [h, meta] of Object.entries(this.data)) {
      out.push([h, meta.link ?? "", meta.title ?? h]);
    }
    return out;
  }
}
