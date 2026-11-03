import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pickFfmpegSource } from "../../src/source-pick.js";

describe("pickFfmpegSource", () => {
  it("prefers local path when file is fully allocated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-pick-"));
    const file = path.join(dir, "video.mkv");
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 1));
    const url = "http://engine/stream";
    expect(pickFfmpegSource(file, url, 1024 * 1024)).toBe(file);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers URL when local file is mostly sparse", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-pick-"));
    const file = path.join(dir, "big.bin");
    const size = 50 * 1024 * 1024;
    fs.writeFileSync(file, Buffer.alloc(4096, 1));
    fs.truncateSync(file, size);
    const url = "http://engine/stream";
    expect(pickFfmpegSource(file, url, size)).toBe(url);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
