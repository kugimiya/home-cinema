import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  fetchPrepare,
  fetchWarmProbeStatus,
  fileStatusLabel,
  formatBytes,
  listTorrents,
  sleep,
  subtitleFiles,
  playableFiles,
  type PrepareResponse,
  type TorrentFileStat,
  type TorrentMediaFile,
  type WatchPendingState,
} from "../api/client";

const PHASE_LABEL: Record<string, string> = {
  metadata: "Ждём метаданные и список файлов…",
  ready: "Готово",
  missing: "Торрент не найден",
  error: "Ошибка",
};

export default function WatchSelectPage() {
  const { infoHash: paramHash } = useParams<{ infoHash: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [phase, setPhase] = useState("metadata");
  const [message, setMessage] = useState("Подготовка…");
  const [statString, setStatString] = useState<string | null>(null);
  const [peers, setPeers] = useState<number | null>(null);
  const [session, setSession] = useState<PrepareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileStatsById, setFileStatsById] = useState<Map<number, TorrentFileStat>>(
    () => new Map(),
  );
  const [warmActive, setWarmActive] = useState(false);
  const started = useRef(false);

  const hash = (paramHash ?? "").toLowerCase();

  useEffect(() => {
    const legacy = location.state as WatchPendingState | null;
    if (!paramHash && legacy?.hash) {
      navigate(`/watch/${encodeURIComponent(legacy.hash)}`, { replace: true, state: null });
      return;
    }
    if (!paramHash && legacy?.provider && legacy.external_id) {
      navigate(
        `/watch/prepare/${legacy.provider}/${encodeURIComponent(legacy.external_id)}`,
        { replace: true, state: null },
      );
    }
  }, [location.state, navigate, paramHash]);

  const runPrepare = useCallback(async () => {
    if (!hash) return;
    setError(null);
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      setPhase("metadata");
      setMessage(PHASE_LABEL.metadata);
      try {
        const st = await fetchPrepare(hash);
        setSession(st);
        setPhase(st.phase);
        setMessage(st.message);
        setStatString(st.stat_string ?? null);
        setPeers(st.total_peers ?? null);
        if (st.ready) return;
        if (st.phase === "missing") {
          setError(st.message);
          return;
        }
      } catch (err) {
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      await sleep(2500);
    }
    setPhase("error");
    setError(
      "Таймаут ожидания метаданных (10 мин). Для огромных сборников это нормально — попробуйте ещё раз или выберите раздачу с одним сезоном/файлом.",
    );
  }, [hash]);

  useEffect(() => {
    if (!hash) return;
    if (started.current) return;
    if (session?.ready) return;
    started.current = true;
    void runPrepare();
  }, [hash, runPrepare, session?.ready]);

  useEffect(() => {
    if (!hash || !session?.ready) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [list, warm] = await Promise.all([
          listTorrents([hash]),
          fetchWarmProbeStatus(hash),
        ]);
        if (cancelled) return;
        const entry = list.torrents.find((t) => t.hash === hash);
        const map = new Map<number, TorrentFileStat>();
        for (const f of entry?.file_stats ?? []) {
          map.set(f.id, f);
        }
        setFileStatsById(map);
        setWarmActive(warm.active || warm.files.some((f) => f.status === "queued"));
      } catch {
        /* keep last */
      }
    };
    void refresh();
    const ms = warmActive ? 3000 : 8000;
    const id = window.setInterval(() => void refresh(), ms);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [hash, session?.ready, warmActive]);

  function onPick(file: TorrentMediaFile) {
    if (!session?.hash) return;
    navigate(`/player/${encodeURIComponent(session.hash)}/${file.id}`);
  }

  if (!hash) {
    return (
      <div>
        <p className="error">Не указан hash раздачи.</p>
        <button type="button" className="secondary" onClick={() => navigate("/")}>
          К поиску
        </button>
      </div>
    );
  }

  const playable = session?.files ? playableFiles(session.files) : [];
  const subs = session?.files ? subtitleFiles(session.files) : [];
  const loading = !session?.ready && !error;

  return (
    <div>
      <h1>Что воспроизвести?</h1>
      <p className="muted">{session?.title ?? hash}</p>

      <div className="status-panel" aria-live="polite">
        <p className="status-phase">{PHASE_LABEL[phase] ?? phase}</p>
        <p>{message}</p>
        {(statString || peers != null) && (
          <p className="muted">
            {statString && <>Статус: {statString}</>}
            {peers != null && <> · пиров: {peers}</>}
          </p>
        )}
        {loading && <div className="spinner" />}
      </div>

      {error && <p className="error">{error}</p>}

      {session?.ready && playable.length > 0 && (
        <>
          <p className="muted">
            Качается только выбранный файл (остальные в раздаче отключены). Для видео субтитры
            можно включить в плеере.
          </p>
          <table>
            <thead>
              <tr>
                <th>Файл</th>
                <th>Тип</th>
                <th>Качество</th>
                <th>Озвучка (из имени)</th>
                <th>Размер</th>
                <th title="Доля upload torrent-engine по скачанному объёму">Отдано</th>
                <th>Прогрев</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {playable.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>{f.kind === "audio" ? "Аудио" : "Видео"}</td>
                  <td>{f.quality || "—"}</td>
                  <td>{f.voice || "—"}</td>
                  <td>{formatBytes(f.length)}</td>
                  <td className="muted">
                    {(fileStatsById.get(f.id)?.uploaded_bytes ?? 0) > 0
                      ? formatBytes(fileStatsById.get(f.id)!.uploaded_bytes!)
                      : "—"}
                  </td>
                  <td className="muted">
                    {fileStatsById.has(f.id)
                      ? fileStatusLabel(fileStatsById.get(f.id)!)
                      : "—"}
                  </td>
                  <td>
                    <button type="button" onClick={() => onPick(f)}>
                      {f.kind === "audio" ? "Слушать" : "Смотреть"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {session?.ready && playable.length === 0 && (
        <p className="error">В торренте нет видео- или аудиофайлов.</p>
      )}

      {subs.length > 0 && session?.ready && (
        <details style={{ marginTop: "1.25rem" }}>
          <summary className="muted">Субтитры в раздаче ({subs.length})</summary>
          <ul className="file-list">
            {subs.map((s) => (
              <li key={s.id}>
                {s.name}
                {s.voice ? ` · ${s.voice}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="actions" style={{ marginTop: "1rem" }}>
        <button type="button" className="secondary" onClick={() => navigate("/")}>
          Назад к поиску
        </button>
      </div>
    </div>
  );
}
