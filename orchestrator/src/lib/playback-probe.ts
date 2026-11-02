import { spawn } from "node:child_process";
import { extname } from "node:path";
import type { AudioTrackInfo, PlaybackMode } from "./models.js";

export interface ProbeResult {
  status: "ok" | "pending";
  playback_mode: PlaybackMode;
  direct_playable: boolean;
  audio_tracks: AudioTrackInfo[];
  video_copy: boolean;
  audio_copy: boolean;
  duration_sec: number | null;
}

const BROWSER_VIDEO = new Set(["h264", "avc1", "vp9", "vp8", "av1"]);
const BROWSER_VIDEO_HEVC = new Set(["hevc", "hev1", "h265"]);
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "flac", "vorbis"]);
const DIRECT_CONTAINERS = new Set(["mov", "mp4", "m4v", "webm", "mkv", "matroska"]);
const FORCE_TRANSCODE_EXT = new Set([".avi", ".wmv", ".asf", ".mpg", ".mpeg", ".vob"]);

function normCodec(name: string | null | undefined): string {
  if (!name) return "";
  return name.toLowerCase().split(".")[0]!.trim();
}

function videoBrowserOk(codec: string, allowHevc: boolean): boolean {
  const c = normCodec(codec);
  if (BROWSER_VIDEO.has(c)) return true;
  if (allowHevc && BROWSER_VIDEO_HEVC.has(c)) return true;
  return false;
}

function audioBrowserOk(codec: string): boolean {
  return BROWSER_AUDIO.has(normCodec(codec));
}

function trackLabel(stream: Record<string, unknown>, ordinal: number): string {
  const tags = (stream.tags ?? {}) as Record<string, unknown>;
  const title = tags.title ?? tags.TITLE;
  const lang = tags.language ?? tags.LANGUAGE;
  const parts = [title, lang].filter(Boolean).map(String);
  if (parts.length) return parts.join(" · ");
  return `Дорожка ${ordinal + 1}`;
}

function parseDurationNumber(raw: unknown): number | null {
  if (raw == null) return null;
  const value = Math.max(0, parseFloat(String(raw)));
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function parseDurationTag(raw: unknown): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text.includes(":")) {
    const parts = text.split(":");
    try {
      let value: number;
      if (parts.length === 3) {
        value =
          parseInt(parts[0]!, 10) * 3600 +
          parseInt(parts[1]!, 10) * 60 +
          parseFloat(parts[2]!);
      } else if (parts.length === 2) {
        value = parseInt(parts[0]!, 10) * 60 + parseFloat(parts[1]!);
      } else return null;
      return value > 0 ? value : null;
    } catch {
      return null;
    }
  }
  return parseDurationNumber(text);
}

