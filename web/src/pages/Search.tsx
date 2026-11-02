import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { search, providerLabel, type Release } from "../api/client";
import { loadSearchSession, saveSearchSession } from "../state/searchSession";

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQ = searchParams.get("q")?.trim() ?? "";
  const [query, setQuery] = useState(urlQ || "назад в будущее");
  const [source, setSource] = useState<string | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const lastFetchedQ = useRef<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const data = await search(trimmed);
      setSource(data.source);
      setReleases(data.releases);
      saveSearchSession({
        query: trimmed,
        source: data.source,
        releases: data.releases,
        fetchedAt: Date.now(),
      });
      lastFetchedQ.current = trimmed;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!urlQ) return;
    setQuery(urlQ);
    if (lastFetchedQ.current === urlQ) return;
    const cached = loadSearchSession();
    if (cached && cached.query === urlQ && cached.releases.length > 0) {
      setSource(cached.source);
      setReleases(cached.releases);
      lastFetchedQ.current = urlQ;
      return;
    }
    void runSearch(urlQ);
  }, [urlQ, runSearch]);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearchParams({ q: trimmed });
  }

  function onWatch(r: Release) {
    setError(null);
    navigate(
      `/watch/prepare/${r.provider}/${encodeURIComponent(r.external_id)}`,
    );
  }

  return (
    <div>
      <h1>Поиск</h1>
      <form onSubmit={onSearch}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Название фильма или сериала"
        />{" "}
        <button type="submit" disabled={loading}>
          {loading ? "Ищем…" : "Найти"}
        </button>
      </form>
      {source && (
        <p className="muted">
          Источник: {source === "torapi" ? "TorAPI" : "RuTor (fallback)"} · результатов:{" "}
          {releases.length}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {releases.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Трекер</th>
              <th>Название</th>
              <th>Качество</th>
              <th>Озвучка</th>
              <th>Размер</th>
              <th>S/L</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={`${r.provider}-${r.external_id}`}>
                <td className="search-tracker-col">{providerLabel(r.provider)}</td>
                <td>{r.title}</td>
                <td>{r.quality || "—"}</td>
                <td>{r.voice || "—"}</td>
                <td>{r.size || "—"}</td>
                <td>
                  {r.seeds ?? "?"}/{r.peers ?? "?"}
                </td>
                <td>
                  <button type="button" onClick={() => onWatch(r)}>
                    Смотреть
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
