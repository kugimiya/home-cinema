import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultWarmHeadBytes, ProbeCacheStore } from "../src/lib/probe-store.js";

describe("ProbeCacheStore", () => {
  it("default warm head mp4 larger", () => {
    const n = defaultWarmHeadBytes("movie.mp4", 100_000_000, 4_194_304);
    expect(n).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  });

  it("cache roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-store-"));
    try {
      const store = new ProbeCacheStore(join(dir, "t.sqlite3"));
      store.saveProbe(
        "aa".repeat(20),
        3,
        "ep.mkv",
        1000,
        {
          status: "ok",
          media_kind: "video",
          playback_mode: "direct",
          direct_playable: true,
          audio_tracks: [{ index: 0, stream_index: 0, label: "Дорожка 1" }],
          video_copy: true,
          audio_copy: true,
          duration_sec: 120,
        },
        { warmHeadBytes: 5_000_000 },
      );
      expect(store.getWarmHeadBytes("aa".repeat(20), 3)).toBe(5_000_000);
      const cached = store.getCachedProbe("aa".repeat(20), 3, "ep.mkv", 1000);
      expect(cached?.playback_mode).toBe("direct");
      expect(cached?.duration_sec).toBe(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
