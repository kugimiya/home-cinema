const levelName = (process.env.TORRENT_ENGINE_LOG_LEVEL ?? "INFO").toUpperCase();

const LEVELS: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

const currentLevel = LEVELS[levelName] ?? LEVELS.INFO;

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(level: string, levelNum: number, name: string, msg: string, ...args: unknown[]): void {
  if (levelNum < currentLevel) return;
  const rest = args.length ? ` ${args.map(String).join(" ")}` : "";
  console.log(`${ts()} ${level} [${name}] ${msg}${rest}`);
}

export function createLogger(name: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => log("DEBUG", LEVELS.DEBUG, name, msg, ...args),
    info: (msg: string, ...args: unknown[]) => log("INFO", LEVELS.INFO, name, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => log("WARN", LEVELS.WARN, name, msg, ...args),
    error: (msg: string, ...args: unknown[]) => log("ERROR", LEVELS.ERROR, name, msg, ...args),
    exception: (msg: string, err: unknown) => {
      log("ERROR", LEVELS.ERROR, name, msg, err instanceof Error ? err.stack ?? err : err);
    },
  };
}

export function configureLogging(): void {
  /* side-effect: level read at module load */
}
