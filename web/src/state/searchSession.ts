import type { Release } from "../api/client";

const KEY = "home-cinema.search";

export interface SearchSessionData {
  query: string;
  source: string | null;
  releases: Release[];
  fetchedAt: number;
}

export function loadSearchSession(): SearchSessionData | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SearchSessionData;
  } catch {
    return null;
  }
}

export function saveSearchSession(data: SearchSessionData) {
  sessionStorage.setItem(KEY, JSON.stringify(data));
}

export function clearSearchSession() {
  sessionStorage.removeItem(KEY);
}
