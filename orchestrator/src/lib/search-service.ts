import type { Provider, Release, ReleaseDetail } from "./models.js";
import { RuTorClient } from "./providers/rutor.js";
import { TorAPIClient } from "./providers/torapi.js";
import { HttpError } from "./fetch-json.js";

export class SearchService {
  constructor(
    readonly torapi: TorAPIClient,
    readonly rutor: RuTorClient,
  ) {}

  async search(query: string): Promise<[string, Release[]]> {
    if (await this.torapi.healthy()) {
      try {
        const releases = await this.torapi.searchAll(query);
        if (releases.length > 0) return ["torapi", releases];
      } catch (e) {
        console.warn("TorAPI search failed:", e);
      }
    }
    const releases = await this.rutor.search(query);
    return ["rutor_fallback", releases];
  }

  async releaseDetail(provider: Provider, externalId: string): Promise<ReleaseDetail> {
    if (provider === "rutor_direct") {
      return this.rutor.releaseDetail(externalId);
    }
    if (await this.torapi.healthy()) {
      try {
        return await this.torapi.releaseDetail(provider, externalId);
      } catch (e) {
        console.warn("TorAPI detail failed:", e);
      }
    }
    if (provider === "rutor") {
      return this.rutor.releaseDetail(externalId);
    }
    throw new HttpError(`Cannot resolve release for ${provider}/${externalId}`);
  }
}
