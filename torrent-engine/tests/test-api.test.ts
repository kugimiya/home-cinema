import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../src/routes.js";

async function buildApp() {
  const app = Fastify();
  await registerRoutes(app);
  await app.ready();
  return app;
}

describe("HTTP API", () => {
  it("GET /health", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("POST /v1/torrents rejects empty link", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/torrents",
      payload: { link: "", title: "x" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
