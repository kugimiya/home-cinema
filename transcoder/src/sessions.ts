import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  buildFfmpegCommand,
  PLAYLIST_NAME,
  type PlaybackMode,
} from "./ffmpeg-builder.js";

export type TranscodeSession = {
  sessionId: string;
  source: string;
  outDir: string;
  playbackMode: PlaybackMode;
  process: ChildProcess | null;
  createdAt: number;
};

export class SessionManager {
  private readonly workDir: string;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, TranscodeSession>();
  private lock: Promise<void> = Promise.resolve();

  constructor(workDir: string, maxSessions: number) {
    this.workDir = workDir;
    fs.mkdirSync(workDir, { recursive: true });
    this.maxSessions = Math.max(1, maxSessions);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async create(opts: {
    sourcePath: string | null;
    sourceUrl: string | null;
    playbackMode: PlaybackMode;
    videoCopy: boolean;
    audioCopy: boolean;
    audioOrdinal: number;
    startSec: number;
    videoHeight: number | null;
  }): Promise<TranscodeSession> {
    return this.withLock(async () => {
      this.purgeFinishedUnlock();
      while (this.sessions.size >= this.maxSessions) {
        if (!this.evictOldestUnlock()) {
          throw new Error(
            "max sessions reached — закройте другой просмотр или подождите",
          );
        }
      }

      const source =
        opts.sourcePath && fs.statSync(opts.sourcePath, { throwIfNoEntry: false })?.isFile()
          ? opts.sourcePath
          : opts.sourceUrl;
      if (!source) {
        throw new Error("No valid source_path or source_url");
      }

      const sessionId = randomUUID();
      const outDir = path.join(this.workDir, sessionId);
      const cmd = buildFfmpegCommand(source, outDir, {
        playbackMode: opts.playbackMode,
        videoCopy: opts.videoCopy,
        audioCopy: opts.audioCopy,
        audioOrdinal: opts.audioOrdinal,
        startSec: opts.startSec,
        videoHeight: opts.videoHeight,
      });

      fs.mkdirSync(outDir, { recursive: true });
      const logPath = path.join(outDir, "ffmpeg.log");
      const logFile = createWriteStream(logPath);

      const proc = spawn(cmd[0]!, cmd.slice(1), {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      proc.stderr?.pipe(logFile);

      proc.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          console.error(`ffmpeg exit session=${sessionId.slice(0, 8)} code=${code}`);
        }
      });

      const session: TranscodeSession = {
        sessionId,
        source,
        outDir,
        playbackMode: opts.playbackMode,
        process: proc,
        createdAt: Date.now() / 1000,
      };
      this.sessions.set(sessionId, session);
      return session;
    });
  }

  private purgeFinishedUnlock(): void {
    for (const [sid, s] of this.sessions) {
      if (s.process === null || s.process.exitCode !== null) {
        this.sessions.delete(sid);
      }
    }
  }

  private evictOldestUnlock(): boolean {
    if (this.sessions.size === 0) {
      return false;
    }
    let oldest: TranscodeSession | null = null;
    for (const s of this.sessions.values()) {
      if (!oldest || s.createdAt < oldest.createdAt) {
        oldest = s;
      }
    }
    if (!oldest) {
      return false;
    }
    this.sessions.delete(oldest.sessionId);
    if (oldest.process && oldest.process.exitCode === null) {
      try {
        process.kill(-oldest.process.pid!, "SIGTERM");
      } catch {
        try {
          oldest.process.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
    return true;
  }

  async stop(sessionId: string): Promise<void> {
    await this.withLock(async () => {
      const session = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      if (session?.process && session.process.exitCode === null) {
        try {
          process.kill(-session.process.pid!, "SIGTERM");
        } catch {
          session.process.kill("SIGTERM");
        }
      }
    });
  }

  get(sessionId: string): TranscodeSession | undefined {
    return this.sessions.get(sessionId);
  }

  resolveFile(sessionId: string, filename: string): string {
    if (
      filename !== PLAYLIST_NAME &&
      !filename.endsWith(".m4s") &&
      filename !== "init.mp4"
    ) {
      throw new Error("invalid segment");
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("session not found");
    }
    const filePath = path.join(session.outDir, filename);
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error("file not ready");
    }
    return filePath;
  }
}
