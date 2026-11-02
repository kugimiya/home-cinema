import { describe, expect, it } from "vitest";
import { extractDurationSec, resolveProbeDuration } from "../src/lib/playback-probe.js";

describe("extractDurationSec", () => {
  it("reads format duration", () => {
    expect(extractDurationSec({ format: { duration: "7200.5" }, streams: [] })).toBe(7200.5);
  });

  it("prefers matroska duration tag", () => {
    const data = {
      format: { duration: "120.0", tags: { DURATION: "02:00:00.000000000" } },
      streams: [],
    };
    expect(extractDurationSec(data)).toBe(7200);
  });

  it("reads video stream duration", () => {
    expect(
      extractDurationSec({
        format: {},
        streams: [{ codec_type: "video", duration: "5400.25" }],
      }),
    ).toBe(5400.25);
  });

  it("estimates from file size for partial head", () => {
    const fileLength = 8693914042;
    const resolved = resolveProbeDuration(28, fileLength);
    expect(resolved).not.toBeNull();
    expect(resolved!).toBeGreaterThan(3600);
  });
});
