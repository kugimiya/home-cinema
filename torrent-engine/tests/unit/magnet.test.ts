import { describe, expect, it } from "vitest";

import { infoHashFromMagnet } from "../../src/magnet.js";

describe("infoHashFromMagnet", () => {
  it("hex btih", () => {
    const magnet =
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
    expect(infoHashFromMagnet(magnet)).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  });
});
