import { describe, expect, it } from "vitest";

import { sha1ToHex } from "../../src/hash-util.js";

describe("sha1ToHex", () => {
  it("from string", () => {
    expect(sha1ToHex("ABCD")).toBe("abcd");
  });
  it("mock to_string", () => {
    const h = {
      to_string() {
        return Buffer.from("ab".repeat(20), "hex");
      },
    };
    expect(sha1ToHex(h)).toBe("ab".repeat(20));
  });
});
