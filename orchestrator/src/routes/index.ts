import { createReadStream } from "node:fs";
import "@fastify/sensible";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../lib/app-context.js";
import type { MetaStore } from "../store.js";
import { BackgroundTasks } from "../lib/background-tasks.js";
import {
  buildDiscoverPayload,
  discoverPayloadAsDict,
} from "../lib/discovery.js";
import { PermissionError } from "../lib/docker-control.js";
import { fetchEngineDiagnostics } from "../lib/engine-diagnostics.js";
import { progressFromCache, uploadBytesPerFile } from "../lib/file-progress.js";
import { buildMediaCatalog, mediaKindForPath } from "../lib/media-files.js";
import type { Provider, TorrentMediaFile } from "../lib/models.js";
import {
  PlayRequestSchema,
  PlaySelectRequestSchema,
  ProviderSchema,
  TranscodeSessionRequestSchema,
  DownloadScopeBodySchema,
  PlaybackEndedBodySchema,
} from "../lib/models.js";
import { formatProbeStatusMessage, newProbeLiveStats } from "../lib/probe-messages.js";
import { removeHashHeads } from "../lib/probe-head.js";
import type { ProbeResult } from "../lib/playback-probe.js";
import { overlayWarmOnStats, warmSummaryForHash } from "../lib/probe-warm.js";
import { storageSummary, torrentOnDiskBytes } from "../lib/storage-stats.js";
import { buildSystemStatus, truncateActivity } from "../lib/system-status.js";
import { TorrentStateCache } from "../lib/torrent-cache.js";
import { extractFiles, infoHashFromMagnet } from "../lib/torrent-files.js";
import {
  TranscodeSessionManager,
  waitPlaylistReady,
} from "../lib/transcode-sessions.js";
import { isHlsPlaylistComplete } from "../lib/transcode-ffmpeg.js";
import { httpErrorDetail } from "../lib/fetch-json.js";
import { TimeoutError } from "../clients/torrent-engine.js";
import type { PlaySelectPhase } from "../lib/play-select-progress.js";

function needsTranscodeForQuality(probe: ProbeResult, videoHeight: number | null | undefined): boolean {
  if (videoHeight == null) return probe.playback_mode !== "direct";
  if (probe.playback_mode !== "direct") return true;
  return videoHeight > 0;
}

