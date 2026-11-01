import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  deleteTorrent,
  fileBasename,
  fileStatusLabel,
  formatBytes,
  listTorrents,
  pauseTorrentDownload,
  startWarmProbe,
  type StorageSummary,
  type TorrentEntry,
  type TorrentFileStat,
} from "../api/client";
import { useUiStore } from "../state/uiStore";

const LIBRARY_SCROLL_KEY = "home-cinema.library.scrollY";

function mergeTorrents(
  prev: TorrentEntry[],
  incoming: TorrentEntry[],
  detailHashes: Set<string>,
): TorrentEntry[] {
  const byHash = new Map(prev.map((t) => [t.hash, t]));
  for (const t of incoming) {
    const old = byHash.get(t.hash);
    if (!old) {
      byHash.set(t.hash, t);
      continue;
    }
    const fileStats = detailHashes.has(t.hash)
      ? t.file_stats
      : old.file_stats?.length
        ? old.file_stats
        : t.file_stats;
    byHash.set(t.hash, { ...old, ...t, file_stats: fileStats ?? t.file_stats });
  }
  const ordered: TorrentEntry[] = [];
  for (const t of prev) {
    const merged = byHash.get(t.hash);
    if (merged) {
      ordered.push(merged);
      byHash.delete(t.hash);
    }
  }
  for (const t of byHash.values()) {
    ordered.push(t);
  }
  return ordered;
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const { libraryExpanded, toggleLibraryExpanded, setLibraryExpanded } = useUiStore();
  const [torrents, setTorrents] = useState<TorrentEntry[]>([]);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const expandedRef = useRef(libraryExpanded);
  expandedRef.current = libraryExpanded;

  const load = useCallback(async (detail?: string[]) => {
    setError(null);
    try {
      const data = await listTorrents(detail);
      setTorrents((prev) => mergeTorrents(prev, data.torrents, new Set(detail ?? [])));
      setStorage(data.storage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshList = useCallback(() => {
    const expanded = [...expandedRef.current];
    void load(expanded.length > 0 ? expanded : undefined);
  }, [load]);

  useLayoutEffect(() => {
    try {
      const raw = sessionStorage.getItem(LIBRARY_SCROLL_KEY);
      const y = raw ? Number(raw) : 0;
      if (Number.isFinite(y) && y > 0) {
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
    } catch {
      /* ignore */
    }
    return () => {
      try {
        sessionStorage.setItem(LIBRARY_SCROLL_KEY, String(window.scrollY));
      } catch {
        /* ignore */
      }
    };
  }, []);

  useEffect(() => {
    refreshList();
    const t = setInterval(refreshList, 15000);
    return () => clearInterval(t);
  }, [refreshList]);

  const warmPollActive = torrents.some(
    (t) => t.warm_summary && !t.warm_summary.includes("готово"),
  );

  useEffect(() => {
    if (!warmPollActive) return;
    refreshList();
    const t = setInterval(refreshList, 3000);
    return () => clearInterval(t);
  }, [warmPollActive, refreshList]);

  async function onToggleExpanded(hash: string) {
    const scrollY = window.scrollY;
    const opening = toggleLibraryExpanded(hash);
    if (opening) {
      await load([hash]);
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  }

  async function onWatchTorrent(t: TorrentEntry) {
    navigate(`/watch/${encodeURIComponent(t.hash)}`);
  }

  function onWatchFile(t: TorrentEntry, file: TorrentFileStat) {
    navigate(`/player/${encodeURIComponent(t.hash)}/${file.id}`);
  }

  async function onWarmProbe(t: TorrentEntry) {
    if (!t.probe_warm_enabled) return;
    setBusyHash(t.hash);
    setError(null);
    try {
      await startWarmProbe(t.hash);
      await load([t.hash]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyHash(null);
    }
  }

  async function onPause(hash: string) {
    setBusyHash(hash);
    setError(null);
    try {
      await pauseTorrentDownload(hash);
      refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyHash(null);
    }
  }

  async function onDelete(hash: string, title: string) {
    if (!confirm(`Удалить «${title}» и файлы с диска?`)) return;
    setBusyHash(hash);
    try {
      await deleteTorrent(hash, true);
      const next = new Set(libraryExpanded);
      next.delete(hash);
      setLibraryExpanded(next);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyHash(null);
    }
  }

  return (
    <div className="library-page">
      <h1>Библиотека / раздача</h1>
      <p className="muted">Торренты остаются до ручного удаления. Обновление каждые 15 с.</p>

      {storage && (
        <div className="storage-bar">
          <div className="storage-stat">
            <span className="storage-label">Свободно на диске</span>
            <strong>{formatBytes(storage.disk_free_bytes)}</strong>
          </div>
          <div className="storage-stat">
            <span className="storage-label">Занято раздачами</span>
            <strong>{formatBytes(storage.torrents_data_bytes)}</strong>
          </div>
          <div className="storage-stat">
            <span className="storage-label">Диск (всего)</span>
            <strong>{formatBytes(storage.disk_total_bytes)}</strong>
          </div>
        </div>
      )}

      <button
        type="button"
        className="secondary"
        onClick={() => refreshList()}
        disabled={loading}
      >
        Обновить
      </button>
      {error && <p className="error">{error}</p>}
      {loading && torrents.length === 0 ? (
        <p className="muted">Загрузка списка торрентов…</p>
      ) : null}

      {!loading || torrents.length > 0 ? (
        <table className="library-table">
          <thead>
            <tr>
              <th aria-label="Развернуть" />
              <th>Название</th>
              <th>Статус</th>
              <th>Размер</th>
              <th>На диске</th>
              <th title="Суммарно отдано пирам (все сессии TorrServer)">Отдано</th>
              <th>Пиры</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {torrents.map((t) => {
              const isOpen = libraryExpanded.has(t.hash);
              const files = t.file_stats ?? [];
              return (
                <Fragment key={t.hash}>
                  <tr className="torrent-row">
                    <td>
                      <button
                        type="button"
                        className="expand-btn secondary"
                        aria-expanded={isOpen}
                        disabled={files.length === 0}
                        onClick={() => void onToggleExpanded(t.hash)}
                        title={files.length ? "Файлы раздачи" : "Нет списка файлов"}
                      >
                        {files.length === 0 ? "·" : isOpen ? "▼" : "▶"}
                      </button>
                    </td>
                    <td>
                      {t.title}
                      {(t.quality || t.voice) && (
                        <div className="muted">
                          {[t.quality, t.voice].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      {files.length > 0 && (
                        <div className="muted">{files.length} файлов</div>
                      )}
                    </td>
                    <td>
                      {t.stat_string || "—"}
                      {t.warm_summary && (
                        <div className="muted">{t.warm_summary}</div>
                      )}
                    </td>
                    <td>{formatBytes(t.torrent_size)}</td>
                    <td>{formatBytes(t.on_disk_bytes ?? t.preloaded_bytes)}</td>
                    <td>
                      {(t.uploaded_bytes ?? 0) > 0
                        ? formatBytes(t.uploaded_bytes)
                        : "—"}
                    </td>
                    <td>{t.total_peers ?? "—"}</td>
                    <td>
                      <button
                        type="button"
                        disabled={busyHash === t.hash}
                        onClick={() => onWatchTorrent(t)}
                      >
                        Смотреть
                      </button>{" "}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busyHash === t.hash || !t.probe_warm_enabled}
                        title={
                          t.probe_warm_enabled
                            ? "Подгрузить начало файлов для быстрого ffprobe"
                            : "Отключено (PROBE_WARM_BYTES=0)"
                        }
                        onClick={() => void onWarmProbe(t)}
                      >
                        Предзагрузить ffprobe
                      </button>{" "}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busyHash === t.hash}
                        onClick={() => onPause(t.hash)}
                      >
                        Остановить скачку
                      </button>{" "}
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
                  {isOpen && files.length > 0 && (
                    <tr key={`${t.hash}-files`} className="files-row">
                      <td colSpan={8}>
                        <div className="torrent-files">
                          {(t.on_disk_bytes ?? 0) > 0 &&
                            files.every((f) => f.downloaded_bytes === 0) && (
                              <p className="muted file-hint">
                                На диске ~{formatBytes(t.on_disk_bytes)}. Прогресс по
                                файлам обновляется для развёрнутых строк.
                              </p>
                            )}
                          <table className="files-table">
                            <thead>
                              <tr>
                                <th>Файл</th>
                                <th>Размер</th>
                                <th
                                  title="Оценка: доля upload TorrServer по объёму скачанного файла"
                                >
                                  Отдано
                                </th>
                                <th>Статус</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {files.map((f) => {
                                const canWatch = f.kind === "video";
                                return (
                                  <tr key={f.id}>
                                    <td title={f.path}>{fileBasename(f.path)}</td>
                                    <td>{formatBytes(f.length)}</td>
                                    <td className="muted">
                                      {(f.uploaded_bytes ?? 0) > 0
                                        ? formatBytes(f.uploaded_bytes)
                                        : "—"}
                                    </td>
                                    <td>{fileStatusLabel(f)}</td>
                                    <td>
                                      {canWatch ? (
                                        <button
                                          type="button"
                                          onClick={() => onWatchFile(t, f)}
                                        >
                                          Смотреть файл
                                        </button>
                                      ) : (
                                        <span className="muted">—</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {!loading && torrents.length === 0 && (
        <p className="muted">Пока нет сохранённых торрентов.</p>
      )}
    </div>
  );
}
