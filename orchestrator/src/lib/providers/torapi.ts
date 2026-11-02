import { parseQuality, parseVoice } from "../metadata.js";
import type { Provider, Release, ReleaseDetail } from "../models.js";
import { fetchJson, fetchWithTimeout, HttpError } from "../fetch-json.js";

const PROVIDER_MAP: Record<string, Provider> = {
  RuTracker: "rutracker",
  Kinozal: "kinozal",
  RuTor: "rutor",
  NoNameClub: "nonameclub",
};

const API_PROVIDER: Partial<Record<Provider, string>> = {
  rutracker: "rutracker",
  kinozal: "kinozal",
  rutor: "rutor",
  nonameclub: "nonameclub",
};

export class TorAPIClient {
  constructor(
    readonly baseUrl: string,
    readonly timeout: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await fetchWithTimeout(`${this.baseUrl}/api/provider/list`, {
        timeoutMs: 10_000,
      });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  async searchAll(query: string): Promise<Release[]> {
    const url = new URL(`${this.baseUrl}/api/search/title/all`);
    url.searchParams.set("query", query);
    url.searchParams.set("page", "0");
    const data = await fetchJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: this.timeout * 1000,
    });
    const releases: Release[] = [];
    if (typeof data !== "object" || data === null) return releases;
    for (const [providerName, items] of Object.entries(data)) {
      const provider = PROVIDER_MAP[providerName];
      if (!provider) continue;
      if (typeof items === "object" && items !== null && !Array.isArray(items)) {
        const obj = items as Record<string, unknown>;
        if (obj.Result) continue;
      }
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const rel = itemToRelease(provider, item as Record<string, unknown>);
        if (rel) releases.push(rel);
      }
    }
    return releases;
  }

  async releaseDetail(provider: Provider, externalId: string): Promise<ReleaseDetail> {
    const apiName = API_PROVIDER[provider];
    if (!apiName) throw new Error(`TorAPI does not support provider ${provider}`);
    const url = new URL(`${this.baseUrl}/api/search/id/${apiName}`);
    url.searchParams.set("query", externalId);
    const data = await fetchJson<unknown>(url.toString(), {
      timeoutMs: this.timeout * 1000,
    });
    const normalized = normalizeDetailPayload(data, externalId);
    if (typeof normalized === "object" && normalized !== null && normalized.Result) {
      throw new HttpError(String(normalized.Result ?? "Not found"));
    }
    return detailFromTorapi(provider, externalId, normalized as Record<string, unknown>);
  }
}

function normalizeDetailPayload(data: unknown, externalId: string): Record<string, unknown> {
  if (Array.isArray(data)) {
    if (data.length === 0) throw new HttpError("Not found");
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      if (obj.Id != null && String(obj.Id) === String(externalId)) return obj;
    }
    const first = data[0];
    if (typeof first === "object" && first !== null) return first as Record<string, unknown>;
    throw new HttpError("Unexpected TorAPI response");
  }
  if (typeof data === "object" && data !== null) return data as Record<string, unknown>;
  throw new HttpError("Unexpected TorAPI response");
}

function itemToRelease(
  provider: Provider,
  item: Record<string, unknown>,
): Release | null {
  const title = String(item.Name ?? item.Title ?? "");
  if (!title) return null;
  const extId = String(item.Id ?? "");
  if (!extId) return null;
  const fmt = item.Format != null ? String(item.Format) : null;
  const lang = item.Language != null ? String(item.Language) : null;
  return {
    provider,
    external_id: extId,
    title: title.trim(),
    quality: parseQuality(title, fmt),
    voice: parseVoice(title, lang),
    size: item.Size != null ? String(item.Size) : null,
    seeds: item.Seeds != null ? String(item.Seeds) : null,
    peers: item.Peers != null ? String(item.Peers) : null,
    url: item.Url != null ? String(item.Url) : null,
    magnet: item.Magnet != null ? String(item.Magnet) : null,
    torrent_url: item.Torrent != null ? String(item.Torrent) : null,
  };
}

function detailFromTorapi(
  provider: Provider,
  externalId: string,
  data: Record<string, unknown>,
): ReleaseDetail {
  const title = String(data.Name ?? data.Title ?? "");
  const audio = data.Audio;
  return {
    provider,
    external_id: externalId,
    title: title.trim() || externalId,
    quality: parseQuality(title, data.Format != null ? String(data.Format) : null),
    voice: parseVoice(
      title,
      audio != null ? String(audio) : data.Language != null ? String(data.Language) : null,
    ),
    size: data.Size != null ? String(data.Size) : null,
    magnet: data.Magnet != null ? String(data.Magnet) : null,
    hash: data.Hash != null ? String(data.Hash) : null,
    url: data.Url != null ? String(data.Url) : null,
    torrent_url: data.Torrent != null ? String(data.Torrent) : null,
    description: data.Description != null ? String(data.Description) : null,
  };
}
