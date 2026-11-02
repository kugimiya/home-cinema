import { describe, expect, it } from "vitest";
import { loadNativeAddon } from "../src/native-binding.js";
import { nativeSessionConfigJson } from "../src/native-init.js";

const runIntegration = Boolean(process.env.LT_INTEGRATION);

describe.skipIf(!runIntegration)("native addon integration", () => {
  it("initSession and ping", () => {
    const native = loadNativeAddon();
    native.initSession(
      nativeSessionConfigJson(),
      process.env.TORRENT_ENGINE_SAVE_PATH ?? "/tmp/torrents-test",
    );
    expect(native.ping()).toEqual({ status: "ok" });
  });
});

describe.skipIf(runIntegration)("native addon skipped", () => {
  it("placeholder when LT_INTEGRATION unset", () => {
    expect(true).toBe(true);
  });
});
