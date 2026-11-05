import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  fetchEngineDiagnostics,
  fileBasename,
  formatBytes,
  formatSpeed,
  type EngineAlertEntry,
  type EngineDiagnosticsResponse,
  type EngineTorrentLive,
} from "../api/client";

const POLL_MS = 2000;

function formatTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString();
}

function formatPct(p?: number | null) {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

function priorityLabel(p: number) {
  if (p >= 7) return "stream (7)";
  if (p >= 1) return "background (1)";
  return "off (0)";
}

function shortHash(h: string) {
  return h.length > 12 ? `${h.slice(0, 8)}…` : h;
}

function orchestratorSummary(d: EngineDiagnosticsResponse) {
  const o = d.orchestrator;
  const parts: string[] = [];
  if (o.activity_label) {
    parts.push(
      o.activity_detail
        ? `${o.activity_label}: ${o.activity_detail}`
        : o.activity_label,
    );
  } else {
    parts.push("Свободен");
  }
  if (o.transcode_sessions > 0) {
    parts.push(`Transcode ${o.transcode_sessions}/${o.transcode_max}`);
  }
  if (o.warm_probe_active) {
    parts.push(o.warm_probe_detail ?? "Warm probe");
  } else if (o.warm_probe_queue > 0) {
    parts.push(`Warm queue: ${o.warm_probe_queue}`);
  }
  return parts.join(" · ");
}

function TorrentDetailRow({ t }: { t: EngineTorrentLive }) {
  const files = t.file_stats ?? [];
  return (
    <tr className="engine-detail-row">
      <td colSpan={7}>
        <div className="engine-detail-grid">
          <div>
            <span className="muted">Хеш</span>{" "}
            <code>{t.hash}</code>
          </div>
          <div>
            <span className="muted">Путь сохранения</span> {t.save_path ?? "—"} /{" "}
            {t.torrent_name ?? "—"}
          </div>
          <div>
            <span className="muted">Прогресс</span> {formatPct(t.progress)}
            {t.pieces_total != null && (
              <>
                {" "}
                · куски {t.pieces_have ?? "?"}/{t.pieces_total}
                {t.piece_length ? ` · ${formatBytes(t.piece_length)}/куск` : null}
              </>
            )}
          </div>
          <div>
            <span className="muted">Область (scope)</span>{" "}
            {t.scope_file_ids.length ? t.scope_file_ids.join(", ") : "—"}
          </div>
          <div>
            <span className="muted">Давность обновления</span>{" "}
            {t.last_heartbeat_age_sec != null
              ? `${t.last_heartbeat_age_sec.toFixed(0)} с назад`
              : "—"}
          </div>
          <div>
            <span className="muted">Последовательная загрузка</span>{" "}
            {t.sequential_download ? "да" : "нет"}
          </div>
          <div>
            <span className="muted">Скачано за всё время</span>{" "}
            {formatBytes(t.all_time_download)}
          </div>
          <div>
            <span className="muted">Отдано за всё время</span>{" "}
            {formatBytes(t.bytes_written_data)}
          </div>
          {t.error ? (
            <div className="engine-error-inline">
              <span className="muted">Ошибка</span> {t.error}
            </div>
          ) : null}
        </div>
        {files.length > 0 ? (
          <table className="engine-files-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Файл</th>
                <th>Размер</th>
                <th>Скачано</th>
                <th>Приоритет</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.id}>
                  <td>{f.id}</td>
                  <td title={f.path}>{fileBasename(f.path)}</td>
                  <td>{formatBytes(f.length)}</td>
                  <td>
                    {formatBytes(f.downloaded_bytes)}
                    {f.completed ? " ✓" : ""}
                  </td>
                  <td>{priorityLabel(f.priority)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </td>
    </tr>
  );
}

export default function EngineMonitorPage() {
  const [data, setData] = useState<EngineDiagnosticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [paused, setPaused] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stickLogRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchEngineDiagnostics(150);
      setData(next);
      setError(next.engine_error ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (paused) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh, paused]);

  useEffect(() => {
    if (!stickLogRef.current || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [data?.alerts]);

  function toggle(hash: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  const session = data?.session;
  const alerts = data?.alerts ?? [];
  const torrents = data?.torrents ?? [];

  return (
    <div className="engine-monitor">
      <header className="engine-monitor-header">
        <div>
          <h1>Libtorrent</h1>
          <p className="muted">
            Живое состояние torrent-engine · опрос каждые {POLL_MS / 1000} с
            {data?.polled_at ? ` · ${new Date(data.polled_at).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <div className="engine-monitor-actions">
          <label className="engine-pause-label">
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => setPaused(e.target.checked)}
            />
            Пауза
          </label>
          <button type="button" className="secondary" onClick={() => void refresh()}>
            Обновить
          </button>
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}

      {data ? (
        <section className="engine-section">
          <h2>Orchestrator</h2>
          <p>{orchestratorSummary(data)}</p>
        </section>
      ) : null}

      <section className="engine-section">
        <h2>Сессия</h2>
        {!session ? (
          <p className="muted">Нет данных сессии</p>
        ) : (
          <div className="engine-stat-grid">
            <div className="engine-stat">
              <span className="muted">Торрентов</span>
              <strong>{session.torrent_count}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Загрузка Σ</span>
              <strong>{formatSpeed(session.download_rate) ?? "—"}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Отдача Σ</span>
              <strong>{formatSpeed(session.upload_rate) ?? "—"}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Качает</span>
              <strong>{session.active_downloads}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Ждут meta</span>
              <strong>{session.waiting_metadata}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Seeding</span>
              <strong>{session.seeding_count}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Connections limit</span>
              <strong>{session.connections_limit}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Listen</span>
              <strong>{session.listen}</strong>
            </div>
            <div className="engine-stat engine-stat-wide">
              <span className="muted">save_path</span>
              <strong>{session.save_path}</strong>
            </div>
            <div className="engine-stat engine-stat-wide">
              <span className="muted">Сеть</span>
              <strong>
                DHT {session.enable_dht ? "on" : "off"} · LSD{" "}
                {session.enable_lsd ? "on" : "off"} · UPnP{" "}
                {session.enable_upnp ? "on" : "off"} · NAT-PMP{" "}
                {session.enable_natpmp ? "on" : "off"}
              </strong>
            </div>
            <div className="engine-stat engine-stat-wide">
              <span className="muted">Клиент (трекер / пиры)</span>
              <strong>
                {session.user_agent ?? "—"}
                {session.peer_fingerprint ? (
                  <>
                    {" "}
                    · <code>{session.peer_fingerprint}</code>
                  </>
                ) : null}
              </strong>
            </div>
            <div className="engine-stat engine-stat-wide">
              <span className="muted">DHT bootstrap</span>
              <strong>{session.dht_bootstrap_nodes ?? "default"}</strong>
            </div>
            <div className="engine-stat">
              <span className="muted">Alerts buffer</span>
              <strong>{session.alert_buffer_size}</strong>
            </div>
          </div>
        )}
      </section>

      <section className="engine-section">
        <h2>Торренты ({torrents.length})</h2>
        {torrents.length === 0 ? (
          <p className="muted">В сессии нет торрентов</p>
        ) : (
          <table className="library-table engine-torrents-table">
            <thead>
              <tr>
                <th aria-label="Развернуть" />
                <th>Название</th>
                <th>LT / mode</th>
                <th>Progress</th>
                <th>↓ / ↑</th>
                <th>Пиры</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {torrents.map((t) => {
                const open = expanded.has(t.hash);
                return (
                  <Fragment key={t.hash}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="expand-btn secondary"
                          aria-expanded={open}
                          onClick={() => toggle(t.hash)}
                        >
                          {open ? "▼" : "▶"}
                        </button>
                      </td>
                      <td>
                        <div className="library-title-ellipsis" title={t.title}>
                          {t.title}
                        </div>
                        <div className="muted">
                          <code>{shortHash(t.hash)}</code>
                        </div>
                      </td>
                      <td>
                        {t.stat_string ?? "—"}
                        <div className="muted">{t.mode ?? "—"}</div>
                      </td>
                      <td>
                        {formatPct(t.progress)}
                        <div className="muted">
                          {formatBytes(t.loaded_size)} / {formatBytes(t.torrent_size)}
                        </div>
                      </td>
                      <td>
                        {formatSpeed(t.download_speed) ?? "—"}
                        <div className="muted">{formatSpeed(t.upload_speed) ?? "—"}</div>
                      </td>
                      <td>
                        {t.num_connections ?? t.total_peers ?? 0} conn.
                        <div className="muted">
                          {t.total_peers ?? 0} пир. / {t.connected_seeders ?? 0} сид.
                        </div>
                      </td>
                      <td className="engine-flags">
                        {t.has_metadata ? "meta" : "no-meta"}
                        {t.is_seeding ? " · seed" : ""}
                        {t.is_paused ? " · pause" : ""}
                        {t.is_finished ? " · done" : ""}
                      </td>
                    </tr>
                    {open ? <TorrentDetailRow t={t} /> : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="engine-section">
        <div className="engine-log-header">
          <h2>Alerts ({alerts.length})</h2>
          <label className="engine-pause-label">
            <input
              type="checkbox"
              defaultChecked
              onChange={(e) => {
                stickLogRef.current = e.target.checked;
              }}
            />
            Автопрокрутка
          </label>
        </div>
        <div className="engine-log" ref={logRef}>
          {alerts.length === 0 ? (
            <p className="muted engine-log-empty">
              Пока пусто — события libtorrent появятся по мере работы (tracker, peers, storage…)
            </p>
          ) : (
            alerts.map((a: EngineAlertEntry, i) => (
              <div key={`${a.at}-${a.type}-${i}`} className="engine-log-line">
                <span className="engine-log-time">{formatTime(a.at)}</span>
                <span className="engine-log-type">{a.type}</span>
                {a.info_hash ? (
                  <code className="engine-log-hash">{shortHash(a.info_hash)}</code>
                ) : null}
                <span className="engine-log-msg">{a.message}</span>
                {a.error ? <span className="engine-log-err">{a.error}</span> : null}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
