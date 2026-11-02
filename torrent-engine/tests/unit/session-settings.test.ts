import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { defaultSettings } from "../../src/config.js";
import {
  buildSessionConfiguration,
  resolveListenInterfaces,
} from "../../src/session-settings.js";

describe("buildSessionConfiguration", () => {
  it("defaults", () => {
    const cfg = buildSessionConfiguration(defaultSettings());
    expect(cfg.libtorrent.connections_limit).toBe(500);
    expect(cfg.libtorrent.unchoke_slots_limit).toBe(20);
    expect(cfg.libtorrent.active_limit).toBe(-1);
    expect(cfg.maxConnectionsPerTorrent).toBe(100);
    expect(cfg.libtorrent.user_agent).toBe("home-cinema/1.0");
  });
});

describe("resolveListenInterfaces", () => {
  it("uses explicit host when not wildcard", () => {
    const s = defaultSettings();
    s.listenHost = "10.0.0.5";
    s.listenPort = 6881;
    expect(resolveListenInterfaces(s)).toBe("10.0.0.5:6881");
  });

  it("prefers eth0 on linux docker when host is 0.0.0.0", () => {
    const s = defaultSettings();
    s.listenHost = "0.0.0.0";
    const v = resolveListenInterfaces(s);
    const hasEth0 =
      process.platform === "linux" && existsSync("/sys/class/net/eth0");
    expect(v).toBe(hasEth0 ? "eth0:6881" : "0.0.0.0:6881");
  });
});
