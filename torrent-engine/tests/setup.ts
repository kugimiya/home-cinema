import { beforeEach } from "vitest";
import type { SessionManager } from "../src/session-manager.js";
import { setManagerForTests } from "../src/session-manager.js";

const mockManager: SessionManager = {
  drainAlerts: async () => [],
  sessionStatus: async () => ({}),
  addTorrentBytes: async () => ({}),
  addTorrent: async (_link, _title) => {
    throw new Error("bad link");
  },
  listTorrents: async () => [],
  getTorrent: async () => null,
  removeTorrent: async () => {},
  setScope: async () => {},
  setMode: async () => {},
  heartbeat: async () => {},
  tickModes: async () => {},
  flushPersistence: async () => {},
  readFileRange: async () => Buffer.alloc(0),
};

beforeEach(() => {
  setManagerForTests(mockManager);
});
