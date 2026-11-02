import Fastify from "fastify";
import { configureLogging, createLogger } from "./logging.js";
import { settings } from "./config.js";
import { registerRoutes } from "./routes.js";
import { getManager } from "./session-manager.js";

configureLogging();
const logger = createLogger("main");

async function main(): Promise<void> {
  getManager();

  const app = Fastify({ logger: false });

  await registerRoutes(app);

  const tick = setInterval(() => {
    void getManager()
      .tickModes()
      .catch((e) => logger.warn(`tick_modes failed: ${e}`));
  }, 5000);
  tick.unref();

  const shutdown = async () => {
    clearInterval(tick);
    await app.close();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: settings.port, host: settings.host });
  logger.info(`torrent-engine listening on ${settings.host}:${settings.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
