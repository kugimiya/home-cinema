import { settings } from "./config.js";
import { buildSessionConfiguration } from "./session-settings.js";

/** JSON payload for native LtSession.initSession (snake_case fields). */
export function nativeSessionConfigJson(): string {
  const cfg = buildSessionConfiguration(settings);
  return JSON.stringify({
    libtorrent: cfg.libtorrent,
    max_connections_per_torrent: cfg.maxConnectionsPerTorrent,
    max_upload_slots_per_torrent: cfg.maxUploadSlotsPerTorrent,
    listen_port: cfg.listenPort,
  });
}
