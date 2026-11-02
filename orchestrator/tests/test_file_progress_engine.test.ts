import { describe, expect, it } from "vitest";
import { progressFromCache, progressFromFileStats } from "../src/lib/file-progress.js";

describe("engine file progress", () => {
  it("uses _engine_files sentinel", () => {
    const raw = [{ id: 1, length: 1000, path: "a.mkv" }];
    const cache = {
      _engine_files: [{ id: 1, downloaded_bytes: 500, priority: 7, length: 1000 }],
    };
    const prog = progressFromCache(raw, cache);
    expect(prog[1]!.downloaded).toBe(500);
    expect(prog[1]!.priority).toBe(7);
  });

  it("progress_from_file_stats", () => {
    const prog = progressFromFileStats([
      { id: 2, downloaded_bytes: 99, priority: 1, length: 200 },
    ]);
    expect(prog[2]!.downloaded).toBe(99);
  });

  it("empty cache uses file stats", () => {
    const raw = [{ id: 1, length: 1_000_000, downloaded_bytes: 999_000, priority: 7 }];
    const prog = progressFromCache(raw, {});
    expect(prog[1]!.downloaded).toBe(999_000);
    expect(prog[1]!.priority).toBe(7);
  });
});
