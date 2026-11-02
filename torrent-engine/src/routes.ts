import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createLogger } from "./logging.js";
import { TorrentMode, parseTorrentMode } from "./modes.js";
import { getManager } from "./session-manager.js";
import { fmtBytes } from "./fmt-bytes.js";

const logger = createLogger("routes");

const STREAM_CHUNK = 512 * 1024;
const RANGE = /^bytes=(\d+)-(\d*)$/;

const addTorrentBody = z.object({
  link: z.string().optional().default(""),
  title: z.string().optional().default("Untitled"),
  save_to_db: z.boolean().optional().default(true),
  torrent_b64: z.string().nullable().optional(),
  magnet: z.string().nullable().optional(),
});

const scopeBody = z.object({
  file_ids: z.array(z.number()).optional().default([]),
});

const modeBody = z.object({
  mode: z.string(),
});

const heartbeatBody = z.object({
  file_ids: z.array(z.number()).optional().default([]),
  stream_active: z.boolean().optional().default(true),
});

function parseRange(header: string | undefined, fileSize: number): [number, number] {
  if (!header) return [0, Math.max(0, fileSize - 1)];
  const m = RANGE.exec(header.trim());
  if (!m) return [0, Math.max(0, fileSize - 1)];
  const start = Number.parseInt(m[1]!, 10);
  const endS = m[2];
  const end = endS ? Number.parseInt(endS, 10) : Math.max(0, fileSize - 1);
  return [start, Math.min(end, Math.max(0, fileSize - 1))];
}

