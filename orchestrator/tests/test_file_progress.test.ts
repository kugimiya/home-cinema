import { describe, expect, it } from "vitest";
import { uploadBytesPerFile } from "../src/lib/file-progress.js";

describe("uploadBytesPerFile", () => {
  it("splits by active downloaded", () => {
    const progress = {
      1: { downloaded: 1000, priority: 7 },
      2: { downloaded: 3000, priority: 0 },
    };
    const shares = uploadBytesPerFile(progress, 4_000_000);
    expect(shares[1]).toBe(4_000_000);
    expect(shares[2]).toBe(0);
  });

  it("splits proportional when no priority", () => {
    const progress = {
      1: { downloaded: 1000, priority: 0 },
      2: { downloaded: 3000, priority: 0 },
    };
    const shares = uploadBytesPerFile(progress, 400);
    expect(shares[1]).toBe(100);
    expect(shares[2]).toBe(300);
  });
});
