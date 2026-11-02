import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { TorrentEngineClient } from "../clients/torrent-engine.js";
import { fetchWithTimeout } from "./fetch-json.js";

export function headCachePath(baseDir: string, infoHash: string, fileId: number): string {
  const h = infoHash.toLowerCase();
  return join(baseDir, h.slice(0, 16), String(fileId), "head.bin");
}

export async function downloadHeadRange(
  torrentEngine: TorrentEngineClient,
  infoHash: string,
  filePath: string,
  fileIndex: number,
  targetBytes: number,
  dest: string,
): Promise<number> {
  if (targetBytes <= 0) return 0;
  mkdirSync(dirname(dest), { recursive: true });
  const url = torrentEngine.buildInternalStreamUrl(infoHash, filePath, fileIndex);
  const end = Math.max(0, targetBytes - 1);
  const r = await fetchWithTimeout(url, {
    headers: { Range: `bytes=0-${end}` },
    timeoutMs: 120_000,
  });
  if (r.status !== 200 && r.status !== 206) {
    const body = Buffer.from(await r.arrayBuffer());
    throw new Error(`HTTP ${r.status}: ${body.subarray(0, 200).toString("utf8")}`);
  }
  if (!r.body) throw new Error("empty body");
  let total = 0;
  const out = createWriteStream(dest);
  const reader = Readable.fromWeb(r.body as import("stream/web").ReadableStream);
  reader.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total >= targetBytes) reader.destroy();
  });
  await pipeline(reader, out);
  return Math.min(total, targetBytes);
}

export async function ensureHeadFile(
  torrentEngine: TorrentEngineClient,
  baseDir: string,
  infoHash: string,
  filePath: string,
  fileIndex: number,
  fileLength: number,
  targetBytes: number,
): Promise<[string | null, number]> {
  if (targetBytes <= 0) return [null, 0];
  const path = headCachePath(baseDir, infoHash, fileIndex);
  if (existsSync(path)) {
    const size = statSync(path).size;
    if (size >= Math.min(targetBytes, fileLength || targetBytes)) return [path, size];
  }
  try {
    const written = await downloadHeadRange(
      torrentEngine,
      infoHash,
      filePath,
      fileIndex,
      targetBytes,
      path,
    );
    return [path, written];
  } catch (e) {
    console.warn(`head download failed ${infoHash.slice(0, 8)}/${fileIndex}:`, e);
    if (existsSync(path)) return [path, statSync(path).size];
    return [null, 0];
  }
}

export function removeHashHeads(baseDir: string, infoHash: string): void {
  const h = infoHash.toLowerCase();
  const folder = join(baseDir, h.slice(0, 16));
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
