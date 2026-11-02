import { connect } from "node:net";

const ALLOWED_IDS = new Set(["torrent-engine", "transcoder", "torapi", "orchestrator"]);

export class DockerControl {
  constructor(
    readonly enabled: boolean,
    readonly socketPath: string,
    readonly containerNames: Record<string, string>,
  ) {}

  restartAllowed(serviceId: string): boolean {
    return this.enabled && ALLOWED_IDS.has(serviceId);
  }

  async restartContainer(serviceId: string): Promise<void> {
    if (!this.restartAllowed(serviceId)) {
      throw new PermissionError("Service restart is disabled");
    }
    const name = this.containerNames[serviceId];
    if (!name) throw new Error(`Unknown service id: ${serviceId}`);

    const filters = JSON.stringify({ name: [name] });
    const listed = await dockerRequest(
      this.socketPath,
      "GET",
      `/v1.44/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    const containers = JSON.parse(listed) as Array<Record<string, unknown>>;
    let cid: string | undefined;
    for (const c of containers) {
      const names = (c.Names as string[]) ?? [];
      if (
        names.some(
          (n) =>
            (n ?? "").replace(/^\//, "") === name ||
            (n ?? "").endsWith(name) ||
            String(c.Names).includes(name),
        )
      ) {
        cid = String(c.Id);
        break;
      }
    }
    if (!cid && containers[0]) cid = String(containers[0].Id);
    if (!cid) throw new Error(`Container not found: ${name}`);

    await dockerRequest(this.socketPath, "POST", `/v1.44/containers/${cid}/restart?t=10`);
    console.info(`Restarted container ${name} (${serviceId})`);
  }
}

class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

function dockerRequest(socketPath: string, method: string, path: string, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const headers = [
      `${method} ${path} HTTP/1.1`,
      "Host: docker",
      body ? `Content-Length: ${Buffer.byteLength(body)}` : "Content-Length: 0",
      "Connection: close",
      "",
      body ?? "",
    ].join("\r\n");

    let data = "";
    socket.on("connect", () => socket.write(headers));
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const idx = data.indexOf("\r\n\r\n");
      if (idx < 0) {
        reject(new Error("Invalid docker response"));
        return;
      }
      const head = data.slice(0, idx);
      const statusLine = head.split("\r\n")[0] ?? "";
      const code = parseInt(statusLine.split(" ")[1] ?? "0", 10);
      const bodyText = data.slice(idx + 4);
      if (code >= 400) reject(new Error(bodyText || statusLine));
      else resolve(bodyText);
    });
  });
}

export { PermissionError };
