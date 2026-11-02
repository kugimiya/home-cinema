import fs from "node:fs";
import path from "node:path";

export function findTorrentMediaFile(
  torrentsRoot: string,
  relativePath: string,
): string | null {
  if (!relativePath.trim()) {
    return null;
  }
  const relNorm = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!fs.statSync(torrentsRoot, { throwIfNoEntry: false })?.isDirectory()) {
    return null;
  }

  const direct = path.join(torrentsRoot, relNorm);
  if (fs.statSync(direct, { throwIfNoEntry: false })?.isFile()) {
    return direct;
  }
  const byName = path.join(torrentsRoot, path.basename(relNorm));
  if (fs.statSync(byName, { throwIfNoEntry: false })?.isFile()) {
    return byName;
  }

  for (const entry of fs.readdirSync(torrentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const candidate = path.join(torrentsRoot, entry.name, relNorm);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return candidate;
    }
  }

  const leaf = path.basename(relNorm);
  if (!leaf) {
    return null;
  }
  const walk = (dir: string): string | null => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(full);
        if (found) {
          return found;
        }
      } else if (entry.isFile()) {
        const rel = path.relative(torrentsRoot, full).replace(/\\/g, "/");
        if (rel.endsWith(relNorm) || (entry.name === leaf && relNorm.endsWith(leaf))) {
          return full;
        }
      }
    }
    return null;
  };
  return walk(torrentsRoot);
}
