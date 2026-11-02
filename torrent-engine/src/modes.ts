export const PRIORITY_OFF = 0;
export const PRIORITY_BACKGROUND = 1;
export const PRIORITY_STREAM = 7;

export enum TorrentMode {
  streaming = "streaming",
  completing = "completing",
  seeding = "seeding",
  paused = "paused",
}

export function fileDownloadPriority(
  fileIndex: number,
  activeFileIndices: Set<number>,
): number {
  if (activeFileIndices.has(fileIndex)) return PRIORITY_STREAM;
  if (activeFileIndices.size > 0) return PRIORITY_BACKGROUND;
  return PRIORITY_OFF;
}

export function applyModeToScope(mode: TorrentMode, scopeFileIds: Set<number>): Set<number> {
  if (mode === TorrentMode.paused) return new Set();
  if (mode === TorrentMode.streaming || mode === TorrentMode.completing) {
    return new Set(scopeFileIds);
  }
  if (mode === TorrentMode.seeding) return new Set();
  return new Set();
}

export function parseTorrentMode(value: string): TorrentMode {
  const v = value as TorrentMode;
  if (Object.values(TorrentMode).includes(v)) return v;
  throw new Error(`Invalid torrent mode: ${value}`);
}
