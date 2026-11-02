function fileId(entry: Record<string, unknown>): number {
  return parseInt(String(entry.id ?? entry.Id ?? 0), 10);
}

function fileLength(entry: Record<string, unknown>): number {
  return parseInt(String(entry.length ?? entry.Length ?? 0), 10);
}

export function progressFromFileStats(
  files: Array<Record<string, unknown>>,
): Record<number, { downloaded: number; priority: number }> {
  const result: Record<number, { downloaded: number; priority: number }> = {};
  for (const f of files) {
    const fid = fileId(f);
    if (fid <= 0) continue;
    result[fid] = {
      downloaded: parseInt(String(f.downloaded_bytes ?? 0), 10),
      priority: parseInt(String(f.priority ?? 0), 10),
    };
  }
  return result;
}

export function progressFromCache(
  files: Array<Record<string, unknown>>,
  cache: Record<string, unknown> | null | undefined,
): Record<number, { downloaded: number; priority: number }> {
  if (!files.length) return {};

  if (cache && Array.isArray(cache._engine_files)) {
    return progressFromFileStats(cache._engine_files as Array<Record<string, unknown>>);
  }

  const sortedFiles = [...files].sort((a, b) => fileId(a) - fileId(b));
  const spans: Array<[number, number, number]> = [];
  let start = 0;
  for (const f of sortedFiles) {
    const fid = fileId(f);
    const length = fileLength(f);
    spans.push([fid, start, start + length]);
    start += length;
  }

  const pieceLen = cache
    ? parseInt(String(cache.PiecesLength ?? cache.piecesLength ?? 0), 10)
    : 0;
  const pieces = (cache?.Pieces ?? cache?.pieces ?? {}) as Record<string, unknown>;
  if (!pieceLen || typeof pieces !== "object" || pieces === null) {
    return progressFromFileStats(files);
  }

  const result: Record<number, { downloaded: number; priority: number }> = {};
  for (const f of sortedFiles) {
    result[fileId(f)] = { downloaded: 0, priority: 0 };
  }

  function fileForOffset(offset: number): number | null {
    for (const [fid, begin, end] of spans) {
      if (offset >= begin && offset < end) return fid;
    }
    return null;
  }

  for (const [key, piece] of Object.entries(pieces)) {
    if (typeof piece !== "object" || piece === null) continue;
    const p = piece as Record<string, unknown>;
    const pieceIndex = parseInt(key, 10);
    if (!Number.isFinite(pieceIndex)) continue;
    const offset = pieceIndex * pieceLen;
    const fid = fileForOffset(offset);
    if (fid === null || !result[fid]) continue;
    const completed = Boolean(p.Completed ?? p.completed);
    let size: number;
    if (completed) {
      size = parseInt(String(p.Length ?? p.length ?? pieceLen), 10);
    } else {
      size = parseInt(String(p.Size ?? p.size ?? 0), 10);
    }
    result[fid]!.downloaded += size;
    const pri = parseInt(String(p.Priority ?? p.priority ?? 0), 10);
    if (pri > result[fid]!.priority) result[fid]!.priority = pri;
  }

  return result;
}

export function uploadBytesPerFile(
  progress: Record<number, { downloaded: number; priority: number }>,
  bytesWrittenData: number | null | undefined,
): Record<number, number> {
  const totalUpload = Math.max(0, parseInt(String(bytesWrittenData ?? 0), 10));
  const fileIds = Object.keys(progress).map((k) => parseInt(k, 10));
  if (totalUpload === 0 || fileIds.length === 0) {
    return Object.fromEntries(fileIds.map((id) => [id, 0]));
  }

  function weight(fid: number, activeOnly: boolean): number {
    const prog = progress[fid];
    if (!prog) return 0;
    const downloaded = prog.downloaded;
    if (downloaded <= 0) return 0;
    if (activeOnly && prog.priority < 1) return 0;
    return downloaded;
  }

  let weights: Record<number, number> = {};
  for (const fid of fileIds) weights[fid] = weight(fid, true);
  let weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    weights = {};
    for (const fid of fileIds) weights[fid] = weight(fid, false);
    weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
  }
  if (weightSum <= 0) {
    return Object.fromEntries(fileIds.map((id) => [id, 0]));
  }

  const shares: Record<number, number> = {};
  let assigned = 0;
  const ordered = [...fileIds].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));
  for (let idx = 0; idx < ordered.length; idx++) {
    const fid = ordered[idx]!;
    if (idx === ordered.length - 1) {
      shares[fid] = Math.max(0, totalUpload - assigned);
    } else {
      const part = Math.trunc((totalUpload * (weights[fid] ?? 0)) / weightSum);
      shares[fid] = part;
      assigned += part;
    }
  }
  return shares;
}
