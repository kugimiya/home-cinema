import { useCallback, useEffect, useState } from "react";
import { deleteTorrent, listTorrents, type TorrentEntry } from "../api/client";

function formatBytes(n?: number | null) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function LibraryPage() {
  const [torrents, setTorrents] = useState<TorrentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listTorrents();
      setTorrents(data.torrents);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function onDelete(hash: string, title: string) {
    if (!confirm(`Удалить «${title}» и файлы с диска?`)) return;
    setBusyHash(hash);
    try {
      await deleteTorrent(hash, true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyHash(null);
    }
  }

  return (
    <div>
      <h1>Библиотека / раздача</h1>
      <p className="muted">Торренты остаются до ручного удаления. Обновление каждые 15 с.</p>
      <button type="button" className="secondary" onClick={load} disabled={loading}>
        Обновить
      </button>
      {error && <p className="error">{error}</p>}
      {loading && torrents.length === 0 ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Статус</th>
              <th>Размер</th>
              <th>Отдано</th>
              <th>Пиры</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {torrents.map((t) => (
              <tr key={t.hash}>
                <td>
                  {t.title}
                  {(t.quality || t.voice) && (
                    <div className="muted">
                      {[t.quality, t.voice].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </td>
                <td>{t.stat_string || "—"}</td>
                <td>{formatBytes(t.torrent_size)}</td>
                <td>{formatBytes(t.bytes_written_data)}</td>
                <td>{t.total_peers ?? "—"}</td>
                <td>
                  <button
                    type="button"
                    className="danger"
                    disabled={busyHash === t.hash}
                    onClick={() => onDelete(t.hash, t.title)}
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading && torrents.length === 0 && <p className="muted">Пока нет сохранённых торрентов.</p>}
    </div>
  );
}
