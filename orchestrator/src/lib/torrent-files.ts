export const PRIORITY_OFF = 0;
export const PRIORITY_BACKGROUND = 1;
export const PRIORITY_STREAM = 7;

const BTIH_HEX = /btih:([a-f0-9]{40})/i;
const BTIH_B32 = /btih:([a-z2-7]{32})/i;

export function infoHashFromMagnet(link: string): string | null {
  const mHex = link.match(BTIH_HEX);
  if (mHex) return mHex[1]!.toLowerCase();
  const mB32 = link.match(BTIH_B32);
  if (!mB32) return null;
  try {
    let encoded = mB32[1]!.toUpperCase();
    encoded += "=".repeat((-encoded.length % 8 + 8) % 8);
    const raw = base32Decode(encoded);
    return raw.toString("hex").toLowerCase();
  } catch {
    return null;
  }
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function fileDownloadPriority(
  fileIndex: number,
  activeFileIndices: Set<number>,
): number {
  if (activeFileIndices.has(fileIndex)) return PRIORITY_STREAM;
  if (activeFileIndices.size > 0) return PRIORITY_BACKGROUND;
  return PRIORITY_OFF;
}

export function extractFiles(status: Record<string, unknown> | null | undefined): Array<Record<string, unknown>> {
  if (!status) return [];
  const raw = status.file_stats;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw as Array<Record<string, unknown>>;
  }
  return [];
}

export function pickVideoFile(files: Array<Record<string, unknown>>): Record<string, unknown> {
  const videoExt = [".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts"];
  const candidates = files.filter((f) => {
    const path = String(f.path ?? f.Path ?? "");
    return videoExt.some((ext) => path.toLowerCase().endsWith(ext));
  });
  if (candidates.length === 0) {
    if (files.length > 0) return files[0]!;
    throw new Error("No files in torrent");
  }
  return candidates.reduce((best, x) => {
    const len = parseInt(String(x.length ?? x.Length ?? 0), 10);
    const bestLen = parseInt(String(best.length ?? best.Length ?? 0), 10);
    return len > bestLen ? x : best;
  });
}

export function fileIndexAndPath(fileEntry: Record<string, unknown>): [number, string] {
  const idx = parseInt(String(fileEntry.id ?? fileEntry.Id ?? 1), 10);
  const path = String(fileEntry.path ?? fileEntry.Path ?? "video.mkv");
  return [idx, path];
}
