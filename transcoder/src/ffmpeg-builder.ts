import { mkdirSync } from "node:fs";
import path from "node:path";

export type PlaybackMode = "direct" | "hls_transcode" | "hls_remux" | "hls_audio";

export const PLAYLIST_NAME = "index.m3u8";
export const OPUS_TRANSCODE_BITRATE = "320k";

function appendHlsOutput(cmd: string[], outDir: string): void {
  const playlist = path.join(outDir, PLAYLIST_NAME);
  const segmentPattern = path.join(outDir, "seg_%03d.m4s");
  cmd.push(
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_list_size",
    "0",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_filename",
    segmentPattern,
    playlist,
  );
}

export function buildFfmpegCommand(
  source: string,
  outDir: string,
  opts: {
    playbackMode: PlaybackMode;
    videoCopy: boolean;
    audioCopy: boolean;
    audioOrdinal: number;
    startSec: number;
    videoHeight: number | null;
  },
): string[] {
  mkdirSync(outDir, { recursive: true });

  const cmd: string[] = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
  ];
  if (opts.startSec > 0.05) {
    cmd.push("-ss", opts.startSec.toFixed(3));
  }
  cmd.push(
    "-fflags",
    "+genpts+discardcorrupt",
    "-probesize",
    "32M",
    "-analyzeduration",
    "10M",
    "-i",
    source,
  );

  if (opts.playbackMode === "hls_audio") {
    cmd.push("-map", `0:a:${opts.audioOrdinal}?`, "-vn");
    cmd.push("-c:a", "libopus", "-b:a", OPUS_TRANSCODE_BITRATE, "-ac", "2");
    appendHlsOutput(cmd, outDir);
    return cmd;
  }

  cmd.push(
    "-map",
    "0:v:0",
    "-map",
    `0:a:${opts.audioOrdinal}?`,
  );

  let videoCopy = opts.videoCopy;
  let audioCopy = opts.audioCopy;
  const needScale = opts.videoHeight !== null && opts.videoHeight > 0;
  if (needScale) {
    videoCopy = false;
  }

  if (
    opts.playbackMode === "hls_remux" &&
    videoCopy &&
    audioCopy &&
    !needScale
  ) {
    cmd.push("-c:v", "copy", "-c:a", "copy");
  } else {
    if (videoCopy && !needScale) {
      cmd.push("-c:v", "copy");
    } else {
      cmd.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-profile:v",
        "main",
      );
      if (needScale && opts.videoHeight !== null) {
        cmd.push("-vf", `scale=-2:min(${opts.videoHeight}\\,ih)`);
      }
    }
    if (audioCopy) {
      cmd.push("-c:a", "copy");
    } else {
      cmd.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
    }
  }

  appendHlsOutput(cmd, outDir);
  return cmd;
}
