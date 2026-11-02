import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSettings, type Settings } from "../config.js";
import { buildTorrentEngineClient, type TorrentEngineClient } from "../clients/torrent-engine.js";
import { TranscoderClient } from "../clients/transcoder.js";
import { MetaStore } from "../store.js";
import { ActivityTracker } from "./activity-tracker.js";
import { RuTorClient } from "./providers/rutor.js";
import { TorAPIClient } from "./providers/torapi.js";
import { SearchService } from "./search-service.js";
import { TorrentStateCache } from "./torrent-cache.js";
import { TranscodeSessionManager } from "./transcode-sessions.js";
import { ProbeCacheStore } from "./probe-store.js";
import { ProbeRunner } from "./probe-runner.js";
import { ProbeWarmManager } from "./probe-warm.js";
import { PlaySelectProgressStore } from "./play-select-progress.js";
import { DockerControl } from "./docker-control.js";
import { MdnsAdvertiser } from "./discovery.js";

export interface AppContext {
  settings: Settings;
  store: MetaStore;
  torapi: TorAPIClient;
  rutor: RuTorClient;
  searchService: SearchService;
  torrentEngine: TorrentEngineClient;
  transcoder: TranscoderClient | null;
  transcodeMgr: TranscodeSessionManager;
  torrentCache: TorrentStateCache;
  activityTracker: ActivityTracker;
  probeCache: ProbeCacheStore;
  probeRunner: ProbeRunner;
  probeWarm: ProbeWarmManager;
  playSelectProgress: PlaySelectProgressStore;
  dockerControl: DockerControl;
  mdns: MdnsAdvertiser;
  probeHeadDir: string;
  lastSearchQuery: string | null;
  lastSearchAt: number | null;
}

export function createAppContext(): AppContext {
  const settings = loadSettings();
  const store = new MetaStore(settings.databasePath);
  const torapi = new TorAPIClient(settings.torapiUrl, settings.searchTimeout);
  const rutor = new RuTorClient(settings.searchTimeout);
  const searchService = new SearchService(torapi, rutor);
  const torrentEngine = buildTorrentEngineClient(settings);
  const transcoder = settings.transcoderEnabled
    ? new TranscoderClient(settings.transcoderUrl, settings.torrentEngineSavePath)
    : null;
  const transcodeMgr = new TranscodeSessionManager(
    settings.transcodeWorkDir,
    settings.transcodeMaxSessions,
    settings.transcodeSessionTtlSec,
    settings.orchestratorPublicUrl,
    transcoder,
  );
  const torrentCache = new TorrentStateCache(torrentEngine);
  const activityTracker = new ActivityTracker();
  const probeHeadDir = join(settings.transcodeWorkDir, "probe_heads");
  mkdirSync(probeHeadDir, { recursive: true });

  const probeCache = new ProbeCacheStore(settings.databasePath);
  const probeRunner = new ProbeRunner(
    probeCache,
    torrentEngine,
    torrentCache,
    settings,
    probeHeadDir,
  );

  async function probeWarmFetchCache(infoHash: string): Promise<Record<string, unknown>> {
    const item = await torrentCache.findListItem(infoHash);
    const data = await torrentCache.getCachePieces(infoHash, { listItem: item });
    return data ?? {};
  }

  const probeWarm = new ProbeWarmManager(torrentEngine, activityTracker, {
    warmBytes: settings.probeWarmBytes,
    autoFiles: settings.probeWarmFiles,
    manualFiles: settings.probeWarmManualFiles,
    concurrency: settings.probeWarmConcurrency,
    fetchCache: probeWarmFetchCache,
    warmTargetFn: (h, fid, path, len) => probeRunner.warmTargetBytes(h, fid, path, len),
    headDir: probeHeadDir,
  });

  const playSelectProgress = new PlaySelectProgressStore();
  const dockerControl = new DockerControl(settings.serviceRestartEnabled, settings.dockerSocketPath, {
    "torrent-engine": settings.dockerContainerTorrentEngine,
    transcoder: settings.dockerContainerTranscoder,
    torapi: settings.dockerContainerTorapi,
    orchestrator: settings.dockerContainerOrchestrator,
  });

  const mdns = new MdnsAdvertiser(
    settings.orchestratorListenPort,
    "0.1.0",
    settings.discoveryMdnsEnabled,
  );

  return {
    settings,
    store,
    torapi,
    rutor,
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
    mdns,
    probeHeadDir,
    lastSearchQuery: null,
    lastSearchAt: null,
  };
}
