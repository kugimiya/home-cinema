import { describe, expect, it } from "vitest";
import {
  fileDownloadPriority,
  PRIORITY_BACKGROUND,
  PRIORITY_OFF,
  PRIORITY_STREAM,
} from "../src/lib/torrent-files.js";

describe("fileDownloadPriority", () => {
  it("streaming file gets stream priority", () => {
    expect(fileDownloadPriority(3, new Set([3, 5]))).toBe(PRIORITY_STREAM);
  });

  it("background when other active", () => {
    expect(fileDownloadPriority(9, new Set([3]))).toBe(PRIORITY_BACKGROUND);
  });

  it("off when nothing active", () => {
    expect(fileDownloadPriority(1, new Set())).toBe(PRIORITY_OFF);
  });
});
