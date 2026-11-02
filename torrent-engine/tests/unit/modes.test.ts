import { describe, expect, it } from "vitest";

import {
  PRIORITY_BACKGROUND,
  PRIORITY_OFF,
  PRIORITY_STREAM,
  TorrentMode,
  applyModeToScope,
  fileDownloadPriority,
} from "../../src/modes.js";

describe("fileDownloadPriority", () => {
  it("stream active", () => {
    expect(fileDownloadPriority(3, new Set([3]))).toBe(PRIORITY_STREAM);
  });
  it("background when other active", () => {
    expect(fileDownloadPriority(9, new Set([3]))).toBe(PRIORITY_BACKGROUND);
  });
  it("off when empty scope", () => {
    expect(fileDownloadPriority(1, new Set())).toBe(PRIORITY_OFF);
  });
});

describe("applyModeToScope", () => {
  it("paused clears active", () => {
    expect(applyModeToScope(TorrentMode.paused, new Set([1, 2]))).toEqual(
      new Set(),
    );
  });
  it("streaming keeps scope", () => {
    expect(applyModeToScope(TorrentMode.streaming, new Set([2]))).toEqual(
      new Set([2]),
    );
  });
});
