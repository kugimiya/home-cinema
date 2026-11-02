import { describe, expect, it } from "vitest";
import { accumulateUpload } from "../src/lib/upload-stats.js";

describe("accumulateUpload", () => {
  it("grows with reported", () => {
    const [life, last] = accumulateUpload(100, 80, 120);
    expect(life).toBe(140);
    expect(last).toBe(120);
  });

  it("handles counter reset", () => {
    const [life, last] = accumulateUpload(500, 400, 50);
    expect(life).toBe(550);
    expect(last).toBe(50);
  });

  it("clamps negative inputs", () => {
    const [life, last] = accumulateUpload(-1, -1, 10);
    expect(life).toBe(10);
    expect(last).toBe(10);
  });
});