function probeForTranscodeSession(probe: ProbeResult, videoHeight: number | null | undefined): ProbeResult {
  if (videoHeight == null || videoHeight <= 0) return probe;
  let mode = probe.playback_mode;
  if (mode === "direct") mode = "hls_transcode";
  return {
    ...probe,
    playback_mode: mode,
    video_copy: false,
    direct_playable: false,
  };
}

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const {
    settings,
    store,
    searchService,
    torrentEngine,
    transcoder,
    transcodeMgr,
    torrentCache,
    activityTracker,
    probeCache,
    probeRunner,
    probeWarm,
    playSelectProgress,
    dockerControl,
    probeHeadDir,
  } = ctx;

  function catalogFromRaw(infoHash: string, raw: Array<Record<string, unknown>>): TorrentMediaFile[] {
    const h = infoHash.toLowerCase();
    return buildMediaCatalog(raw, (idx, path) => {
      const kind = mediaKindForPath(path);
      if (kind === "video" || kind === "subtitle" || kind === "audio") {
        return torrentEngine.buildStreamUrl(h, path, idx);
      }
      return null;
    });
  }

  async function mediaCatalog(infoHash: string): Promise<TorrentMediaFile[]> {
    return activityTracker.track("prepare", infoHash.slice(0, 8), async () => {
      const detail = await torrentCache.getTorrentDetail(infoHash);
      const raw = extractFiles(detail);
      if (!raw.length) {
        throw app.httpErrors.gatewayTimeout("No files in torrent metadata");
      }
      return catalogFromRaw(infoHash, raw);
    });
  }

  async function createTranscodePlayback(opts: {
    infoHash: string;
    fileIndex: number;
    filePath: string;
    streamUrl: string;
    probe: ProbeResult;
    fileLength?: number;
    audioIndex?: number;
    startSec?: number;
    videoHeight?: number | null;
    bg?: BackgroundTasks;
  }) {
    const probeUse = probeForTranscodeSession(opts.probe, opts.videoHeight);
    await torrentEngine.heartbeat(opts.infoHash, [opts.fileIndex], true);
    let session;
    try {
      session = await transcodeMgr.createSession({
        infoHash: opts.infoHash,
        fileIndex: opts.fileIndex,
        filePath: opts.filePath,
        sourceUrl: torrentEngine.buildInternalStreamUrl(
          opts.infoHash,
          opts.filePath,
          opts.fileIndex,
        ),
        probe: probeUse,
        audioOrdinal: opts.audioIndex ?? 0,
        startSec: opts.startSec ?? 0,
        videoHeight: opts.videoHeight,
        relativePath: opts.filePath,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("лимит")) {
        throw app.httpErrors.serviceUnavailable(e.message);
      }
      throw app.httpErrors.badGateway(String(e));
    }

    const startFfmpeg = async () => {
      const s = await transcodeMgr.get(session.session_id);
      if (!s) return;
      try {
        await transcodeMgr.ensureFfmpeg(s);
        const updated = await transcodeMgr.get(session.session_id);
        if (updated?.process && updated.process.exitCode == null) {
          updated.process.on("close", () => {
            void transcodeMgr.get(session.session_id).then((refreshed) => {
              if (refreshed) transcodeMgr.markPlaylistCompleteIfFfmpegDone(refreshed);
            });
          });
        }
      } catch (e) {
        app.log.error(e, "ffmpeg start failed");
      }
    };

    if (!session.remote_session) {
      if (opts.bg) opts.bg.add(() => void startFfmpeg());
      else await startFfmpeg();
    }

    const ready = await waitPlaylistReady(session, 120, transcoder);
    if (!ready) {
      await transcodeMgr.stop(session.session_id);
      throw app.httpErrors.serviceUnavailable(
        "Перекодирование не запустилось (ffmpeg). Проверьте лог transcoder или попробуйте снова.",
      );
    }

    return {
      hash: opts.infoHash,
      title: "",
      playback_mode: opts.probe.playback_mode,
      playback_url: transcodeMgr.playbackUrl(session.session_id),
      transcode_session_id: session.session_id,
      direct_playable: false,
      probe_status: "ok",
      stream_url: opts.streamUrl,
      file_name: opts.filePath,
      file_index: opts.fileIndex,
      audio_tracks: opts.probe.audio_tracks,
      selected_audio_index: opts.audioIndex ?? 0,
      duration_sec: opts.probe.duration_sec,
      file_length: opts.fileLength ?? null,
    };
  }

  async function playbackForVideo(
    infoHash: string,
    selected: TorrentMediaFile,
    opts: {
      audioIndex?: number;
      startSec?: number;
      videoHeight?: number | null;
      bg?: BackgroundTasks;
      onProbeAttempt?: (a: number, t: number) => void;
      onProbeLive?: (stats: ReturnType<typeof newProbeLiveStats>) => void;
      onTranscodeStart?: () => void;
    },
  ) {
    const probe = await probeRunner.probeFile(
      infoHash,
      selected.id,
      selected.path,
      selected.length,
      {
        allowHevc: settings.transcodeAllowHevcDirect,
        onAttempt: opts.onProbeAttempt,
        onLive: opts.onProbeLive,
      },
    );
    if (probe.status === "pending") {
      throw app.httpErrors.serviceUnavailable(
        "Файл ещё не готов для анализа. Подождите начала загрузки и попробуйте снова.",
      );
    }

    const baseFields = {
      stream_url: selected.stream_url,
      file_name: selected.path,
      file_index: selected.id,
      probe_status: "ok" as const,
      audio_tracks: probe.audio_tracks,
      selected_audio_index: opts.audioIndex ?? 0,
      duration_sec: probe.duration_sec,
      file_length: selected.length,
    };

    const useDirect =
      probe.playback_mode === "direct" && !needsTranscodeForQuality(probe, opts.videoHeight);
    if (useDirect) {
      return [
        {
          hash: infoHash,
          title: "",
          playback_mode: "direct" as const,
          playback_url: null,
          transcode_session_id: null,
          direct_playable: true,
          ...baseFields,
        },
        probe,
      ] as const;
    }

    if (!settings.transcodeEnabled) {
      return [
        {
          hash: infoHash,
          title: "",
          playback_mode: probe.playback_mode,
          direct_playable: false,
          ...baseFields,
        },
        probe,
      ] as const;
    }

    opts.onTranscodeStart?.();
    const resp = await createTranscodePlayback({
      infoHash,
      fileIndex: selected.id,
      filePath: selected.path,
      streamUrl: selected.stream_url ?? "",
      probe,
      fileLength: selected.length,
      audioIndex: opts.audioIndex,
      startSec: opts.startSec,
      videoHeight: opts.videoHeight,
      bg: opts.bg,
    });
    return [resp, probe] as const;
  }

  function selectVideoFile(
    files: TorrentMediaFile[],
    fileIndex: number | null | undefined,
  ): TorrentMediaFile | null {
    const videos = files.filter((f) => f.kind === "video");
    if (!videos.length) throw app.httpErrors.badRequest("No video files in torrent");
    if (fileIndex != null) {
      const video = videos.find((v) => v.id === fileIndex);
      if (!video) {
        throw app.httpErrors.badRequest(`Video file with index ${fileIndex} not found`);
      }
      return video;
    }
    if (videos.length === 1) return videos[0]!;
    return null;
  }

  async function resolveMagnetAndMeta(body: z.infer<typeof PlayRequestSchema>) {
    let magnet = body.magnet;
    let title = body.title ?? "Untitled";
    let quality: string | null = null;
    let voice: string | null = null;
    let providerStr: string | null = null;
    let externalId: string | null = null;
    let torrentUrl: string | null = null;

    if (body.provider && body.external_id) {
      let detail;
      try {
        detail = await searchService.releaseDetail(body.provider as Provider, body.external_id);
      } catch (e) {
        throw app.httpErrors.badGateway(`Release lookup failed: ${e}`);
      }
      magnet = magnet ?? detail.magnet;
      title = detail.title ?? title;
      quality = detail.quality ?? null;
      voice = detail.voice ?? null;
      providerStr = body.provider;
      externalId = body.external_id;
      torrentUrl = detail.torrent_url ?? null;
    }

    if (!magnet) throw app.httpErrors.badRequest("magnet link is required");
    return { magnet, title, quality, voice, providerStr, externalId, torrentUrl };
  }

  async function torrentPrepare(infoHash: string) {
    const h = infoHash.toLowerCase();
    const meta = store.get(h);
    let detail: Record<string, unknown>;
    try {
      detail = await activityTracker.track("prepare", h.slice(0, 8), () =>
        torrentCache.getTorrentDetail(h),
      );
    } catch (e) {
      throw app.httpErrors.badGateway(`torrent-engine: ${httpErrorDetail(e)}`);
    }

    if (!Object.keys(detail).length) {
      let retry = "";
      if (meta?.provider && meta.external_id) {
        retry = " Откройте раздачу в поиске и снова нажмите «Смотреть».";
      }
      return {
        hash: h,
        title: meta?.title ?? h,
        phase: "missing",
        message:
          "torrent-engine не смог получить метаданные (таймаут или раздача удалена)." +
          `${retry} Проверьте VPN/доступ к BitTorrent или выберите другую раздачу.`,
        ready: false,
        files: [],
      };
    }

    const title = String(detail.title ?? meta?.title ?? h);
    const stat = String(detail.stat_string ?? "ожидание");
    const peers =
      detail.total_peers != null ? parseInt(String(detail.total_peers), 10) : null;
    const raw = extractFiles(detail);
    if (!raw.length) {
      const hint =
        peers && peers > 50
          ? " Большие сборники (сотни серий) могут ждать метаданные несколько минут."
          : "";
      return {
        hash: h,
        title,
        phase: "metadata",
        message: `Получаем список файлов и подключаемся к пирам…${hint}`,
        stat_string: stat,
        total_peers: peers,
        ready: false,
        files: [],
      };
    }

    const catalog = catalogFromRaw(h, raw);
    return {
      hash: h,
      title,
      phase: "ready",
      message:
        "Выберите файл для просмотра. При просмотре выбранный файл качается в первую " +
        `очередь, остальные — в фоне (${catalog.length} файлов в раздаче).`,
      stat_string: stat,
      total_peers: peers,
      files: catalog,
      ready: true,
    };
  }

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/discover", async (request) => {
    const payload = buildDiscoverPayload(request, {
      version: "0.1.0",
      orchestratorPublicUrl: settings.orchestratorPublicUrl,
      torrentEnginePublicUrl: settings.torrentEnginePublicUrl,
      defaultApiPort: settings.orchestratorListenPort,
    });
    return discoverPayloadAsDict(payload);
  });

  app.get("/api/search", async (request) => {
    const q = z.string().min(1).parse((request.query as { q?: string }).q);
    const [source, releases] = await activityTracker.track("search", truncateActivity(q), () =>
      searchService.search(q),
    );
    ctx.lastSearchQuery = q;
    ctx.lastSearchAt = Date.now() / 1000;
    return { query: q, source, releases };
  });

  app.get("/api/system/status", async () =>
    buildSystemStatus({
      torrentEngineUrl: settings.torrentEngineUrl,
      torapiUrl: settings.torapiUrl,
      torrentCache,
      activity: activityTracker,
      transcodeMgr,
      docker: dockerControl,
      probeWarm,
      lastSearchQuery: ctx.lastSearchQuery,
      lastSearchAt: ctx.lastSearchAt,
    }),
  );

  app.post("/api/system/services/:serviceId/restart", async (request) => {
    const serviceId = (request.params as { serviceId: string }).serviceId;
    try {
      await dockerControl.restartContainer(serviceId);
    } catch (e) {
      if (e instanceof PermissionError) throw app.httpErrors.forbidden(String(e.message));
      throw app.httpErrors.badGateway(String(e));
    }
    return { status: "restarting", id: serviceId };
  });

  app.get("/api/engine/diagnostics", async (request) => {
    const alertLimit = z.coerce.number().min(1).max(400).default(120).parse(
      (request.query as { alert_limit?: string }).alert_limit,
    );
    return fetchEngineDiagnostics({
      torrentEngineUrl: settings.torrentEngineUrl,
      activity: activityTracker,
      transcodeMgr,
      probeWarm,
      alertLimit,
    });
  });

  app.get("/api/releases/:provider/:external_id", async (request) => {
    const params = request.params as { provider: string; external_id: string };
    const provider = ProviderSchema.parse(params.provider);
    try {
      return await searchService.releaseDetail(provider, params.external_id);
    } catch (e) {
      throw app.httpErrors.badGateway(httpErrorDetail(e));
    }
  });

  app.get("/api/torrents/:info_hash/media", async (request) => {
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    const detail = await torrentCache.getTorrentDetail(h);
    if (!Object.keys(detail).length) throw app.httpErrors.notFound("Torrent not found");
    const files = await mediaCatalog(h);
    const meta = store.get(h);
    const title = String(detail.title ?? meta?.title ?? h);
    return { hash: h, title, files };
  });

  app.get("/api/torrents/:info_hash/prepare", async (request) => {
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    return torrentPrepare(h);
  });

  app.post("/api/play/prepare", async (request) => {
    const body = PlayRequestSchema.parse(request.body);
    const { magnet, title, quality, voice, providerStr, externalId, torrentUrl } =
      await resolveMagnetAndMeta(body);

    let added: Record<string, unknown>;
    try {
      added = await activityTracker.track("prepare", "add", () =>
        torrentCache.ensureTorrent(magnet, title, true, torrentUrl),
      );
    } catch (e) {
      throw app.httpErrors.badGateway(`torrent-engine add failed: ${e}`);
    }

    const infoHash = String(added.hash ?? infoHashFromMagnet(magnet) ?? "").toLowerCase();
    if (!infoHash) throw app.httpErrors.badGateway("Could not determine info hash");

    store.upsert({
      info_hash: infoHash,
      title,
      provider: providerStr,
      external_id: externalId,
      quality,
      voice,
    });

    return torrentPrepare(infoHash);
  });

  app.get("/api/play/select/status", async (request) => {
    const hash = z.string().min(8).parse((request.query as { hash?: string }).hash);
    const st = playSelectProgress.get(hash);
    if (!st) return { active: false };
    return {
      active: true,
      hash: st.hash,
      step: st.step,
      step_total: st.step_total,
      phase: st.phase,
      message: st.message,
      probe_attempt: st.probe_attempt,
      probe_max: st.probe_max,
      probe_bytes_downloaded: st.probe_bytes_downloaded,
      probe_bytes_target: st.probe_bytes_target,
      probe_download_speed: st.probe_download_speed,
      probe_total_peers: st.probe_total_peers,
      probe_subphase: st.probe_subphase,
      probe_elapsed_sec: st.probe_elapsed_sec,
    };
  });

  async function playSelectHandler(
    body: z.infer<typeof PlaySelectRequestSchema>,
    bg: BackgroundTasks,
  ) {
    const h = body.hash.toLowerCase();
    const probeMax = Math.max(1, settings.transcodeProbeRetries);
    const stepTotal = 2 + probeMax + 1;
    const meta = store.get(h);
    let currentProbeAttempt = 1;

    const setProgress = (
      step: number,
      phase: PlaySelectPhase,
      message: string,
      extra: Partial<{
        probe_attempt: number;
        probe_max: number;
        probe_bytes_downloaded: number;
        probe_bytes_target: number;
        probe_download_speed: number | null;
        probe_total_peers: number | null;
        probe_subphase: string;
        probe_elapsed_sec: number;
      }> = {},
    ) => {
      playSelectProgress.set(h, {
        step,
        step_total: stepTotal,
        phase,
        message,
        probe_attempt: extra.probe_attempt ?? 0,
        probe_max: extra.probe_max ?? 0,
        probe_bytes_downloaded: extra.probe_bytes_downloaded ?? 0,
        probe_bytes_target: extra.probe_bytes_target ?? 0,
        probe_download_speed: extra.probe_download_speed ?? null,
        probe_total_peers: extra.probe_total_peers ?? null,
        probe_subphase: extra.probe_subphase ?? "",
        probe_elapsed_sec: extra.probe_elapsed_sec ?? 0,
      });
    };

    const applyProbeLive = (stats: ReturnType<typeof newProbeLiveStats>) => {
      const step = 2 + currentProbeAttempt;
      setProgress(
        step,
        "probe",
        formatProbeStatusMessage(stats, {
          step,
          stepTotal,
          attempt: currentProbeAttempt,
          attemptMax: probeMax,
        }),
        {
          probe_attempt: currentProbeAttempt,
          probe_max: probeMax,
          probe_bytes_downloaded: stats.bytes_downloaded,
          probe_bytes_target: stats.bytes_target,
          probe_download_speed: stats.download_speed,
          probe_total_peers: stats.total_peers,
          probe_subphase: stats.subphase,
          probe_elapsed_sec: stats.elapsed_sec,
        },
      );
    };

    try {
      setProgress(1, "torrent", "Этап 1: получаем состояние раздачи…");
      let detail: Record<string, unknown>;
      try {
        detail = await activityTracker.track("play_select", h.slice(0, 8), () =>
          torrentCache.getTorrentDetail(h),
        );
      } catch (e) {
        throw app.httpErrors.badGateway(`torrent-engine: ${httpErrorDetail(e)}`);
      }
      if (!Object.keys(detail).length) throw app.httpErrors.notFound("Torrent not found");

      const title = String(detail.title ?? meta?.title ?? h);
      const raw = extractFiles(detail);
      if (!raw.length) throw app.httpErrors.gatewayTimeout("No files in torrent metadata");
      const catalog = catalogFromRaw(h, raw);
      const selected = selectVideoFile(catalog, body.file_index);
      if (!selected) throw app.httpErrors.badRequest("Video file not found");

      setProgress(
        2,
        "priority",
        "Этап 2: включаем загрузку выбранного файла и фоновую дозагрузку остальных…",
      );
      const active = [body.file_index, ...(body.subtitle_file_ids ?? [])];
      try {
        for (const fileId of active) {
          await torrentEngine.setFilePriority(h, fileId, 7);
        }
      } catch (e) {
        throw app.httpErrors.badGateway(
          `Could not enable download for selected file: ${httpErrorDetail(e)}`,
        );
      }

      torrentCache.invalidateHash(h, ["list", "cache"]);
      bg.add(() => void torrentEngine.configureDownloadFiles(h, active, raw));

      const [playback] = await playbackForVideo(h, selected, {
        videoHeight: body.video_height,
        bg,
        onProbeAttempt: (attempt) => {
          currentProbeAttempt = attempt;
          applyProbeLive(newProbeLiveStats({ subphase: "analyze_stream" }));
        },
        onProbeLive: applyProbeLive,
        onTranscodeStart: () => {
          setProgress(
            stepTotal,
            "transcode",
            `Этап ${stepTotal} из ${stepTotal}: запуск перекодирования для браузера…`,
          );
        },
      });

      bg.add(() => void probeWarm.scheduleAuto(h, catalog, body.file_index));

      return {
        files: catalog,
        ...playback,
        hash: h,
        title,
      };
    } finally {
      playSelectProgress.clear(h);
    }
  }

  app.post("/api/play/select", async (request, reply) => {
    const body = PlaySelectRequestSchema.parse(request.body);
    const bg = new BackgroundTasks();
    reply.raw.on("finish", () => bg.run());
    const result = await playSelectHandler(body, bg);
    bg.run();
    return result;
  });

  app.post("/api/transcode/session", async (request, reply) => {
    if (!settings.transcodeEnabled) throw app.httpErrors.serviceUnavailable("Transcode disabled");
    const body = TranscodeSessionRequestSchema.parse(request.body);
    const bg = new BackgroundTasks();
    reply.raw.on("finish", () => bg.run());

    const h = body.hash.toLowerCase();
    let detail: Record<string, unknown>;
    try {
      detail = await activityTracker.track("transcode", h.slice(0, 8), () =>
        torrentCache.getTorrentDetail(h),
      );
    } catch (e) {
      throw app.httpErrors.badGateway(httpErrorDetail(e));
    }
    if (!Object.keys(detail).length) throw app.httpErrors.notFound("Torrent not found");

    const raw = extractFiles(detail);
    const catalog = catalogFromRaw(h, raw);
    const selected = selectVideoFile(catalog, body.file_index);
    if (!selected) throw app.httpErrors.badRequest("Video file not found");

    let probe = await probeRunner.probeFile(h, selected.id, selected.path, selected.length, {
      allowHevc: settings.transcodeAllowHevcDirect,
    });
    if (probe.status === "pending") {
      const cached = probeRunner.cachedProbeOk(h, selected.id, selected.path, selected.length);
      if (cached) probe = cached;
      else {
        throw app.httpErrors.serviceUnavailable(
          "Файл ещё не готов для перекодирования. Подождите загрузку.",
        );
      }
    }
    if (probe.playback_mode === "direct" && !needsTranscodeForQuality(probe, body.video_height)) {
      throw app.httpErrors.badRequest("Direct playback — transcode session not required");
    }

    if (body.replace_session_id) await transcodeMgr.stop(body.replace_session_id.trim());

    const probeUse = probeForTranscodeSession(probe, body.video_height);
    let session;
    try {
      session = await transcodeMgr.createSession({
        infoHash: h,
        fileIndex: selected.id,
        filePath: selected.path,
        sourceUrl: torrentEngine.buildInternalStreamUrl(h, selected.path, selected.id),
        probe: probeUse,
        audioOrdinal: body.audio_index,
        startSec: body.start_sec,
        videoHeight: body.video_height,
        relativePath: selected.path,
      });
    } catch (e) {
      throw app.httpErrors.serviceUnavailable(String(e));
    }

    if (!session.remote_session) {
      bg.add(async () => {
        await transcodeMgr.ensureFfmpeg(session);
      });
    } else {
      await torrentEngine.heartbeat(h, [selected.id], true);
    }

    const ready = await waitPlaylistReady(session, 120, transcoder);
    if (!ready) {
      await transcodeMgr.stop(session.session_id);
      throw app.httpErrors.serviceUnavailable(
        "Перекодирование не запустилось (ffmpeg). Попробуйте снова.",
      );
    }
    bg.run();
    return {
      session_id: session.session_id,
      playback_url: transcodeMgr.playbackUrl(session.session_id),
      playback_mode: probeUse.playback_mode,
      selected_audio_index: body.audio_index,
      start_sec: body.start_sec,
      audio_tracks: probe.audio_tracks,
      duration_sec: probe.duration_sec,
      file_length: selected.length,
    };
  });

  app.delete("/api/transcode/:session_id", async (request) => {
    const sessionId = (request.params as { session_id: string }).session_id;
    await transcodeMgr.stop(sessionId);
    return { status: "stopped", session_id: sessionId };
  });

  function mediaTypeForSegment(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
    if (lower.endsWith(".m4s")) return "video/iso.segment";
    if (lower.endsWith(".mp4")) return "video/mp4";
    return "application/octet-stream";
  }

  app.get("/api/transcode/:session_id/:filename", async (request, reply) => {
    const { session_id, filename } = request.params as {
      session_id: string;
      filename: string;
    };
    const session = await transcodeMgr.get(session_id);
    if (!session) throw app.httpErrors.notFound("Session not found");

    await transcodeMgr.ensureFfmpeg(session);
    transcodeMgr.markPlaylistCompleteIfFfmpegDone(session);

    if (filename.endsWith(".m3u8")) {
      const ready = await waitPlaylistReady(session, 180, transcoder);
      if (!ready) {
        throw app.httpErrors.serviceUnavailable(
          "Перекодирование ещё не готово. Подождите…",
        );
      }
    }

    let path: string;
    try {
      path = transcodeMgr.resolveFile(session, filename);
    } catch (e) {
      if (filename.endsWith(".m3u8")) {
        throw app.httpErrors.serviceUnavailable("Плейлист ещё не создан. Подождите…");
      }
      if (e instanceof Error && e.message.includes("Invalid")) {
        throw app.httpErrors.badRequest(e.message);
      }
      throw app.httpErrors.notFound("File not found");
    }

    let cacheControl = "no-cache";
    if (filename.endsWith(".m3u8") && isHlsPlaylistComplete(session.out_dir)) {
      cacheControl = "public, max-age=86400, immutable";
    }

    reply.header("Cache-Control", cacheControl);
    reply.type(mediaTypeForSegment(filename));
    return reply.send(createReadStream(path));
  });

  app.post("/api/torrents/:info_hash/download-scope", async (request) => {
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    const body = DownloadScopeBodySchema.parse(request.body);
    try {
      await torrentEngine.configureDownloadFiles(h, body.file_ids);
    } catch (e) {
      throw app.httpErrors.badGateway(String(e));
    }
    torrentCache.invalidateHash(h, ["list", "cache"]);
    return { status: "ok", hash: h };
  });

  app.post("/api/torrents/:info_hash/playback-ended", async (request) => {
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    const body = PlaybackEndedBodySchema.parse(request.body);
    try {
      await torrentEngine.playbackEnded(h, body.file_ids ?? []);
    } catch (e) {
      throw app.httpErrors.badGateway(String(e));
    }
    torrentCache.invalidateHash(h, ["list", "cache"]);
    return { status: "completing", hash: h };
  });

  app.post("/api/torrents/:info_hash/pause-download", async (request) => {
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    try {
      await torrentEngine.pauseAllFiles(h);
    } catch (e) {
      throw app.httpErrors.badGateway(String(e));
    }
    torrentCache.invalidateHash(h, ["list", "cache"]);
    probeWarm.cancelHash(h);
    return { status: "paused", hash: h };
  });

  app.get("/api/torrents/:info_hash/warm-probe", async (request) => {
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    return probeWarm.statusPayload(h);
  });

  app.post("/api/torrents/:info_hash/warm-probe", async (request, reply) => {
    if (!probeWarm.enabled) {
      throw app.httpErrors.badRequest("Прогрев ffprobe отключён (PROBE_WARM_BYTES=0).");
    }
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    let detail: Record<string, unknown>;
    try {
      detail = await torrentCache.getTorrentDetail(h);
    } catch (e) {
      throw app.httpErrors.badGateway(httpErrorDetail(e));
    }
    if (!Object.keys(detail).length) throw app.httpErrors.notFound("Torrent not found");
    const raw = extractFiles(detail);
    if (!raw.length) throw app.httpErrors.gatewayTimeout("No files in torrent metadata");
    const [queued, skipped] = await probeWarm.scheduleManual(h, raw);
    reply.status(202);
    return { status: "queued", queued, skipped };
  });

  app.post("/api/play", async (request, reply) => {
    const body = PlayRequestSchema.parse(request.body);
    let prepared = await (async () => {
      const prepBody = body;
      const { magnet, title, quality, voice, providerStr, externalId, torrentUrl } =
        await resolveMagnetAndMeta(prepBody);
      let added: Record<string, unknown>;
      try {
        added = await activityTracker.track("prepare", "add", () =>
          torrentCache.ensureTorrent(magnet, title, true, torrentUrl),
        );
      } catch (e) {
        throw app.httpErrors.badGateway(`torrent-engine add failed: ${e}`);
      }
      const infoHash = String(added.hash ?? infoHashFromMagnet(magnet) ?? "").toLowerCase();
      store.upsert({
        info_hash: infoHash,
        title,
        provider: providerStr,
        external_id: externalId,
        quality,
        voice,
      });
      return torrentPrepare(infoHash);
    })();

    if (!prepared.ready) {
      try {
        await torrentEngine.waitForFiles(prepared.hash);
      } catch (e) {
        if (e instanceof TimeoutError) throw app.httpErrors.gatewayTimeout(String(e.message));
        throw e;
      }
      prepared = await torrentPrepare(prepared.hash);
    }

    const bg = new BackgroundTasks();
    if (body.file_index != null) {
      const result = await playSelectHandler(
        { hash: prepared.hash, file_index: body.file_index, subtitle_file_ids: [] },
        bg,
      );
      bg.run();
      return result;
    }

    const catalog = prepared.files ?? [];
    const selected = selectVideoFile(catalog, null);
    if (selected) {
      const result = await playSelectHandler(
        { hash: prepared.hash, file_index: selected.id, subtitle_file_ids: [] },
        bg,
      );
      bg.run();
      return result;
    }

    return { hash: prepared.hash, title: prepared.title, files: catalog };
  });

  function torrentDownloadSpeed(item: Record<string, unknown>): number | null {
    for (const key of ["download_speed", "DownloadSpeed", "downloadSpeed"]) {
      const val = item[key];
      if (val != null) {
        const n = parseFloat(String(val));
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  }

  function torrentBytesWrittenData(item: Record<string, unknown>): number {
    for (const key of ["bytes_written_data", "BytesWrittenData", "bytes_written"]) {
      const val = item[key];
      if (val != null) {
        const n = parseInt(String(val), 10);
        if (Number.isFinite(n)) return Math.max(0, n);
      }
    }
    return 0;
  }

  function buildFileStats(
    rawFiles: Array<Record<string, unknown>>,
    cache: Record<string, unknown>,
    downloadSpeed: number | null,
    bytesWrittenData?: number | null,
  ) {
    const progress = progressFromCache(rawFiles, cache);
    const uploadMap = uploadBytesPerFile(progress, bytesWrittenData);
    const activeIds = Object.entries(progress)
      .filter(([, p]) => (p?.priority ?? 0) >= 1)
      .map(([id]) => parseInt(id, 10));
    const speedFor = new Set<number>();
    if (downloadSpeed && downloadSpeed > 0 && activeIds.length) {
      if (activeIds.length === 1) speedFor.add(activeIds[0]!);
      else {
        speedFor.add(
          activeIds.reduce((best, i) =>
            (progress[i]?.priority ?? 0) > (progress[best]?.priority ?? 0) ? i : best,
          activeIds[0]!),
        );
      }
    }

    return rawFiles.map((f) => {
      const fid = parseInt(String(f.id ?? f.Id ?? 0), 10);
      const path = String(f.path ?? f.Path ?? "");
      const length = parseInt(String(f.length ?? f.Length ?? 0), 10);
      const prog = progress[fid] ?? { downloaded: 0, priority: 0 };
      let downloaded = prog.downloaded ?? 0;
      if (length > 0) downloaded = Math.min(downloaded, length);
      const completed = length > 0 && downloaded >= length * 0.995;
      return {
        id: fid,
        path,
        length,
        downloaded_bytes: downloaded,
        completed,
        priority: prog.priority ?? 0,
        download_speed: speedFor.has(fid) ? downloadSpeed : null,
        kind: mediaKindForPath(path),
        uploaded_bytes: uploadMap[fid] ?? 0,
      };
    });
  }

  function entryFromListItem(
    item: Record<string, unknown>,
    meta: ReturnType<MetaStore["get"]>,
    cache: Record<string, unknown>,
    torrentsBase: string,
  ) {
    const h = String(item.hash ?? "").toLowerCase();
    if (!h) return null;
    let fileStatsRaw = (item.file_stats as Array<Record<string, unknown>>) ?? [];
    if (!fileStatsRaw.length) fileStatsRaw = extractFiles(item);
    const dlSpeed = torrentDownloadSpeed(item);
    const reportedUpload = torrentBytesWrittenData(item);
    const lifetimeUpload = store.syncUploadLifetime(h, reportedUpload);
    const fileStatsBase = buildFileStats(fileStatsRaw, cache, dlSpeed, lifetimeUpload);
    const fileStats = overlayWarmOnStats(
      fileStatsBase.map((f) => ({
        ...f,
        warm_status: "off" as const,
        warm_bytes: 0,
        warm_target_bytes: 0,
        download_speed: f.download_speed ?? null,
      })),
      h,
      probeWarm,
    );
    const videoCount = fileStats.filter((f) => f.kind === "video").length;

    let loadedSize = item.loaded_size != null ? parseInt(String(item.loaded_size), 10) : null;
    if (!loadedSize) loadedSize = fileStats.reduce((s, f) => s + f.downloaded_bytes, 0);

    let torrentSize =
      item.torrent_size != null ? parseInt(String(item.torrent_size), 10) : null;
    if (!torrentSize) torrentSize = fileStats.reduce((s, f) => s + f.length, 0) || null;

    const filePaths = fileStatsRaw
      .map((f) => String(f.path ?? f.Path ?? ""))
      .filter(Boolean);

    const onDisk = torrentOnDiskBytes(torrentsBase, h, filePaths, loadedSize);

    return {
      hash: h,
      title: String(item.title ?? meta?.title ?? h),
      stat_string: item.stat_string != null ? String(item.stat_string) : null,
      torrent_size: torrentSize,
      loaded_size: loadedSize,
      preloaded_bytes:
        item.preloaded_bytes != null ? parseInt(String(item.preloaded_bytes), 10) : null,
      bytes_written_data: reportedUpload,
      uploaded_bytes: lifetimeUpload,
      download_speed: dlSpeed,
      upload_speed:
        item.upload_speed != null ? parseFloat(String(item.upload_speed)) : null,
      total_peers: item.total_peers != null ? parseInt(String(item.total_peers), 10) : null,
      connected_seeders:
        item.connected_seeders != null
          ? parseInt(String(item.connected_seeders), 10)
          : null,
      quality: meta?.quality ?? null,
      voice: meta?.voice ?? null,
      search_query: meta?.search_query ?? null,
      provider: meta?.provider ?? null,
      file_stats: fileStats,
      on_disk_bytes: onDisk,
      warm_summary: warmSummaryForHash(h, probeWarm, videoCount),
      probe_warm_enabled: probeWarm.enabled,
    };
  }

  app.get("/api/torrents", async (request) => {
    const detailParam = (request.query as { detail?: string }).detail;
    const detailHashes = new Set(
      (detailParam ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );

    const items = await activityTracker.track("torrents_list", null, () =>
      torrentCache.listItems({ maxAge: TorrentStateCache.LIST_TTL_LIBRARY }),
    );

    const torrentsBase = settings.torrentEngineSavePath;
    const itemsByHash = new Map(
      items.map((item) => [String(item.hash ?? "").toLowerCase(), item]),
    );

    const cacheByHash = new Map<string, Record<string, unknown>>();
    if (detailHashes.size) {
      await Promise.all(
        [...detailHashes].map(async (h) => {
          const item = itemsByHash.get(h) ?? {};
          if (!Object.keys(item).length) {
            cacheByHash.set(h, {});
            return;
          }
          const data = await torrentCache.getCachePieces(h, { listItem: item });
          cacheByHash.set(h, data);
        }),
      );
    }

    const entries = [];
    for (const item of items) {
      const h = String(item.hash ?? "").toLowerCase();
      const meta = h ? store.get(h) : null;
      const cache = detailHashes.has(h) ? (cacheByHash.get(h) ?? {}) : {};
      const entry = entryFromListItem(item, meta, cache, torrentsBase);
      if (entry) entries.push(entry);
    }

    return {
      storage: storageSummary(settings.torrentEngineSavePath),
      torrents: entries,
    };
  });

  app.delete("/api/torrents/:info_hash", async (request) => {
    const h = (request.params as { info_hash: string }).info_hash.toLowerCase();
    const deleteFiles = (request.query as { deleteFiles?: string }).deleteFiles !== "false";
    try {
      await torrentEngine.dropTorrent(h);
    } catch (e) {
      throw app.httpErrors.badGateway(String(e));
    }
    if (deleteFiles) torrentEngine.deleteCacheDir(h);
    store.delete(h);
    probeCache.deleteHash(h);
    removeHashHeads(probeHeadDir, h);
    probeWarm.cancelHash(h);
    torrentCache.removeHash(h);
    torrentCache.invalidateList();
    return { status: "deleted", hash: h };
  });
}
