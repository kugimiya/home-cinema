import { describe, expect, it } from "vitest";
import { parseProbePayload } from "../src/lib/playback-probe.js";

describe("parseProbePayload audio", () => {
  it("flac transcodes to hls_audio opus path", () => {
    const result = parseProbePayload(
      {
        format: { duration: "240.0", format_name: "flac" },
        streams: [{ codec_type: "audio", codec_name: "flac", index: 0 }],
      },
      "music/album.flac",
      false,
    );
    expect(result.media_kind).toBe("audio");
    expect(result.playback_mode).toBe("hls_audio");
    expect(result.audio_copy).toBe(false);
  });

  it("mp3 direct when single track", () => {
    const result = parseProbePayload(
      {
        format: { duration: "180.0", format_name: "mp3" },
        streams: [{ codec_type: "audio", codec_name: "mp3", index: 0 }],
      },
      "track.mp3",
      false,
    );
    expect(result.playback_mode).toBe("direct");
    expect(result.direct_playable).toBe(true);
  });

  it("ogg vorbis uses hls_audio", () => {
    const result = parseProbePayload(
      {
        format: { duration: "90.0", format_name: "ogg" },
        streams: [{ codec_type: "audio", codec_name: "vorbis", index: 0 }],
      },
      "mix.ogg",
      false,
    );
    expect(result.playback_mode).toBe("hls_audio");
  });
});
