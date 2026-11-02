import * as cheerio from "cheerio";
import { parseQuality, parseVoice } from "../metadata.js";
import type { Release, ReleaseDetail } from "../models.js";
import { fetchWithTimeout, HttpError } from "../fetch-json.js";

export const RUTOR_MIRRORS = ["https://rutor.info", "https://rutor.is"] as const;
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; HomeCinema/0.1)" };

export class RuTorClient {
  constructor(private readonly timeout: number) {}

  async search(query: string): Promise<Release[]> {
    let lastError: unknown;
    for (const base of RUTOR_MIRRORS) {
      try {
        const url = `${base}/search/0/0/000/0/${encodeURIComponent(query)}`;
        const r = await fetchWithTimeout(url, {
          timeoutMs: this.timeout * 1000,
          headers: HEADERS,
        });
        if (!r.ok) throw new HttpError(await r.text(), r.status);
        return parseSearchHtml(await r.text(), base);
      } catch (e) {
        console.warn(`RuTor mirror ${base} failed:`, e);
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  async releaseDetail(externalId: string): Promise<ReleaseDetail> {
    let lastError: unknown;
    for (const base of RUTOR_MIRRORS) {
      try {
        const url = `${base}/torrent/${externalId}`;
        const r = await fetchWithTimeout(url, {
          timeoutMs: this.timeout * 1000,
          headers: HEADERS,
        });
        if (!r.ok) throw new HttpError(await r.text(), r.status);
        return parseDetailHtml(await r.text(), externalId, base);
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    throw new HttpError("RuTor detail unavailable");
  }
}

function parseSearchHtml(text: string, base: string): Release[] {
  const $ = cheerio.load(text);
  const releases: Release[] = [];
  $("table tr.gai, table tr.tum").each((_, tr) => {
    const link = $(tr).find('a[href^="/torrent/"]').first();
    const mag = $(tr).find('a[href^="magnet:"]').first();
    if (!link.length || !mag.length) return;
    const href = link.attr("href") ?? "";
    const mId = href.match(/\/torrent\/(\d+)\//);
    if (!mId) return;
    const title = link.text().trim();
    const peersCell = $(tr).text();
    const [seeds, peers] = guessSeedsPeers(peersCell);
    releases.push({
      provider: "rutor_direct",
      external_id: mId[1]!,
      title,
      quality: parseQuality(title),
      voice: parseVoice(title),
      magnet: decodeHtmlEntities(mag.attr("href") ?? ""),
      url: `${base}${href}`,
      torrent_url: `https://d.rutor.info/download/${mId[1]}`,
      seeds,
      peers,
    });
  });
  return releases;
}

function parseDetailHtml(text: string, externalId: string, base: string): ReleaseDetail {
  const $ = cheerio.load(text);
  const h1 = $("#all h1, h1").first();
  const title = h1.length ? h1.text().trim() : externalId;
  const magnetEl = $('a[href^="magnet:"]').first();
  const magnet = magnetEl.length
    ? decodeHtmlEntities(magnetEl.attr("href") ?? "") || null
    : null;
  let hashVal: string | null = null;
  if (magnet) {
    const m = magnet.match(/btih:([A-Fa-f0-9]+)/i);
    if (m) hashVal = m[1]!.toUpperCase();
  }
  return {
    provider: "rutor_direct",
    external_id: externalId,
    title,
    quality: parseQuality(title),
    voice: parseVoice(title),
    size: tableValue($, "Размер"),
    seeds: tableValue($, "Сиды"),
    peers: tableValue($, "Пиры"),
    magnet,
    hash: hashVal,
    url: `${base}/torrent/${externalId}`,
    torrent_url: `https://d.rutor.info/download/${externalId}`,
  };
}

function tableValue($: cheerio.CheerioAPI, label: string): string | null {
  let result: string | null = null;
  $("#details td.header").each((_, td) => {
    if ($(td).text().trim() === label) {
      const nxt = $(td).next("td");
      if (nxt.length) result = nxt.text().replace(/\s+/g, " ").trim();
    }
  });
  return result;
}

function guessSeedsPeers(cell: string): [string | null, string | null] {
  const m = cell.match(/(\d+)\s*[\×xX]\s*(\d+)/);
  if (m) return [m[1]!, m[2]!];
  return [null, null];
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}
