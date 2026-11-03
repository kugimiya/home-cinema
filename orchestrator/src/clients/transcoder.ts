import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fetchJson, fetchWithTimeout, HttpError } from "../lib/fetch-json.js";
import { findTorrentMediaFile } from "../lib/media-paths.js";
import type { PlaybackMode } from "../lib/models.js";
import { PLAYLIST_NAME } from "../lib/transcode-ffmpeg.js";

export class TranscoderClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    readonly torrentsSavePath: string,
    readonly timeout = 120,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private sourcePath(infoHash: string, relativePath: string): string | null {
    const found = findTorrentMediaFile(this.torrentsSavePath, relativePath);
    if (found && existsSync(found)) return found;
    const legacy = join(
      this.torrentsSavePath,
      infoHash.toLowerCase(),
      relativePath,
    );
    if (existsSync(legacy) && statSync(legacy).isFile()) return legacy;
    return null;
  }

  async createSession(opts: {
    infoHash: string;
    fileIndex: number;
    relativePath: string;
    playbackMode: PlaybackMode;
    videoCopy: boolean;
    audioCopy: boolean;
    audioIndex: number;
    startSec: number;
    videoHeight: number | null | undefined;
    sourceUrl: string;
    fileLength?: number | null;
  }): Promise<Record<string, unknown>> {
    const body = {
      hash: opts.infoHash.toLowerCase(),
      file_index: opts.fileIndex,
      relative_path: opts.relativePath,
      playback_mode: opts.playbackMode,
      video_copy: opts.videoCopy,
      audio_copy: opts.audioCopy,
      audio_index: opts.audioIndex,
      start_sec: opts.startSec,
      video_height: opts.videoHeight ?? null,
      source_path: this.sourcePath(opts.infoHash, opts.relativePath),
      source_url: opts.sourceUrl,
      file_length: opts.fileLength ?? null,
    };
    console.info(
      `transcoder create hash=${opts.infoHash.slice(0, 8)} file=${opts.fileIndex} url=${this.baseUrl}`,
    );
    const r = await fetchWithTimeout(`${this.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: this.timeout * 1000,
    });
    if (r.status >= 400) {
      let detail = await r.text();
      try {
        const payload = (await JSON.parse(detail)) as { detail?: string };
        if (payload.detail) detail = String(payload.detail);
      } catch {
        /* keep text */
      }
      console.error(
        `transcoder create failed hash=${opts.infoHash.slice(0, 8)} status=${r.status} detail=${detail.slice(0, 200)}`,
      );
      throw new HttpError(detail, r.status);
    }
    const data = (await r.json()) as Record<string, unknown>;
    console.info(
      `transcoder session ok hash=${opts.infoHash.slice(0, 8)} session_id=${String(data.session_id ?? "").slice(0, 8)}`,
    );
    return data;
  }

  async waitPlaylist(
    sessionId: string,
    outDir: string,
    timeout = 180,
  ): Promise<boolean> {
    const playlist = join(outDir, PLAYLIST_NAME);
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      try {
        const r = await fetchWithTimeout(
          `${this.baseUrl}/v1/sessions/${sessionId}/status`,
          { timeoutMs: 10_000 },
        );
        if (r.status === 200) {
          const st = (await r.json()) as Record<string, unknown>;
          const rc = st.ffmpeg_returncode;
          if (rc != null && parseInt(String(rc), 10) !== 0) {
            console.error(
              `transcoder ffmpeg failed session=${sessionId.slice(0, 8)} code=${rc}`,
            );
            return false;
          }
          if (st.playlist_ready) return true;
        }
      } catch {
        /* retry */
      }
      if (existsSync(playlist) && statSync(playlist).size > 0) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async stopSession(sessionId: string): Promise<void> {
    const r = await fetchWithTimeout(`${this.baseUrl}/v1/sessions/${sessionId}`, {
      method: "DELETE",
      timeoutMs: 30_000,
    });
    if (r.status !== 200 && r.status !== 404) {
      throw new HttpError(await r.text(), r.status);
    }
  }
}
