import { describe, expect, it, vi } from "vitest";
import { ActivityTracker } from "../src/lib/activity-tracker.js";
import type { TorrentMediaFile } from "../src/lib/models.js";
import {
  overlayWarmOnStats,
  ProbeWarmManager,
  selectAutoVideoIds,
  selectManualVideoIds,
} from "../src/lib/probe-warm.js";

function catalog(): TorrentMediaFile[] {
  return [
    { id: 1, path: "a/01.mkv", name: "01.mkv", length: 1000, kind: "video" },
    { id: 2, path: "a/02.mkv", name: "02.mkv", length: 1000, kind: "video" },
    { id: 3, path: "a/03.mkv", name: "03.mkv", length: 1000, kind: "video" },
    { id: 4, path: "a/subs.srt", name: "subs.srt", length: 10, kind: "subtitle" },
  ];
}

describe("probe warm selection", () => {
  it("select_auto_video_ids next n", () => {
    const cat = catalog();
    expect(selectAutoVideoIds(cat, 1, 2)).toEqual([2, 3]);
    expect(selectAutoVideoIds(cat, 1, 1)).toEqual([2]);
    expect(selectAutoVideoIds(cat, 3, 2)).toEqual([]);
  });

  it("select_auto_video_ids all", () => {
    const cat = catalog();
    expect(selectAutoVideoIds(cat, 1, -1)).toEqual([2, 3]);
    expect(selectAutoVideoIds(cat, 1, 0)).toEqual([]);
  });

  it("select_manual_video_ids limit", () => {
    const raw = [
      { id: 1, path: "01.mkv", length: 5000 },
      { id: 2, path: "02.mkv", length: 5000 },
    ];
    const items = selectManualVideoIds(raw, 1, () => false, "ab");
    expect(items).toHaveLength(1);
    expect(items[0]![0]).toBe(1);
  });
});

function warmMgr(warmBytes: number) {
  const torr = {} as import("../src/clients/torrent-engine.js").TorrentEngineClient;
  return new ProbeWarmManager(torr, new ActivityTracker(), {
    warmBytes,
    autoFiles: 2,
    manualFiles: -1,
    concurrency: 1,
    fetchCache: vi.fn().mockResolvedValue({}),
  });
}

describe("ProbeWarmManager", () => {
  it("is_file_ready from downloaded", () => {
    const mgr = warmMgr(100);
    expect(mgr.isFileReady("aa", 1, 1000, 150)).toBe(true);
    expect(mgr.isFileReady("aa", 2, 1000, 10)).toBe(false);
  });

  it("overlay disabled", () => {
    const mgr = warmMgr(0);
    const stats = [{ id: 1, path: "x.mkv", length: 100, downloaded_bytes: 0, kind: "video" as const }];
    const out = overlayWarmOnStats(stats, "aa", mgr);
    expect(out[0]!.warm_status).toBe("off");
    expect(out[0]!.warm_target_bytes).toBe(0);
  });

  it("overlay ready when downloaded", () => {
    const mgr = warmMgr(100);
    const stats = [{ id: 1, path: "x.mkv", length: 1000, downloaded_bytes: 200, kind: "video" as const }];
    const out = overlayWarmOnStats(stats, "aa", mgr);
    expect(out[0]!.warm_status).toBe("ready");
    expect(out[0]!.warm_target_bytes).toBe(100);
  });

  it("get_file_state uses path for target", () => {
    const torr = {} as import("../src/clients/torrent-engine.js").TorrentEngineClient;
    const mgr = new ProbeWarmManager(torr, new ActivityTracker(), {
      warmBytes: 100,
      autoFiles: 2,
      manualFiles: -1,
      concurrency: 1,
      fetchCache: vi.fn(),
      warmTargetFn: () => 99,
    });
    const st = mgr.getFileState("aa", 1, 1000, 0, false, "x.mkv");
    expect(st.target_bytes).toBe(99);
  });
});
