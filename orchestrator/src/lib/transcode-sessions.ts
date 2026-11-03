import { randomUUID } from "node:crypto";
import { rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TranscoderClient } from "../clients/transcoder.js";
import type { PlaybackMode } from "./models.js";
import type { ProbeResult } from "./playback-probe.js";
import { pickFfmpegSource } from "./source-pick.js";
import {
  buildFfmpegCommand,
  finalizeHlsPlaylist,
  PLAYLIST_NAME,
  spawnFfmpeg,
  terminateProcess,
  waitForPlaylist,
} from "./transcode-ffmpeg.js";
import type { ChildProcess } from "node:child_process";

const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;

export interface TranscodeSession {
  session_id: string;
  info_hash: string;
  file_index: number;
  file_path: string;
  source_url: string;
  playback_mode: PlaybackMode;
  video_copy: boolean;
  audio_copy: boolean;
  audio_ordinal: number;
  start_sec: number;
  out_dir: string;
  video_height: number | null;
  remote_session: boolean;
  process: ChildProcess | null;
  created_at: number;
  last_access: number;
  ffmpeg_started: boolean;
}

export class TranscodeSessionManager {
  private sessions = new Map<string, TranscodeSession>();

  constructor(
    readonly workDir: string,
    readonly maxSessions: number,
    readonly ttlSec: number,
    readonly publicBaseUrl: string,
    private readonly transcoder: TranscoderClient | null = null,
  ) {
    this.maxSessions = Math.max(1, maxSessions);
    this.ttlSec = Math.max(30, ttlSec);
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
  }

  playbackUrl(sessionId: string): string {
    return `/api/transcode/${sessionId}/${PLAYLIST_NAME}`;
  }

  async createSession(opts: {
    infoHash: string;
    fileIndex: number;
    filePath: string;
    sourceUrl: string;
    probe: ProbeResult;
    audioOrdinal: number;
    startSec?: number;
    videoHeight?: number | null;
    relativePath?: string;
    fileLength?: number | null;
  }): Promise<TranscodeSession> {
    await this.purgeExpired();
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `Достигнут лимит перекодирования (${this.maxSessions} одновременных потоков). ` +
          "Закройте плеер на другом устройстве, подождите ~минуту или увеличьте " +
          "TRANSCODE_MAX_SESSIONS в .env и перезапустите orchestrator/transcoder.",
      );
    }

    const sessionId = randomUUID();
    const outDir = join(this.workDir, sessionId);
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });

    const localSession: TranscodeSession = {
      session_id: sessionId,
      info_hash: opts.infoHash.toLowerCase(),
      file_index: opts.fileIndex,
      file_path: opts.filePath,
      source_url: opts.sourceUrl,
      playback_mode: opts.probe.playback_mode,
      video_copy: opts.probe.video_copy,
      audio_copy: opts.probe.audio_copy,
      audio_ordinal: Math.max(0, opts.audioOrdinal),
      start_sec: Math.max(0, opts.startSec ?? 0),
      out_dir: outDir,
      video_height: opts.videoHeight ?? null,
      remote_session: false,
      process: null,
      created_at: Date.now() / 1000,
      last_access: Date.now() / 1000,
      ffmpeg_started: false,
    };

    let session = localSession;
    if (this.transcoder) {
      const remote = await this.transcoder.createSession({
        infoHash: opts.infoHash.toLowerCase(),
        fileIndex: opts.fileIndex,
        relativePath: opts.relativePath || opts.filePath,
        playbackMode: opts.probe.playback_mode,
        videoCopy: opts.probe.video_copy,
        audioCopy: opts.probe.audio_copy,
        audioIndex: Math.max(0, opts.audioOrdinal),
        startSec: Math.max(0, opts.startSec ?? 0),
        videoHeight: opts.videoHeight,
        sourceUrl: opts.sourceUrl,
        fileLength: opts.fileLength,
      });
      session = {
        ...localSession,
        session_id: String(remote.session_id),
        out_dir: String(remote.out_dir ?? join(this.workDir, String(remote.session_id))),
        remote_session: true,
        ffmpeg_started: true,
      };
    }

    this.sessions.set(session.session_id, session);
    return session;
  }

  async get(sessionId: string): Promise<TranscodeSession | null> {
    const session = this.sessions.get(sessionId);
    if (session) session.last_access = Date.now() / 1000;
    return session ?? null;
  }

  async sessionCount(): Promise<number> {
    await this.purgeExpired();
    return this.sessions.size;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.remote_session && this.transcoder) {
      await this.transcoder.stopSession(sessionId);
    }
    terminateProcess(session.process);
    if (!session.remote_session) {
      try {
        rmSync(session.out_dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  markPlaylistCompleteIfFfmpegDone(session: TranscodeSession): void {
    const proc = session.process;
    if (proc && proc.exitCode != null) finalizeHlsPlaylist(session.out_dir);
  }

  async ensureFfmpeg(session: TranscodeSession): Promise<void> {
    if (session.remote_session && session.ffmpeg_started) {
      session.last_access = Date.now() / 1000;
      return;
    }
    if (session.ffmpeg_started && session.process && session.process.exitCode == null) {
      session.last_access = Date.now() / 1000;
      return;
    }
    if (session.ffmpeg_started && session.process && session.process.exitCode != null) {
      this.markPlaylistCompleteIfFfmpegDone(session);
      session.last_access = Date.now() / 1000;
      return;
    }

    const source =
      pickFfmpegSource(session.file_path, session.source_url, null) ??
      session.source_url;
    const cmd = buildFfmpegCommand(source, session.out_dir, {
      playbackMode: session.playback_mode,
      videoCopy: session.video_copy,
      audioCopy: session.audio_copy,
      audioOrdinal: session.audio_ordinal,
      startSec: session.start_sec,
      videoHeight: session.video_height,
    });
    session.process = spawnFfmpeg(cmd);
    session.ffmpeg_started = true;
    session.last_access = Date.now() / 1000;
  }

  resolveFile(session: TranscodeSession, filename: string): string {
    if (!SAFE_FILENAME.test(filename)) throw new Error("Invalid segment name");
    const root = resolve(session.out_dir);
    const path = resolve(root, filename);
    if (!path.startsWith(root + "/") && path !== root) throw new Error("Path traversal");
    if (!existsSync(path)) throw new Error(filename);
    return path;
  }

  startCleanupLoop(intervalSec = 30): NodeJS.Timeout {
    return setInterval(() => {
      void this.purgeExpired();
    }, intervalSec * 1000);
  }

  private async purgeExpired(): Promise<void> {
    const now = Date.now() / 1000;
    const expired = [...this.sessions.entries()]
      .filter(([, s]) => now - s.last_access > this.ttlSec)
      .map(([id]) => id);
    for (const sid of expired) {
      await this.stop(sid);
      console.info(`transcode session expired: ${sid}`);
    }
  }
}

export async function waitPlaylistReady(
  session: TranscodeSession,
  timeoutSec = 120,
  transcoder: TranscoderClient | null = null,
): Promise<boolean> {
  if (session.remote_session && transcoder) {
    return transcoder.waitPlaylist(session.session_id, session.out_dir, timeoutSec);
  }
  return waitForPlaylist(session.out_dir, timeoutSec);
}
