import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export function findTorrentMediaFile(
  torrentsRoot: string,
  relativePath: string,
): string | null {
  if (!relativePath.trim()) return null;
  const relNorm = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = resolve(torrentsRoot);
  if (!existsSync(root)) return null;

  const direct = join(root, relNorm);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;

  const byName = join(root, relNorm.split("/").pop() ?? relNorm);
  if (existsSync(byName) && statSync(byName).isFile()) return byName;

  try {
    for (const name of readdirSync(root)) {
      if (name.startsWith(".")) continue;
      const full = join(root, name);
      if (!statSync(full).isDirectory()) continue;
      const candidate = join(full, relNorm);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  } catch {
    /* ignore */
  }

  const leaf = relNorm.split("/").pop() ?? "";
  if (!leaf) return null;

  function walk(dir: string): string | null {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isFile() && name === leaf) {
        try {
          const rel = relative(root, full).replace(/\\/g, "/");
          if (rel.endsWith(relNorm)) return full;
        } catch {
          /* ignore */
        }
        if (relNorm.endsWith(leaf)) return full;
      }
      if (st.isDirectory() && !name.startsWith(".")) {
        const found = walk(full);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(root);
}