async function streamResponse(
  infoHash: string,
  fileIndex: number,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const mgr = getManager();
  const detail = await mgr.getTorrent(infoHash);
  if (!detail) {
    reply.code(404).send({ detail: "Torrent not found" });
    return;
  }

  const files = (detail.file_stats as Array<{ id?: number; length?: number }>) ?? [];
  let length = 0;
  for (const f of files) {
    if (Number(f.id ?? 0) === fileIndex) {
      length = Number(f.length ?? 0);
      break;
    }
  }
  if (length <= 0) {
    reply.code(404).send({ detail: "File not found" });
    return;
  }

  const rangeHeader = request.headers.range;
  const [start, end] = parseRange(rangeHeader, length);
  await mgr.setScope(infoHash, [fileIndex]);
  await mgr.setMode(infoHash, TorrentMode.streaming);

  const span = end - start + 1;
  logger.info(
    `stream hash=${infoHash.slice(0, 8)} file=${fileIndex} http_range=${rangeHeader ?? "(full file)"} bytes=${start}-${end} span=${span} (${fmtBytes(span)}) file_size=${length} (${fmtBytes(length)})`,
  );

  const useChunked = span > STREAM_CHUNK || !rangeHeader;

  if (!useChunked) {
    try {
      const data = await mgr.readFileRange(infoHash, fileIndex, start, end, 120);
      reply
        .code(206)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", String(data.length))
        .header("Content-Range", `bytes ${start}-${start + data.length - 1}/${length}`)
        .type("application/octet-stream")
        .send(data);
    } catch (e) {
      if (e instanceof Error && e.message.includes("not found")) {
        reply.code(404).send({ detail: e.message });
        return;
      }
      if (e instanceof Error && /timeout|Timed out/i.test(e.message)) {
        reply.code(504).send({ detail: e.message });
        return;
      }
      throw e;
    }
    return;
  }

  const statusCode = rangeHeader ? 206 : 200;
  const headers: Record<string, string | number> = {
    "Accept-Ranges": "bytes",
    "Content-Length": String(span),
    "Content-Type": "application/octet-stream",
  };
  if (rangeHeader) {
    headers["Content-Range"] = `bytes ${start}-${end}/${length}`;
  }

  reply.hijack();
  reply.raw.writeHead(statusCode, headers);

  let pos = start;
  while (pos <= end) {
    const chunkEnd = Math.min(end, pos + STREAM_CHUNK - 1);
    let data: Buffer;
    try {
      data = await mgr.readFileRange(infoHash, fileIndex, pos, chunkEnd, 120);
    } catch (e) {
      if (e instanceof Error && /not found|missing/i.test(e.message)) {
        logger.warn(
          `stream abort hash=${infoHash.slice(0, 8)} file=${fileIndex} at=${pos} (missing file)`,
        );
        break;
      }
      if (e instanceof Error && /timeout|Timed out/i.test(e.message)) {
        logger.warn(
          `stream abort hash=${infoHash.slice(0, 8)} file=${fileIndex} at=${pos} (timeout)`,
        );
        break;
      }
      throw e;
    }
    if (!data.length) break;
    if (!reply.raw.write(data)) {
      await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
    }
    pos += data.length;
  }
  reply.raw.end();
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/", async () => ({ service: "torrent-engine", status: "ok" }));

  app.post("/v1/torrents", async (request, reply) => {
    const body = addTorrentBody.parse(request.body);
    const mgr = getManager();
    try {
      let detail: Record<string, unknown>;
      if (body.torrent_b64) {
        const raw = Buffer.from(body.torrent_b64, "base64");
        const magnet = (body.magnet ?? body.link ?? "").trim();
        detail = await mgr.addTorrentBytes(raw, body.title, {
          magnet,
          saveToDb: body.save_to_db,
        });
      } else {
        const link = body.link.trim();
        if (!link) {
          reply.code(400).send({ detail: "link or torrent_b64 required" });
          return;
        }
        detail = await mgr.addTorrent(link, body.title, body.save_to_db);
      }
      logger.info(
        `add_torrent title=${JSON.stringify(body.title)} hash=${String(detail.hash ?? "").slice(0, 8)} files=${((detail.file_stats as unknown[]) ?? []).length}`,
      );
      return detail;
    } catch (e) {
      logger.exception("add torrent failed", e);
      reply.code(400).send({ detail: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get("/v1/torrents", async () => getManager().listTorrents());

  app.get("/v1/session/status", async () => getManager().sessionStatus());

  app.get("/v1/alerts", async (request) => {
    const q = z
      .object({ limit: z.coerce.number().min(1).max(400).optional().default(100) })
      .parse(request.query);
    const items = await getManager().drainAlerts(q.limit);
    return { alerts: items, count: items.length };
  });

  app.get("/v1/torrents/:info_hash", async (request, reply) => {
    const { info_hash } = request.params as { info_hash: string };
    const detail = await getManager().getTorrent(info_hash.toLowerCase());
    if (!detail) {
      reply.code(404).send({ detail: "Not found" });
      return;
    }
    return detail;
  });

  app.delete("/v1/torrents/:info_hash", async (request) => {
    const { info_hash } = request.params as { info_hash: string };
    await getManager().removeTorrent(info_hash.toLowerCase());
    return { status: "removed", hash: info_hash.toLowerCase() };
  });

  app.post("/v1/torrents/:info_hash/scope", async (request) => {
    const { info_hash } = request.params as { info_hash: string };
    const body = scopeBody.parse(request.body);
    const h = info_hash.toLowerCase();
    logger.info(`set_scope hash=${h.slice(0, 8)} file_ids=${JSON.stringify(body.file_ids)}`);
    await getManager().setScope(h, body.file_ids);
    return { status: "ok", hash: h };
  });

  app.post("/v1/torrents/:info_hash/mode", async (request) => {
    const { info_hash } = request.params as { info_hash: string };
    const body = modeBody.parse(request.body);
    const mode = parseTorrentMode(body.mode);
    const h = info_hash.toLowerCase();
    logger.info(`set_mode hash=${h.slice(0, 8)} mode=${mode}`);
    await getManager().setMode(h, mode);
    return { status: "ok", hash: h, mode: mode };
  });

  app.post("/v1/torrents/:info_hash/heartbeat", async (request) => {
    const { info_hash } = request.params as { info_hash: string };
    const body = heartbeatBody.parse(request.body);
    await getManager().heartbeat(info_hash.toLowerCase(), body.file_ids, body.stream_active);
    return { status: "ok" };
  });

  app.get("/v1/torrents/:info_hash/files/:file_index/stream", async (request, reply) => {
    const { info_hash, file_index } = request.params as {
      info_hash: string;
      file_index: string;
    };
    await streamResponse(info_hash.toLowerCase(), Number.parseInt(file_index, 10), request, reply);
  });

  app.get("/stream/*", async (request, reply) => {
    const filePath = (request.params as { "*": string })["*"] ?? "";
    const q = z
      .object({
        link: z.string(),
        index: z.coerce.number().optional().default(1),
      })
      .parse(request.query);
    void decodeURIComponent(filePath);
    await streamResponse(q.link.toLowerCase(), q.index, request, reply);
  });
}
