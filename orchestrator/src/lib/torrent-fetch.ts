import type { Provider, ReleaseDetail } from "./models.js";
import { fetchWithTimeout } from "./fetch-json.js";
import { RUTOR_MIRRORS } from "./providers/rutor.js";

export const RUTOR_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; HomeCinema/0.1)" };

export function torrentDownloadUrl(detail: ReleaseDetail): string | null {
  if (detail.torrent_url?.trim()) return detail.torrent_url.trim();
  if (detail.provider === "rutor" || detail.provider === "rutor_direct") {
    return `https://d.rutor.info/download/${detail.external_id}`;
  }
  return null;
}

export function looksLikeTorrentFile(data: Buffer): boolean {
  if (data.length < 32) return false;
  const trimmed = data.toString("utf8", 0, Math.min(data.length, 8)).trimStart();
  if (trimmed.startsWith("<")) return false;
  return trimmed.startsWith("d");
}

export async function fetchTorrentBytes(
  url: string,
  opts: { timeout?: number; headers?: Record<string, string> } = {},
): Promise<Buffer | null> {
  const hdrs = { ...RUTOR_HEADERS, ...opts.headers };
  try {
    const r = await fetchWithTimeout(url, {
      timeoutMs: (opts.timeout ?? 45) * 1000,
      redirect: "follow",
      headers: hdrs,
    });
    if (r.status !== 200) {
      console.info(`torrent fetch HTTP ${r.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!looksLikeTorrentFile(buf)) {
      console.info(
        `torrent fetch not a .torrent (${buf.length} bytes) from ${url.slice(0, 80)}`,
      );
      return null;
    }
    return buf;
  } catch (e) {
    console.warn(`torrent fetch failed ${url.slice(0, 80)}:`, e);
    return null;
  }
}

export async function fetchTorrentForRelease(
  detail: ReleaseDetail,
  timeout = 45,
): Promise<Buffer | null> {
  const url = torrentDownloadUrl(detail);
  if (!url) return null;
  let data = await fetchTorrentBytes(url, { timeout });
  if (data) return data;
  if (detail.provider === "rutor_direct" || detail.provider === "rutor") {
    for (const base of RUTOR_MIRRORS) {
      const alt = `${base}/torrent/download/${detail.external_id}.torrent`;
      data = await fetchTorrentBytes(alt, { timeout });
      if (data) return data;
    }
  }
  return null;
}

export type { Provider };
