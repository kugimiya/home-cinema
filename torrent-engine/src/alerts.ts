import { sha1ToHex } from "./hash-util.js";

export interface SerializedAlert {
  type: string;
  at: number;
  message: string;
  category?: number;
  info_hash?: string;
  error?: string;
}

function alertMethod<T>(alert: unknown, name: string): (() => T) | undefined {
  if (alert === null || typeof alert !== "object") return undefined;
  const fn = (alert as Record<string, unknown>)[name];
  return typeof fn === "function" ? (fn as () => T) : undefined;
}

export function serializeAlert(alert: unknown): SerializedAlert {
  const typeName =
    alert !== null && typeof alert === "object"
      ? (alert as object).constructor?.name ?? "Alert"
      : "Alert";

  const out: SerializedAlert = {
    type: typeName,
    at: Date.now() / 1000,
    message: "",
  };

  const messageFn = alertMethod<string>(alert, "message");
  try {
    out.message = messageFn ? messageFn.call(alert) : String(alert);
  } catch {
    out.message = String(alert);
  }

  const categoryFn = alertMethod<number>(alert, "category");
  if (categoryFn) {
    try {
      out.category = categoryFn.call(alert);
    } catch {
      /* ignore */
    }
  }

  const handleFn = alertMethod<{
    is_valid?: () => boolean;
    info_hash?: () => unknown;
  }>(alert, "handle");
  if (handleFn) {
    try {
      const handle = handleFn.call(alert);
      if (handle?.is_valid?.()) {
        out.info_hash = sha1ToHex(handle.info_hash?.());
      }
    } catch {
      /* ignore */
    }
  }

  const errorFn = alertMethod<unknown>(alert, "error");
  if (errorFn) {
    try {
      const err = errorFn.call(alert);
      if (err) out.error = String(err);
    } catch {
      /* ignore */
    }
  }

  return out;
}

export class AlertRing {
  private readonly capacity: number;
  private readonly items: SerializedAlert[] = [];

  constructor(capacity = 300) {
    this.capacity = Math.max(10, capacity);
  }

  extend(alerts: SerializedAlert[]): void {
    for (const item of alerts) {
      this.items.push(item);
      while (this.items.length > this.capacity) {
        this.items.shift();
      }
    }
  }

  listRecent(limit = 100): SerializedAlert[] {
    const lim = Math.max(1, Math.min(limit, this.capacity));
    if (lim >= this.items.length) return [...this.items];
    return this.items.slice(-lim);
  }

  size(): number {
    return this.items.length;
  }
}
