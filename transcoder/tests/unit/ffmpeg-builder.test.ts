import { describe, expect, it } from "vitest";

import { buildFfmpegCommand } from "../../src/ffmpeg-builder.js";

describe("buildFfmpegCommand", () => {
  it("scale height in command", () => {
    const cmd = buildFfmpegCommand("/torrents/x/video.mkv", "/tmp/out", {
      playbackMode: "hls_transcode",
      videoCopy: true,
      audioCopy: false,
      audioOrdinal: 0,
      startSec: 0,
      videoHeight: 480,
    });
    const text = cmd.join(" ");
    expect(text).toContain("scale=-2:min(480\\,ih)");
    expect(text).toContain("-c:v libx264");
  });

  it("remux copy when no scale", () => {
    const cmd = buildFfmpegCommand("http://example/stream", "/tmp/out2", {
      playbackMode: "hls_remux",
      videoCopy: true,
      audioCopy: true,
      audioOrdinal: 0,
      startSec: 0,
      videoHeight: null,
    });
    expect(cmd).toContain("-c:v");
    expect(cmd).toContain("copy");
    const audioIdx = cmd.indexOf("-c:a");
    expect(cmd[audioIdx + 1]).toBe("copy");
  });
});
