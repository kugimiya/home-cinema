import { parseQuality, parseVoice } from "./metadata.js";
import type { MediaKind, TorrentMediaFile } from "./models.js";
import { fileIndexAndPath } from "./torrent-files.js";

const VIDEO_EXT = [".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts", ".m2ts"];
const SUBTITLE_EXT = [".srt", ".ass", ".ssa", ".vtt", ".sub", ".sup"];
const AUDIO_EXT = [".mp3", ".flac", ".aac", ".m4a", ".wav", ".opus"];

export function mediaKindForPath(path: string): MediaKind {
  const lower = path.toLowerCase();
  if (VIDEO_EXT.some((e) => lower.endsWith(e))) return "video";
  if (SUBTITLE_EXT.some((e) => lower.endsWith(e))) return "subtitle";
  if (AUDIO_EXT.some((e) => lower.endsWith(e))) return "audio";
  return "other";
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function torrentFileToMedia(
  fileEntry: Record<string, unknown>,
  streamUrl?: string | null,
): TorrentMediaFile {
  const [idx, path] = fileIndexAndPath(fileEntry);
  const length = parseInt(String(fileEntry.length ?? fileEntry.Length ?? 0), 10);
  const name = basename(path);
  const kind = mediaKindForPath(path);
  return {
    id: idx,
    path,
    name,
    length,
    kind,
    quality: parseQuality(name) ?? parseQuality(path),
    voice: parseVoice(name) ?? parseVoice(path),
    stream_url: streamUrl ?? null,
  };
}

export function buildMediaCatalog(
  rawFiles: Array<Record<string, unknown>>,
  streamUrlFor?: (idx: number, path: string) => string | null,
): TorrentMediaFile[] {
  const items = rawFiles.map((entry) => {
    const [idx, path] = fileIndexAndPath(entry);
    const url = streamUrlFor ? streamUrlFor(idx, path) : null;
    return torrentFileToMedia(entry, url);
  });
  items.sort((a, b) => {
    const k = a.kind.localeCompare(b.kind);
    if (k !== 0) return k;
    return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
  });
  return items;
}

export function pickDefaultVideo(files: TorrentMediaFile[]): TorrentMediaFile | null {
  const videos = files.filter((f) => f.kind === "video");
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0]!;
  return videos.reduce((a, b) => (a.length >= b.length ? a : b));
}
