import { describe, expect, it } from "vitest";
import { buildDiscoverPayload, SERVICE_ID } from "../src/lib/discovery.js";

function mockRequest(host: string, clientIp = "192.168.1.10") {
  return {
    headers: { host },
    ip: clientIp,
    protocol: "http",
  } as import("fastify").FastifyRequest;
}

describe("discover", () => {
  it("rewrites localhost urls for lan client", () => {
    const payload = buildDiscoverPayload(mockRequest("192.168.1.5:8080"), {
      version: "0.1.0",
      orchestratorPublicUrl: "http://localhost:3000",
      torrentEnginePublicUrl: "http://localhost:8090",
    });
    expect(payload.service).toBe(SERVICE_ID);
    expect(payload.api_base).toBe("http://192.168.1.5:8080");
    expect(payload.stream_proxy_base).toBe("http://192.168.1.5:3000");
    expect(payload.torrent_engine_base).toBe("http://192.168.1.5:8090");
    expect(payload.stream_base).toBe("http://192.168.1.5:8090");
  });
});
