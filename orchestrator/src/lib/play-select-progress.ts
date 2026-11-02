export type PlaySelectPhase = "torrent" | "priority" | "probe" | "transcode" | "done";

export interface PlaySelectStatus {
  hash: string;
  step: number;
  step_total: number;
  phase: PlaySelectPhase;
  message: string;
  probe_attempt: number;
  probe_max: number;
  probe_bytes_downloaded: number;
  probe_bytes_target: number;
  probe_download_speed: number | null;
  probe_total_peers: number | null;
  probe_subphase: string;
  probe_elapsed_sec: number;
  updated_at: number;
}

export class PlaySelectProgressStore {
  static STALE_SEC = 180;

  private byHash = new Map<string, PlaySelectStatus>();

  set(
    infoHash: string,
    opts: {
      step: number;
      step_total: number;
      phase: PlaySelectPhase;
      message: string;
      probe_attempt?: number;
      probe_max?: number;
      probe_bytes_downloaded?: number;
      probe_bytes_target?: number;
      probe_download_speed?: number | null;
      probe_total_peers?: number | null;
      probe_subphase?: string;
      probe_elapsed_sec?: number;
    },
  ): void {
    const h = infoHash.toLowerCase();
    this.byHash.set(h, {
      hash: h,
      step: opts.step,
      step_total: opts.step_total,
      phase: opts.phase,
      message: opts.message,
      probe_attempt: opts.probe_attempt ?? 0,
      probe_max: opts.probe_max ?? 0,
      probe_bytes_downloaded: opts.probe_bytes_downloaded ?? 0,
      probe_bytes_target: opts.probe_bytes_target ?? 0,
      probe_download_speed: opts.probe_download_speed ?? null,
      probe_total_peers: opts.probe_total_peers ?? null,
      probe_subphase: opts.probe_subphase ?? "",
      probe_elapsed_sec: opts.probe_elapsed_sec ?? 0,
      updated_at: performance.now() / 1000,
    });
  }

  get(infoHash: string): PlaySelectStatus | null {
    const h = infoHash.toLowerCase();
    const st = this.byHash.get(h);
    if (!st) return null;
    if (performance.now() / 1000 - st.updated_at > PlaySelectProgressStore.STALE_SEC) {
      this.byHash.delete(h);
      return null;
    }
    return st;
  }

  clear(infoHash: string): void {
    this.byHash.delete(infoHash.toLowerCase());
  }
}
