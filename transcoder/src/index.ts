import fs from "node:fs";
import path from "node:path";

import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { z } from "zod";

import { loadSettings } from "./config.js";
import { findTorrentMediaFile } from "./media-paths.js";
import { PLAYLIST_NAME } from "./ffmpeg-builder.js";
import { SessionManager } from "./sessions.js";

const settings = loadSettings();
const mgr = new SessionManager(settings.workDir, settings.maxSessions);

const playbackModeSchema = z.enum(["direct", "hls_transcode", "hls_remux", "hls_audio"]);

const createSessionBody = z.object({
  hash: z.string(),
  file_index: z.number().int(),
  relative_path: z.string().optional().default(""),
  video_height: z.number().int().nullable().optional(),
  audio_index: z.number().int().optional().default(0),
  start_sec: z.number().optional().default(0),
  playback_mode: playbackModeSchema.optional().default("hls_transcode"),
  video_copy: z.boolean().optional().default(false),
  audio_copy: z.boolean().optional().default(false),
  source_path: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
});

function resolveSourcePath(body: z.infer<typeof createSessionBody>): {
  path: string | null;
  url: string | null;
} {
  if (body.source_path && fs.statSync(body.source_path, { throwIfNoEntry: false })?.isFile()) {
    return { path: body.source_path, url: body.source_url ?? null };
  }
  if (body.relative_path) {
    const found = findTorrentMediaFile(settings.torrentsPath, body.relative_path);
    if (found) {
      return { path: found, url: body.source_url ?? null };
    }
    const legacy = path.join(
      settings.torrentsPath,
      body.hash.toLowerCase(),
      body.relative_path,
    );
    if (fs.statSync(legacy, { throwIfNoEntry: false })?.isFile()) {
      return { path: legacy, url: body.source_url ?? null };
    }
  }
  return { path: null, url: body.source_url ?? null };
}

const app = Fastify({ logger: true });
await app.register(sensible);

app.get("/health", async () => ({ status: "ok" }));

app.post("/v1/sessions", async (req, reply) => {
  const body = createSessionBody.parse(req.body);
  let { path: sourcePath, url: sourceUrl } = resolveSourcePath(body);
  if (!sourcePath && !sourceUrl) {
    sourceUrl = `${settings.torrentEngineUrl.replace(/\/$/, "")}/v1/torrents/${body.hash.toLowerCase()}/files/${body.file_index}/stream`;
  }
  try {
    const session = await mgr.create({
      sourcePath,
      sourceUrl,
      playbackMode: body.playback_mode,
      videoCopy: body.video_copy,
      audioCopy: body.audio_copy,
      audioOrdinal: body.audio_index,
      startSec: body.start_sec,
      videoHeight: body.video_height ?? null,
    });
    return {
      session_id: session.sessionId,
      out_dir: session.outDir,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("No valid source")) {
      return reply.notFound(msg);
    }
    if (msg.includes("max sessions")) {
      return reply.serviceUnavailable(msg);
    }
    throw e;
  }
});

app.get<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId/status",
  async (req, reply) => {
    const session = mgr.get(req.params.sessionId);
    if (!session) {
      return reply.notFound("Session not found");
    }
    const proc = session.process;
    const playlist = path.join(session.outDir, PLAYLIST_NAME);
    const st = fs.statSync(playlist, { throwIfNoEntry: false });
    return {
      session_id: req.params.sessionId,
      ffmpeg_running: proc !== null && proc.exitCode === null,
      ffmpeg_returncode: proc?.exitCode ?? null,
      playlist_ready: Boolean(st?.isFile() && st.size > 0),
    };
  },
);

app.delete<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId",
  async (req) => {
    await mgr.stop(req.params.sessionId);
    return { status: "stopped" };
  },
);

app.get<{ Params: { sessionId: string; filename: string } }>(
  "/v1/sessions/:sessionId/:filename",
  async (req, reply) => {
    try {
      const filePath = mgr.resolveFile(req.params.sessionId, req.params.filename);
      const media = req.params.filename.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : req.params.filename.endsWith(".m4s") || req.params.filename.endsWith(".mp4")
          ? "video/mp4"
          : "application/octet-stream";
      return reply.type(media).send(fs.createReadStream(filePath));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.notFound(msg);
    }
  },
);

await app.listen({ host: settings.host, port: settings.port });
