export function probePrefixBytesFromStart(opts: {
  target: number;
  headBytes?: number;
  localFileSize?: number;
  torrentDownloaded?: number;
}): number {
  const target = opts.target;
  if (target <= 0) return 0;
  const headBytes = opts.headBytes ?? 0;
  if (headBytes > 0) return Math.min(headBytes, target);
  const localFileSize = opts.localFileSize ?? 0;
  if (localFileSize > 0) return Math.min(localFileSize, target);
  return Math.min(opts.torrentDownloaded ?? 0, target);
}

export interface ProbeLiveStats {
  bytes_downloaded: number;
  bytes_target: number;
  download_speed: number | null;
  total_peers: number | null;
  subphase: string;
  elapsed_sec: number;
}

const SUBPHASE_LABEL: Record<string, string> = {
  cache: "результат ffprobe из кэша",
  prefetch_head: "подгрузка начала файла для ffprobe",
  analyze_head: "ffprobe по сохранённой голове файла",
  analyze_stream: "ffprobe читает поток раздачи",
  retry_wait: "пауза перед повтором ffprobe",
};

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.trunc(v)} ${units[i]}`;
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatProbeStatusMessage(
  stats: ProbeLiveStats,
  opts: { step: number; stepTotal: number; attempt: number; attemptMax: number },
): string {
  const phase = SUBPHASE_LABEL[stats.subphase] ?? stats.subphase ?? "ffprobe";
  const head = `Этап ${opts.step} из ${opts.stepTotal}: ${phase}`;
  if (stats.subphase === "cache") return `${head}.`;
  if (stats.subphase === "retry_wait") {
    return `${head} (попытка ${opts.attempt} из ${opts.attemptMax} не удалась).`;
  }

  const parts: string[] = [head];
  if (["prefetch_head", "analyze_head", "analyze_stream"].includes(stats.subphase)) {
    parts.push(`Попытка ${opts.attempt} из ${opts.attemptMax}.`);
  }
  if (stats.bytes_target > 0) {
    let showBytes = true;
    if (stats.subphase === "analyze_stream" && stats.bytes_downloaded > stats.bytes_target) {
      showBytes = false;
    }
    if (showBytes) {
      parts.push(
        `С начала файла: ${fmtBytes(stats.bytes_downloaded)} / ${fmtBytes(stats.bytes_target)}.`,
      );
    }
  }
  if (stats.download_speed != null && stats.download_speed > 0) {
    parts.push(`Скорость: ${fmtBytes(Math.trunc(stats.download_speed))}/s.`);
  } else if (stats.subphase === "prefetch_head") {
    parts.push("Скорость: 0 — ждём данные с пиров или диска.");
  }
  if (stats.total_peers != null) parts.push(`Пиры: ${stats.total_peers}.`);
  if (stats.elapsed_sec > 0 && stats.subphase === "analyze_stream") {
    parts.push(`ffprobe: ${stats.elapsed_sec} с.`);
  }
  return parts.join(" ");
}

export function newProbeLiveStats(partial: Partial<ProbeLiveStats> = {}): ProbeLiveStats {
  return {
    bytes_downloaded: partial.bytes_downloaded ?? 0,
    bytes_target: partial.bytes_target ?? 0,
    download_speed: partial.download_speed ?? null,
    total_peers: partial.total_peers ?? null,
    subphase: partial.subphase ?? "",
    elapsed_sec: partial.elapsed_sec ?? 0,
  };
}
