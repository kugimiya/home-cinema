import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { mkdirSync } from "node:fs";
import { createAppContext } from "./lib/app-context.js";
import { registerRoutes } from "./routes/index.js";

async function main(): Promise<void> {
  const ctx = createAppContext();
  const app = Fastify({ logger: true });

  await app.register(sensible);
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  await registerRoutes(app, ctx);

  await ctx.torrentEngine.waitReady();
  await ctx.torrentEngine.bootstrapDiskSettings();
  mkdirSync(ctx.settings.transcodeWorkDir, { recursive: true });
  await ctx.mdns.start();
  const cleanupTimer = ctx.transcodeMgr.startCleanupLoop(30);

  const port = ctx.settings.orchestratorListenPort;
  const host = "0.0.0.0";

  const shutdown = async () => {
    clearInterval(cleanupTimer);
    ctx.mdns.stop();
    await app.close();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port, host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
