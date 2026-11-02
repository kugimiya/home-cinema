import { describe, expect, it } from "vitest";
import { providerLabel } from "../src/lib/provider-labels.js";
import { looksLikeTorrentFile, torrentDownloadUrl } from "../src/lib/torrent-fetch.js";
import type { ReleaseDetail } from "../src/lib/models.js";

describe("torrent fetch helpers", () => {
  it("provider labels", () => {
    expect(providerLabel("rutracker")).toBe("RuTracker");
    expect(providerLabel("rutor_direct")).toBe("RuTor");
  });

  it("rutor torrent url", () => {
    const detail: ReleaseDetail = {
      provider: "rutor_direct",
      external_id: "123",
      title: "x",
      magnet: "magnet:?xt=urn:btih:abc",
    };
    expect(torrentDownloadUrl(detail)).toBe("https://d.rutor.info/download/123");
  });

  it("looks like torrent", () => {
    expect(looksLikeTorrentFile(Buffer.from("d8:announce" + "x".repeat(24)))).toBe(true);
    expect(looksLikeTorrentFile(Buffer.from("<html>"))).toBe(false);
    expect(looksLikeTorrentFile(Buffer.from(""))).toBe(false);
  });
});
