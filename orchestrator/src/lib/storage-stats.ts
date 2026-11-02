import { readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { statfsSync } from "node:fs";
import { findTorrentMediaFile } from "./media-paths.js";

const SKIP_DIR_NAMES = new Set([".engine"]);

function torrentHashDirSize(base: string, infoHash: string): number {
  const path = join(base, infoHash.toLowerCase());
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) return 0;
  let total = 0;
  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  try {
    walk(path);
  } catch {
    return 0;
  }
  return total;
}

export function torrentOnDiskBytes(
  base: string,
  infoHash: string,
  filePaths: string[],
  loadedSize?: number | null,
): number {
  const hashDir = torrentHashDirSize(base, infoHash);
  if (hashDir > 0) return hashDir;

  const seen = new Set<string>();
  let total = 0;
  for (const rel of filePaths) {
    if (!rel.trim()) continue;
    const found = findTorrentMediaFile(base, rel);
    if (!found) continue;
    const key = resolvePath(found);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      total += statSync(found).size;
    } catch {
      /* ignore */
    }
  }
  if (total > 0) return total;
  if (loadedSize && loadedSize > 0) return loadedSize;
  return 0;
}

function resolvePath(p: string): string {
  try {
    return statSync(p).dev !== undefined ? p : p;
  } catch {
    return p;
  }
}

function torrentsDataBytes(base: string): number {
  if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) return 0;
  let total = 0;
  function walk(root: string): void {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name) || ent.name.startsWith(".")) continue;
        walk(join(root, ent.name));
      } else if (ent.isFile() && !ent.name.startsWith(".")) {
        try {
          total += statSync(join(root, ent.name)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(base);
  return total;
}

export function storageSummary(torrentsPath: string): {
  disk_total_bytes: number;
  disk_free_bytes: number;
  disk_used_bytes: number;
  torrents_data_bytes: number;
} {
  mkdirSync(torrentsPath, { recursive: true });
  const st = statfsSync(torrentsPath);
  const blockSize = st.bsize;
  const total = st.blocks * blockSize;
  const free = st.bfree * blockSize;
  const used = total - free;
  return {
    disk_total_bytes: total,
    disk_free_bytes: free,
    disk_used_bytes: used,
    torrents_data_bytes: torrentsDataBytes(torrentsPath),
  };
}
