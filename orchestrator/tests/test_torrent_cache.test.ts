import { describe, expect, it, vi } from "vitest";
import { TorrentStateCache } from "../src/lib/torrent-cache.js";

const hash = "aa".repeat(20);

function mockClient() {
  return {
    listTorrents: vi.fn().mockResolvedValue([
      {
        hash,
        title: "One",
        file_stats: [{ id: 1, path: "a.mkv", length: 100 }],
      },
    ]),
    getTorrent: vi.fn().mockResolvedValue({}),
    getCache: vi.fn().mockResolvedValue({ pieces: [] }),
    addTorrent: vi.fn(),
    addTorrentBytes: vi.fn(),
    requestTimeout: 120,
  };
}

describe("TorrentStateCache", () => {
  it("coalesces list fetches", async () => {
    const client = mockClient();
    let resolveList: (v: unknown) => void;
    const listPromise = new Promise((r) => {
      resolveList = r;
    });
    client.listTorrents.mockReturnValue(listPromise);

    const cache = new TorrentStateCache(client);
    const p1 = cache.listSnapshot();
    const p2 = cache.listSnapshot();
    resolveList!([
      { hash, title: "One", file_stats: [{ id: 1, path: "a.mkv", length: 100 }] },
    ]);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(client.listTorrents).toHaveBeenCalledTimes(1);
  });

  it("respects list ttl", async () => {
    const client = mockClient();
    const cache = new TorrentStateCache(client);
    await cache.listSnapshot({ maxAge: 10 });
    await cache.listSnapshot({ maxAge: 10 });
    expect(client.listTorrents).toHaveBeenCalledTimes(1);
  });

  it("invalidate list refetches", async () => {
    const client = mockClient();
    const cache = new TorrentStateCache(client);
    await cache.listSnapshot();
    cache.invalidateList();
    await cache.listSnapshot();
    expect(client.listTorrents).toHaveBeenCalledTimes(2);
  });

  it("invalidate hash refetches cache", async () => {
    const client = mockClient();
    const cache = new TorrentStateCache(client);
    await cache.getCachePieces(hash);
    expect(client.getCache).toHaveBeenCalledTimes(1);
    cache.invalidateHash(hash, ["cache"]);
    await cache.getCachePieces(hash);
    expect(client.getCache).toHaveBeenCalledTimes(2);
  });

  it("stat 5 skips cache fetch", async () => {
    const client = mockClient();
    const cache = new TorrentStateCache(client);
    await cache.getCachePieces("bb".repeat(20), { listItem: { stat: 5 } });
    expect(client.getCache).not.toHaveBeenCalled();
  });
});
