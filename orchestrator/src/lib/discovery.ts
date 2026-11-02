import { createConnection, type AddressInfo } from "node:net";
import Bonjour from "bonjour-service";
import type { FastifyRequest } from "fastify";

export const SERVICE_ID = "home-cinema-orchestrator";
export const MDNS_SERVICE_TYPE = "_homecinema._tcp";

export interface DiscoverPayload {
  service: string;
  version: string;
  api_base: string;
  stream_proxy_base: string;
  torrent_engine_base: string;
  stream_base: string;
}

export function discoverPayloadAsDict(p: DiscoverPayload): Record<string, string> {
  return {
    service: p.service,
    version: p.version,
    api_base: p.api_base,
    stream_proxy_base: p.stream_proxy_base,
    torrent_engine_base: p.torrent_engine_base,
    stream_base: p.stream_base,
  };
}

function lanHostFromRequest(request: FastifyRequest): string {
  const hostHeader = String(request.headers.host ?? "").split(":")[0]?.trim();
  if (hostHeader && !["localhost", "127.0.0.1", "0.0.0.0"].includes(hostHeader)) {
    return hostHeader;
  }
  const forwarded = String(request.headers["x-forwarded-host"] ?? "")
    .split(":")[0]
    ?.trim();
  if (forwarded && !["localhost", "127.0.0.1"].includes(forwarded)) return forwarded;
  const ip = request.ip;
  if (ip && !["127.0.0.1", "::1"].includes(ip)) return ip;
  return "localhost";
}

export function buildDiscoverPayload(
  request: FastifyRequest,
  opts: {
    version: string;
    orchestratorPublicUrl: string;
    torrentEnginePublicUrl: string;
    defaultApiPort?: number;
    defaultWebPort?: number;
    defaultEnginePort?: number;
  },
): DiscoverPayload {
  const defaultApiPort = opts.defaultApiPort ?? 8080;
  const defaultWebPort = opts.defaultWebPort ?? 3000;
  const defaultEnginePort = opts.defaultEnginePort ?? 8090;
  const host = lanHostFromRequest(request);
  const scheme = request.protocol || "http";
  const hostParts = String(request.headers.host ?? "").split(":");
  const apiPort =
    hostParts.length > 1 ? parseInt(hostParts[1]!, 10) : defaultApiPort;
  const apiBase = `${scheme}://${host}:${apiPort}`;

  function rewritePublic(defaultUrl: string, fallbackPort: number): string {
    let parsed: URL;
    try {
      parsed = new URL(defaultUrl);
    } catch {
      return `${scheme}://${host}:${fallbackPort}`;
    }
    const pubHost = parsed.hostname || "localhost";
    const pubPort = parsed.port ? parseInt(parsed.port, 10) : fallbackPort;
    const pubScheme = parsed.protocol.replace(":", "") || "http";
    if (pubHost === "localhost" || pubHost === "127.0.0.1") {
      return `${pubScheme}://${host}:${fallbackPort}`;
    }
    return defaultUrl.replace(/\/$/, "");
  }

  const streamProxyBase = rewritePublic(opts.orchestratorPublicUrl, defaultWebPort);
  const engineBase = rewritePublic(opts.torrentEnginePublicUrl, defaultEnginePort);
  const streamBase = engineBase.replace(/\/$/, "");

  return {
    service: SERVICE_ID,
    version: opts.version,
    api_base: apiBase.replace(/\/$/, ""),
    stream_proxy_base: streamProxyBase.replace(/\/$/, ""),
    torrent_engine_base: streamBase,
    stream_base: streamBase,
  };
}

export async function guessLanIpAsync(): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = createConnection({ port: 80, host: "8.8.8.8" });
    sock.on("connect", () => {
      const addr = sock.address();
      sock.destroy();
      const info = addr as AddressInfo;
      if (info?.address && !info.address.startsWith("127.")) {
        resolve(info.address);
      } else resolve(null);
    });
    sock.on("error", () => resolve(null));
  });
}

export class MdnsAdvertiser {
  private bonjour: InstanceType<typeof Bonjour> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private published: any = null;

  constructor(
    private readonly port: number,
    private readonly version: string,
    private readonly enabled: boolean,
  ) {}

  async start(): Promise<void> {
    if (!this.enabled) return;
    const ip = await guessLanIpAsync();
    if (!ip) {
      console.warn("mDNS: no LAN IP, skipping advertisement");
      return;
    }
    try {
      this.bonjour = new Bonjour();
      this.published = this.bonjour.publish({
        name: "Home Cinema",
        type: MDNS_SERVICE_TYPE,
        port: this.port,
        host: ip,
        txt: {
          service: SERVICE_ID,
          version: this.version,
        },
      });
      console.info(`mDNS: advertised ${SERVICE_ID} on ${ip}:${this.port}`);
    } catch (e) {
      console.error("mDNS: advertisement failed", e);
    }
  }

  stop(): void {
    try {
      this.published?.stop();
      this.bonjour?.destroy();
    } catch (e) {
      console.error("mDNS shutdown failed", e);
    }
    this.published = null;
    this.bonjour = null;
  }
}
