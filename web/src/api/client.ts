const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type Provider =
  | "rutracker"
  | "kinozal"
  | "rutor"
  | "nonameclub"
  | "rutor_direct";

export interface Release {
  provider: Provider;
  external_id: string;
  title: string;
  quality?: string | null;
  voice?: string | null;
  size?: string | null;
  seeds?: string | null;
  peers?: string | null;
  magnet?: string | null;
  url?: string | null;
}

export interface SearchResponse {
  query: string;
  source: string;
  releases: Release[];
}

export interface PlayResponse {
  hash: string;
  title: string;
  stream_url: string;
  file_name: string;
  file_index: number;
}

export interface TorrentEntry {
  hash: string;
  title: string;
  stat_string?: string | null;
  torrent_size?: number | null;
  bytes_written_data?: number | null;
  upload_speed?: number | null;
  total_peers?: number | null;
  quality?: string | null;
  voice?: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export function search(q: string) {
  return request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
}

export function play(provider: Provider, externalId: string) {
  return request<PlayResponse>("/api/play", {
    method: "POST",
    body: JSON.stringify({ provider, external_id: externalId }),
  });
}

export function listTorrents() {
  return request<{ torrents: TorrentEntry[] }>("/api/torrents");
}

export function deleteTorrent(hash: string, deleteFiles = true) {
  return request<{ status: string }>(
    `/api/torrents/${hash}?deleteFiles=${deleteFiles ? "true" : "false"}`,
    { method: "DELETE" },
  );
}
