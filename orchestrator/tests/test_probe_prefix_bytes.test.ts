import { describe, expect, it } from "vitest";
import { probePrefixBytesFromStart } from "../src/lib/probe-messages.js";

const TARGET = 4 * 1024 * 1024;
const FULL = 8693914042;

describe("probePrefixBytesFromStart", () => {
  it("head takes precedence and caps at target", () => {
    expect(
      probePrefixBytesFromStart({
        target: TARGET,
        headBytes: 2 * 1024 * 1024,
        torrentDownloaded: FULL,
      }),
    ).toBe(2 * 1024 * 1024);
  });

  it("caps torrent total at target", () => {
    expect(probePrefixBytesFromStart({ target: TARGET, torrentDownloaded: FULL })).toBe(
      TARGET,
    );
  });

  it("caps local file at target", () => {
    expect(probePrefixBytesFromStart({ target: TARGET, localFileSize: FULL })).toBe(TARGET);
  });
});
