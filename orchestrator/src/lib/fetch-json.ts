export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const r = await fetchWithTimeout(url, init);
  if (!r.ok) {
    const text = await r.text();
    throw new HttpError(text || r.statusText, r.status, text);
  }
  return (await r.json()) as T;
}

export function httpErrorDetail(err: unknown): string {
  if (err instanceof HttpError) {
    return err.message.trim() || err.name;
  }
  if (err instanceof Error) {
    return err.message.trim() || err.name;
  }
  return String(err);
}
