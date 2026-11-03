import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import Hls from "hls.js";
import {
  absoluteMediaUrl,
  createTranscodeSession,
  deleteTranscodeSession,
  fetchPlaySelectStatus,
  notifyPlaybackEnded,
  selectPlayFile,
  setDownloadScope,
  VIDEO_QUALITY_PRESETS,
  playableFiles,
  subtitleFiles,
  formatBytes,
  formatPlaybackTime,
  formatSpeed,
  fileLengthBytesFromState,
  resolveFileDurationSec,
  toPlayerState,
  type AudioTrackInfo,
  type PlaySelectStatus,
  type PlayerState,
  type TorrentMediaFile,
} from "../api/client";

const BOOTSTRAP_FALLBACK: PlaySelectStatus = {
  active: true,
  step: 1,
  step_total: 9,
  phase: "torrent",
  message: "Этап 1: подготовка воспроизведения…",
};

type AudioTrackOption = { index: number; label: string };

function isHlsMode(state: PlayerState) {
  return state.playback_mode !== "direct" && Boolean(state.playback_url);
}

export default function PlayerPage() {
  const { infoHash, fileIndex: fileIndexParam } = useParams<{
    infoHash: string;
    fileIndex: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = location.state as PlayerState | null;
  const initialState =
    routeState && (routeState.stream_url || routeState.playback_url) ? routeState : null;
  const bootstrapRef = useRef(false);
  const [bootstrapping, setBootstrapping] = useState(!initialState);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapStatus, setBootstrapStatus] =
    useState<PlaySelectStatus>(BOOTSTRAP_FALLBACK);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionIdRef = useRef<string | null>(initialState?.transcode_session_id ?? null);
  const seekGuardRef = useRef(false);
  const seekTimerRef = useRef<number | null>(null);
  const switchingRef = useRef(false);

  const [playerState, setPlayerState] = useState<PlayerState | null>(initialState);

  useEffect(() => {
    if (!bootstrapping || initialState) return;
    const hash = infoHash?.toLowerCase();
    if (!hash) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const st = await fetchPlaySelectStatus(hash);
        if (!cancelled && st.active && st.message) {
          setBootstrapStatus(st);
        }
      } catch {
        /* keep last status */
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 450);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [bootstrapping, infoHash, initialState]);

  useEffect(() => {
    if (initialState) return;
    if (!infoHash || fileIndexParam == null) return;
    if (bootstrapRef.current) return;
    bootstrapRef.current = true;
    setBootstrapStatus(BOOTSTRAP_FALLBACK);
    const idx = Number(fileIndexParam);
    if (!Number.isFinite(idx)) {
      setBootstrapError("Некорректный индекс файла");
      setBootstrapping(false);
      return;
    }
    void (async () => {
      try {
        const res = await selectPlayFile(infoHash.toLowerCase(), idx);
        const next = toPlayerState(res);
        setPlayerState(next);
        sessionIdRef.current = next.transcode_session_id ?? null;
        setSelectedAudioIndex(next.selected_audio_index ?? 0);
      } catch (err) {
        setBootstrapError(err instanceof Error ? err.message : String(err));
      } finally {
        setBootstrapping(false);
      }
    })();
  }, [infoHash, fileIndexParam, initialState]);

  const [browserAudioTracks, setBrowserAudioTracks] = useState<AudioTrackOption[]>([]);
  const [activeBrowserAudio, setActiveBrowserAudio] = useState(0);
  const [activeSubId, setActiveSubId] = useState<number | "off">("off");
  const [transcodeBusy, setTranscodeBusy] = useState(false);
  const [transcodeError, setTranscodeError] = useState<string | null>(null);
  const [selectedAudioIndex, setSelectedAudioIndex] = useState(
    initialState?.selected_audio_index ?? 0,
  );
  const [videoHeight, setVideoHeight] = useState<number | null>(null);
  const [playbackStartSec, setPlaybackStartSec] = useState(0);
  const [timelineSec, setTimelineSec] = useState(0);
  const scrubbingRef = useRef(false);

  const state = playerState;
  const currentFile = state?.files.find((f) => f.id === state.file_index);
  const isAudioOnly = currentFile?.kind === "audio";
  const subs: TorrentMediaFile[] = state ? subtitleFiles(state.files) : [];
  const activeSub =
    activeSubId === "off" ? null : subs.find((s) => s.id === activeSubId) ?? null;
  const hlsMode = state ? isHlsMode(state) : false;
  const apiAudioTracks: AudioTrackInfo[] = state?.audio_tracks ?? [];
  const [fileDurationSec, setFileDurationSec] = useState(() =>
    initialState
      ? resolveFileDurationSec(
          initialState.duration_sec,
          fileLengthBytesFromState(initialState),
        )
      : 0,
  );

  useEffect(() => {
    if (!state) return;
    const resolved = resolveFileDurationSec(
      state.duration_sec,
      fileLengthBytesFromState(state),
    );
    setFileDurationSec((prev) => (resolved > prev ? resolved : prev));
  }, [state]);

  const fullDurationSec = fileDurationSec;
  const showFullTimeline = hlsMode && fullDurationSec > 0;

  const stopSession = useCallback(async (sessionId: string | null) => {
    if (!sessionId) return;
    try {
      await deleteTranscodeSession(sessionId);
    } catch {
      /* best effort */
    }
  }, []);

  const attachedPlaybackUrlRef = useRef<string | null>(null);

  const attachHls = useCallback((url: string, force = false) => {
    const video = videoRef.current;
    if (!video) return;

    if (!force && attachedPlaybackUrlRef.current === url && hlsRef.current) {
      return;
    }
    attachedPlaybackUrlRef.current = url;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: false,
        liveBackBufferLength: 30,
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (
          data.fatal &&
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
        ) {
          hls.startLoad();
          return;
        }
        if (data.fatal) {
          const detail =
            data.response?.code != null
              ? ` (HTTP ${data.response.code})`
              : "";
          setTranscodeError(
            `Ошибка HLS-потока${detail}. Попробуйте обновить страницу.`,
          );
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else {
      setTranscodeError("Браузер не поддерживает HLS.");
    }
  }, []);

  const currentFilePositionSec = useCallback(() => {
    const video = videoRef.current;
    if (showFullTimeline) {
      return playbackStartSec + (video?.currentTime ?? 0);
    }
    return video?.currentTime ?? 0;
  }, [playbackStartSec, showFullTimeline]);

  const replaceTranscodeSession = useCallback(
    async (
      audioIndex: number,
      startSec: number,
      heightOverride?: number | null,
    ) => {
      if (!state || !hlsMode) return;
      if (switchingRef.current) return;
      switchingRef.current = true;
      setTranscodeBusy(true);
      setTranscodeError(null);
      const prevSession = sessionIdRef.current;
      const audioOnly = state.files.find((f) => f.id === state.file_index)?.kind === "audio";
      const height = audioOnly
        ? null
        : heightOverride !== undefined
          ? heightOverride
          : videoHeight;
      try {
        if (prevSession) {
          await stopSession(prevSession);
        }
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
        attachedPlaybackUrlRef.current = null;
        const res = await createTranscodeSession(
          state.hash,
          state.file_index,
          audioIndex,
          startSec,
          prevSession,
          height,
        );
        sessionIdRef.current = res.session_id;
        setSelectedAudioIndex(res.selected_audio_index);
        const lengthBytes = res.file_length ?? (state ? fileLengthBytesFromState(state) : 0);
        const resolvedDur = resolveFileDurationSec(res.duration_sec ?? state?.duration_sec, lengthBytes);
        setFileDurationSec((prev) => (resolvedDur > prev ? resolvedDur : prev));
        setPlayerState((prev) =>
          prev
            ? {
                ...prev,
                playback_url: absoluteMediaUrl(res.playback_url),
                transcode_session_id: res.session_id,
                playback_mode: res.playback_mode,
                audio_tracks: res.audio_tracks,
                selected_audio_index: res.selected_audio_index,
                duration_sec: res.duration_sec ?? prev.duration_sec,
                file_length: res.file_length ?? prev.file_length,
              }
            : prev,
        );
        setPlaybackStartSec(startSec);
        setTimelineSec(startSec);
        const nextUrl = absoluteMediaUrl(res.playback_url);
        attachHls(nextUrl, true);
        const video = videoRef.current;
        if (video) {
          video.currentTime = 0;
        }
      } catch (err) {
        setTranscodeError(err instanceof Error ? err.message : String(err));
      } finally {
        setTranscodeBusy(false);
        switchingRef.current = false;
        seekGuardRef.current = false;
      }
    },
    [attachHls, hlsMode, state, stopSession, videoHeight],
  );

  const seekToFilePosition = useCallback(
    (targetSec: number) => {
      if (!showFullTimeline) return;
      const clamped = Math.max(0, Math.min(fullDurationSec, targetSec));
      seekGuardRef.current = true;
      setPlaybackStartSec(clamped);
      setTimelineSec(clamped);
      void replaceTranscodeSession(selectedAudioIndex, clamped);
    },
    [fullDurationSec, replaceTranscodeSession, selectedAudioIndex, showFullTimeline],
  );

  useEffect(() => {
    if (!state?.hash) return;
    const ids = [state.file_index];
    if (activeSubId !== "off") ids.push(activeSubId);
    void setDownloadScope(state.hash, ids).catch(() => {});
  }, [state?.hash, state?.file_index, activeSubId]);

  useEffect(() => {
    if (!state || hlsMode) return;
    const video = videoRef.current;
    if (!video) return;

    function syncAudioTracks() {
      const tracks = video?.audioTracks;
      if (!tracks || tracks.length <= 1) {
        setBrowserAudioTracks([]);
        return;
      }
      const options: AudioTrackOption[] = [];
      for (let i = 0; i < tracks.length; i++) {
        const label = tracks[i].label || tracks[i].language || `Дорожка ${i + 1}`;
        options.push({ index: i, label });
      }
      setBrowserAudioTracks(options);
      for (let i = 0; i < tracks.length; i++) {
        tracks[i].enabled = i === activeBrowserAudio;
      }
    }

    video.addEventListener("loadedmetadata", syncAudioTracks);
    return () => video.removeEventListener("loadedmetadata", syncAudioTracks);
  }, [state?.stream_url, activeBrowserAudio, hlsMode, state]);

  useEffect(() => {
    if (!state || hlsMode) return;
    const video = videoRef.current;
    const tracks = video?.audioTracks;
    if (!tracks || browserAudioTracks.length === 0) return;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].enabled = i === activeBrowserAudio;
    }
  }, [activeBrowserAudio, browserAudioTracks.length, hlsMode, state]);

  useEffect(() => {
    if (!state || !hlsMode || !state.playback_url) return;
    attachHls(state.playback_url);
    return () => {
      attachedPlaybackUrlRef.current = null;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [attachHls, hlsMode, state?.playback_url]);

  useEffect(() => {
    return () => {
      void stopSession(sessionIdRef.current);
      if (seekTimerRef.current != null) {
        window.clearTimeout(seekTimerRef.current);
      }
    };
  }, [stopSession]);

  useEffect(() => {
    return () => {
      if (!state?.hash || state.file_index == null) return;
      const ids = [state.file_index];
      if (activeSubId !== "off") ids.push(activeSubId);
      void notifyPlaybackEnded(state.hash, ids).catch(() => {});
    };
  }, [state?.hash, state?.file_index, activeSubId]);

  useEffect(() => {
    if (!showFullTimeline) return;
    const video = videoRef.current;
    if (!video) return;

    function onTimeUpdate() {
      if (scrubbingRef.current || seekGuardRef.current) return;
      setTimelineSec(playbackStartSec + video.currentTime);
    }

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [playbackStartSec, showFullTimeline, state?.playback_url]);

  if (bootstrapping) {
    const step = bootstrapStatus.step ?? 1;
    const stepTotal = bootstrapStatus.step_total ?? 9;
    const probePhase = bootstrapStatus.phase === "probe";
    const probeTarget = bootstrapStatus.probe_bytes_target ?? 0;
    const probeGot = bootstrapStatus.probe_bytes_downloaded ?? 0;
    return (
      <div>
        <h1>Запуск воспроизведения</h1>
        <div className="status-panel" aria-live="polite">
          <p className="status-phase">
            Этап {step} из {stepTotal}
          </p>
          <p>{bootstrapStatus.message ?? "Подготовка…"}</p>
          {probePhase && probeTarget > 0 && (
            <p className="muted">
              С начала файла: {formatBytes(probeGot)} / {formatBytes(probeTarget)}
              {bootstrapStatus.probe_download_speed != null &&
              bootstrapStatus.probe_download_speed > 0
                ? ` · ${formatSpeed(bootstrapStatus.probe_download_speed)}`
                : ""}
              {bootstrapStatus.probe_total_peers != null
                ? ` · пиры: ${bootstrapStatus.probe_total_peers}`
                : ""}
              {(bootstrapStatus.probe_elapsed_sec ?? 0) > 0
                ? ` · ffprobe: ${bootstrapStatus.probe_elapsed_sec} с`
                : ""}
            </p>
          )}
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <div>
        <p className="error">{bootstrapError}</p>
        <button type="button" className="secondary" onClick={() => navigate("/")}>
          К поиску
        </button>
      </div>
    );
  }

  if (!state?.stream_url && !state?.playback_url) {
    return (
      <div>
        <p className="error">Нет активного потока.</p>
        <button type="button" className="secondary" onClick={() => navigate("/")}>
          К поиску
        </button>
      </div>
    );
  }

  if (!state.direct_playable && state.playback_mode === "direct") {
    return (
      <div>
        <p className="error">
          Формат не поддерживается браузером, а перекодирование отключено на сервере.
        </p>
        <button type="button" onClick={() => navigator.clipboard.writeText(state.stream_url)}>
          Скопировать URL для VLC
        </button>
      </div>
    );
  }

  const copyUrl = () =>
    navigator.clipboard.writeText(hlsMode ? state.playback_url ?? "" : state.stream_url);

  const showApiAudio = hlsMode && apiAudioTracks.length > 1;
  const showBrowserAudio = !hlsMode && browserAudioTracks.length > 1;

  return (
    <div>
      <h1>{isAudioOnly ? "Слушаем" : state.title}</h1>
      <p className="muted">
        {state.file_name} · hash {state.hash.slice(0, 8)}…
        {hlsMode &&
          (state.playback_mode === "hls_audio"
            ? " · перекодирование в Opus 320 kb/s"
            : " · перекодирование для браузера")}
      </p>

      {transcodeBusy && <p className="muted">Перекодирование…</p>}
      {transcodeError && <p className="error">{transcodeError}</p>}

      <div className="track-panel">
        {!isAudioOnly && (
        <label className="track-field">
          Качество
          <select
            value={videoHeight ?? "auto"}
            disabled={transcodeBusy}
            onChange={(e) => {
              const v = e.target.value;
              const nextHeight = v === "auto" ? null : Number(v);
              setVideoHeight(nextHeight);
              seekGuardRef.current = true;
              void replaceTranscodeSession(
                selectedAudioIndex,
                currentFilePositionSec(),
                nextHeight,
              );
            }}
          >
            <option value="auto">Авто / оригинал</option>
            {VIDEO_QUALITY_PRESETS.map((h) => (
              <option key={h} value={h}>
                {h}p
              </option>
            ))}
          </select>
        </label>
        )}
        {showApiAudio && (
          <label className="track-field">
            Озвучка
            <select
              value={selectedAudioIndex}
              disabled={transcodeBusy}
              onChange={(e) => {
                const idx = Number(e.target.value);
                setSelectedAudioIndex(idx);
                seekGuardRef.current = true;
                void replaceTranscodeSession(idx, currentFilePositionSec());
              }}
            >
              {apiAudioTracks.map((t) => (
                <option key={t.index} value={t.index}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {showBrowserAudio && (
          <label className="track-field">
            Озвучка в файле
            <select
              value={activeBrowserAudio}
              onChange={(e) => setActiveBrowserAudio(Number(e.target.value))}
            >
              {browserAudioTracks.map((t) => (
                <option key={t.index} value={t.index}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {subs.length > 0 && !isAudioOnly && (
          <label className="track-field">
            Субтитры
            <select
              value={activeSubId === "off" ? "off" : String(activeSubId)}
              onChange={(e) => {
                const v = e.target.value;
                setActiveSubId(v === "off" ? "off" : Number(v));
              }}
            >
              <option value="off">Выключены</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!hlsMode && !isAudioOnly && browserAudioTracks.length === 0 && (
        <p className="muted track-hint">
          Если в MKV несколько озвучек, браузер может не показать переключатель — тогда откройте
          URL в VLC (Audio → Audio track).
        </p>
      )}

      {showFullTimeline && (
        <div className="hls-timeline">
          <span className="hls-timeline-time">{formatPlaybackTime(timelineSec)}</span>
          <input
            type="range"
            className="hls-timeline-range"
            min={0}
            max={fullDurationSec}
            step={1}
            value={Math.min(timelineSec, fullDurationSec)}
            disabled={transcodeBusy}
            onPointerDown={() => {
              scrubbingRef.current = true;
            }}
            onPointerUp={() => {
              scrubbingRef.current = false;
            }}
            onInput={(e) => setTimelineSec(Number((e.target as HTMLInputElement).value))}
            onChange={(e) => {
              scrubbingRef.current = false;
              seekToFilePosition(Number(e.target.value));
            }}
          />
          <span className="hls-timeline-time">{formatPlaybackTime(fullDurationSec)}</span>
        </div>
      )}
      {showFullTimeline && (
        <p className="muted hls-timeline-hint">
          Полная длительность файла. Перемотка перезапускает перекодирование с выбранной
          позиции (может занять несколько секунд).
        </p>
      )}

      <div className={`player-wrap${isAudioOnly ? " player-wrap--audio" : ""}`}>
        <video
          ref={videoRef}
          key={hlsMode ? `hls-${activeSubId}` : `${state.stream_url}-${activeSubId}`}
          src={hlsMode ? undefined : state.stream_url}
          controls
          controlsList={showFullTimeline ? "noseek" : undefined}
          autoPlay
          crossOrigin={hlsMode ? undefined : "anonymous"}
          {...(isAudioOnly ? { playsInline: true } : {})}
        >
          {activeSub?.stream_url && (
            <track
              kind="subtitles"
              src={activeSub.stream_url}
              label={activeSub.name}
              default
            />
          )}
        </video>
      </div>
      <div className="actions">
        <button type="button" onClick={copyUrl}>
          Скопировать URL потока
        </button>
        {playableFiles(state.files).length > 1 && (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              navigate(`/watch/${encodeURIComponent(state.hash)}`)
            }
          >
            Другой файл
          </button>
        )}
        <button type="button" className="secondary" onClick={() => navigate("/library")}>
          Библиотека
        </button>
      </div>
      <p className="muted" style={{ marginTop: "1rem" }}>
        {isAudioOnly
          ? "Для VLC/MPV: File → Open Network → вставьте URL выше. Торрент продолжит качаться после прослушивания."
          : "Для VLC/MPV: File → Open Network → вставьте URL выше. Торрент продолжит качаться и раздаваться после просмотра."}
      </p>
    </div>
  );
}
