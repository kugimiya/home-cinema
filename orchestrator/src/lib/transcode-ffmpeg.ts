import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PlaybackMode } from "./models.js";

export const PLAYLIST_NAME = "index.m3u8";

export function buildFfmpegCommand(
  sourceUrl: string,
  outDir: string,
  opts: {
    playbackMode: PlaybackMode;
    videoCopy: boolean;
    audioCopy: boolean;
    audioOrdinal: number;
    startSec: number;
  },
): string[] {
  mkdirSync(outDir, { recursive: true });
  const playlist = join(outDir, PLAYLIST_NAME);
  const segmentPattern = join(outDir, "seg_%03d.m4s");

  const cmd: string[] = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y"];
  if (opts.startSec > 0.05) cmd.push("-ss", opts.startSec.toFixed(3));
  cmd.push(
    "-fflags",
    "+genpts+discardcorrupt",
    "-probesize",
    "32M",
    "-analyzeduration",
    "10M",
    "-i",
    sourceUrl,
    "-map",
    "0:v:0",
    "-map",
    `0:a:${opts.audioOrdinal}?`,
  );

  if (opts.playbackMode === "hls_remux" && opts.videoCopy && opts.audioCopy) {
    cmd.push("-c:v", "copy", "-c:a", "copy");
  } else {
    if (opts.videoCopy) cmd.push("-c:v", "copy");
    else {
      cmd.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "main");
    }
    if (opts.audioCopy) cmd.push("-c:a", "copy");
    else cmd.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  }

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
  return cmd;
}

export function spawnFfmpeg(cmd: string[]): ChildProcess {
  console.info(`starting ffmpeg: ${cmd.slice(0, 8).join(" ")}`);
  return spawn(cmd[0]!, cmd.slice(1), {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
}

export async function waitForPlaylist(outDir: string, timeoutSec = 120): Promise<boolean> {
  const playlist = join(outDir, PLAYLIST_NAME);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (existsSync(playlist) && statSync(playlist).size > 0) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export function finalizeHlsPlaylist(outDir: string): boolean {
  const playlist = join(outDir, PLAYLIST_NAME);
  if (!existsSync(playlist)) return false;
  const text = readFileSync(playlist, "utf8");
  if (text.includes("#EXT-X-ENDLIST")) return false;
  writeFileSync(playlist, `${text.trim()}\n#EXT-X-ENDLIST\n`, "utf8");
  return true;
}

export function isHlsPlaylistComplete(outDir: string): boolean {
  const playlist = join(outDir, PLAYLIST_NAME);
  if (!existsSync(playlist)) return false;
  try {
    return readFileSync(playlist, "utf8").includes("#EXT-X-ENDLIST");
  } catch {
    return false;
  }
}

export function terminateProcess(proc: ChildProcess | null | undefined): void {
  if (!proc || proc.exitCode != null || proc.killed) return;
  try {
    if (proc.pid) process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
