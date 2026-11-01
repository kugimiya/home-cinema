import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { play, search, type Release } from "../api/client";

export default function SearchPage() {
  const [query, setQuery] = useState("назад в будущее");
  const [source, setSource] = useState<string | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await search(query.trim());
      setSource(data.source);
      setReleases(data.releases);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function onWatch(r: Release) {
    setPlayingId(r.external_id);
    setError(null);
    try {
      const res = await play(r.provider, r.external_id);
      navigate("/player", { state: res });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlayingId(null);
    }
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
                <td>{r.title}</td>
                <td>{r.quality || "—"}</td>
                <td>{r.voice || "—"}</td>
                <td>{r.size || "—"}</td>
                <td>
                  {r.seeds ?? "?"}/{r.peers ?? "?"}
                </td>
                <td>
                  <button
                    type="button"
                    disabled={playingId === r.external_id}
                    onClick={() => onWatch(r)}
                  >
                    {playingId === r.external_id ? "…" : "Смотреть"}
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