function durationFromTags(tags: Record<string, unknown>): number | null {
  for (const key of ["DURATION", "duration", "Duration"]) {
    if (key in tags) {
      const parsed = parseDurationTag(tags[key]);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

export function estimateDurationFromFileBytes(fileLength: number): number | null {
  if (fileLength <= 0) return null;
  return (fileLength / (1024 * 1024)) * 2.0;
}

export function resolveProbeDuration(
  durationSec: number | null | undefined,
  fileLength: number,
): number | null {
  const api = durationSec != null && durationSec > 0 ? durationSec : 0;
  const estimate = estimateDurationFromFileBytes(fileLength);
  if (fileLength <= 0) return durationSec ?? null;
  if (estimate == null) return durationSec ?? null;
  if (api <= 0) return estimate;
  if (api < 120 && estimate > api * 2.5) return estimate;
  if (fileLength > 100 * 1024 * 1024 && api < 300 && estimate > api) return estimate;
  return Math.max(api, estimate);
}

export function extractDurationSec(data: Record<string, unknown>): number | null {
  const fmt = (data.format ?? {}) as Record<string, unknown>;
  const streams = (data.streams ?? []) as Array<Record<string, unknown>>;

  let best: number | null = parseDurationNumber(fmt.duration);
  const tagDur = durationFromTags((fmt.tags ?? {}) as Record<string, unknown>);
  if (tagDur != null && (best == null || tagDur > best)) best = tagDur;

  for (const stream of streams) {
    if (stream.codec_type !== "video") continue;
    const streamDur = parseDurationNumber(stream.duration);
    if (streamDur != null && (best == null || streamDur > best)) best = streamDur;
    const stTag = durationFromTags((stream.tags ?? {}) as Record<string, unknown>);
    if (stTag != null && (best == null || stTag > best)) best = stTag;
  }
  return best;
}

export function parseProbePayload(
  data: Record<string, unknown>,
  path: string,
  allowHevc: boolean,
): ProbeResult {
  const streams = (data.streams ?? []) as Array<Record<string, unknown>>;
  const fmt = (data.format ?? {}) as Record<string, unknown>;
  const formatName = String(fmt.format_name ?? "").toLowerCase();
  const ext = extname(path).toLowerCase();

  const videoStreams = streams.filter((s) => s.codec_type === "video");
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  if (videoStreams.length === 0) throw new Error("No video stream in file");

  const durationSec = extractDurationSec(data);
  const videoCodec = String(videoStreams[0]!.codec_name ?? "");

  const audioTracks: AudioTrackInfo[] = audioStreams.map((stream, i) => {
    const tags = (stream.tags ?? {}) as Record<string, unknown>;
    return {
      index: i,
      stream_index: parseInt(String(stream.index ?? i), 10),
      codec: stream.codec_name != null ? String(stream.codec_name) : null,
      language:
        tags.language != null
          ? String(tags.language)
          : tags.LANGUAGE != null
            ? String(tags.LANGUAGE)
            : null,
      title:
        tags.title != null ? String(tags.title) : tags.TITLE != null ? String(tags.TITLE) : null,
      label: trackLabel(stream, i),
    };
  });

  if (audioTracks.length === 0) {
    audioTracks.push({
      index: 0,
      stream_index: 0,
      codec: null,
      language: null,
      title: null,
      label: "Дорожка 1",
    });
  }

  const videoOk = videoBrowserOk(videoCodec, allowHevc);
  const allAudioOk = audioTracks.every((a) => audioBrowserOk(a.codec ?? ""));
  const containerOk =
    [".mp4", ".m4v", ".webm"].includes(ext) ||
    [...DIRECT_CONTAINERS].some((c) => formatName.includes(c));
  const forceTranscode = FORCE_TRANSCODE_EXT.has(ext);

  if (!forceTranscode && videoOk && allAudioOk && containerOk) {
    return {
      status: "ok",
      playback_mode: "direct",
      direct_playable: true,
      audio_tracks: audioTracks,
      video_copy: true,
      audio_copy: true,
      duration_sec: durationSec,
    };
  }

  const videoCopy = videoOk && !forceTranscode;
  const audioCopy = allAudioOk && !forceTranscode;
  const mode: PlaybackMode = videoCopy && audioCopy ? "hls_remux" : "hls_transcode";

  return {
    status: "ok",
    playback_mode: mode,
    direct_playable: false,
    audio_tracks: audioTracks,
    video_copy: videoCopy,
    audio_copy: audioCopy,
    duration_sec: durationSec,
  };
}

async function ffprobeExec(
  target: string,
  timeoutSec: number,
  onTick?: (elapsed: number) => void,
): Promise<Record<string, unknown>> {
  const cmd = [
    "ffprobe",
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
  ];
  if (target.includes("://")) {
    cmd.push("-probesize", String(32 * 1024 * 1024), "-analyzeduration", String(15 * 1_000_000));
  }
  cmd.push(target);

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const start = Date.now();
    const tickTimer = setInterval(() => {
      if (onTick) onTick(Math.floor((Date.now() - start) / 1000));
    }, 1000);

    const timeoutTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffprobe timed out"));
    }, timeoutSec * 1000);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.on("error", (e) => {
      clearInterval(tickTimer);
      clearTimeout(timeoutTimer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearInterval(tickTimer);
      clearTimeout(timeoutTimer);
      if (code !== 0) {
        const err = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(err || `ffprobe exit ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function ffprobeUrl(
  url: string,
  timeoutSec: number,
  onTick?: (elapsed: number) => void,
): Promise<Record<string, unknown>> {
  return ffprobeExec(url, timeoutSec, onTick);
}

export async function ffprobePath(path: string, timeoutSec: number): Promise<Record<string, unknown>> {
  return ffprobeExec(path, timeoutSec);
}

export async function probePlayback(opts: {
  url: string;
  filePath: string;
  allowHevc: boolean;
  timeout: number;
  retries: number;
  retryDelay: number;
  onAttempt?: (attempt: number, total: number) => void;
  onTick?: (elapsed: number, subphase: string) => void;
}): Promise<ProbeResult> {
  let lastErr: unknown;
  const total = Math.max(1, opts.retries);
  for (let attempt = 0; attempt < total; attempt++) {
    opts.onAttempt?.(attempt + 1, total);
    try {
      const data = await ffprobeUrl(opts.url, opts.timeout, opts.onTick
        ? (elapsed) => opts.onTick!(elapsed, "analyze_stream")
        : undefined);
      return parseProbePayload(data, opts.filePath, opts.allowHevc);
    } catch (e) {
      lastErr = e;
      const msg = String(e).toLowerCase();
      const pending = [
        "invalid data",
        "could not find codec",
        "end of file",
        "connection",
        "404",
        "403",
        "timed out",
        "i/o error",
      ].some((x) => msg.includes(x));
      if (pending && attempt < total - 1) {
        console.info(`probe retry ${attempt + 1}/${total}:`, e);
        opts.onTick?.(0, "retry_wait");
        await new Promise((r) => setTimeout(r, opts.retryDelay * 1000));
        continue;
      }
      if (pending) return pendingResult();
      throw e;
    }
  }
  if (lastErr) console.warn("probe failed:", lastErr);
  return pendingResult();
}

function pendingResult(): ProbeResult {
  return {
    status: "pending",
    playback_mode: "direct",
    direct_playable: true,
    audio_tracks: [],
    video_copy: false,
    audio_copy: false,
    duration_sec: null,
  };
}
