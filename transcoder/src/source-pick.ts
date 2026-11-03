import fs from "node:fs";

/** Bytes actually allocated on disk (Linux st_blocks × 512). */
export function diskBytesAllocated(st: fs.Stats): number {
  return st.blocks * 512;
}

/**
 * True when the file has large holes (partial torrent) or is empty.
 * Complete downloads usually have allocated ≈ size.
 */
export function isSparseOrIncomplete(
  filePath: string,
  expectedSize?: number | null,
): boolean {
  const st = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size === 0) return true;

  const allocated = diskBytesAllocated(st);
  const size = st.size;

  if (expectedSize != null && expectedSize > 0 && size >= expectedSize) {
    if (allocated >= expectedSize * 0.92) return false;
  }

  if (size <= 256 * 1024) return allocated < size * 0.5;

  return allocated < size * 0.85;
}

/** Prefer local file when fully on disk; HTTP for sparse/incomplete (avoids corrupt reads). */
export function pickFfmpegSource(
  sourcePath: string | null,
  sourceUrl: string | null,
  expectedFileLength?: number | null,
): string | null {
  if (sourcePath) {
    const st = fs.statSync(sourcePath, { throwIfNoEntry: false });
    if (st?.isFile()) {
      if (!isSparseOrIncomplete(sourcePath, expectedFileLength)) {
        return sourcePath;
      }
    }
  }
  if (sourceUrl) return sourceUrl;
  if (sourcePath) {
    const st = fs.statSync(sourcePath, { throwIfNoEntry: false });
    if (st?.isFile()) return sourcePath;
  }
  return null;
}
