import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
  adjacentPlayableFile,
  episodeEntries,
  subtitleFilesForMedia,
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

type PendingTranscode = {
  audioIndex: number;
  startSec: number;
  heightOverride?: number | null;
};

function bufferedEndSec(media: HTMLMediaElement | null | undefined): number {
  if (!media?.buffered || media.buffered.length === 0) return 0;
  let end = 0;
  for (let i = 0; i < media.buffered.length; i++) {
    try {
      end = Math.max(end, media.buffered.end(i));
    } catch {
      /* index became invalid */
    }
  }
  return Number.isFinite(end) ? end : 0;
}

/** True if media-local time is inside a buffered range (with a small end margin). */
function localTimeInBuffered(
  media: HTMLMediaElement | null | undefined,
  localSec: number,
  endMarginSec = 0.35,
): boolean {
  if (!media?.buffered || media.buffered.length === 0) return false;
  if (!Number.isFinite(localSec) || localSec < 0) return false;
  for (let i = 0; i < media.buffered.length; i++) {
    try {
      const start = media.buffered.start(i);
      const end = media.buffered.end(i);
      const usableEnd = Math.max(start, end - endMarginSec);
      if (localSec >= start && localSec <= usableEnd) return true;
    } catch {
      /* index became invalid */
    }
  }
  return false;
}

function clampRatio(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isHlsMode(state: PlayerState) {
  return state.playback_mode !== "direct" && Boolean(state.playback_url);
}

function isBenignPlaybackAbort(err: unknown): boolean {
  if (err instanceof DOMException) {
    if (err.name === "AbortError") return true;
    if (
      err.message.includes("aborted") &&
      err.message.includes("media resource")
    ) {
      return true;
    }
  }
  return false;
}

function safeMediaPlay(media: HTMLMediaElement | null | undefined) {
  if (!media) return;
  const result = media.play();
  if (result !== undefined) {
    void result.catch((err) => {
      if (!isBenignPlaybackAbort(err)) {
        console.warn("media play failed", err);
      }
    });
  }
}

function releaseHls(
  hlsRef: MutableRefObject<Hls | null>,
  media: HTMLMediaElement | null,
) {
  const hls = hlsRef.current;
  hlsRef.current = null;
  if (media) {
    media.pause();
  }
  if (!hls) return;
  try {
    hls.detachMedia();
  } catch {
    /* teardown while loading */
  }
  try {
    hls.destroy();
  } catch {
    /* ignore */
  }
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
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  const seekBarRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionIdRef = useRef<string | null>(initialState?.transcode_session_id ?? null);
  const seekGuardRef = useRef(false);
  const seekTimerRef = useRef<number | null>(null);
  const seekCommitTimerRef = useRef<number | null>(null);
  const switchingRef = useRef(false);
  const pendingTranscodeRef = useRef<PendingTranscode | null>(null);
  const lockedPlayerHeightRef = useRef(0);

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
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioVolume, setAudioVolume] = useState(1);
  const [audioUiTime, setAudioUiTime] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoVolume, setVideoVolume] = useState(1);
  const [videoUiTime, setVideoUiTime] = useState(0);
  const [bufferedSec, setBufferedSec] = useState(0);
  const [lockedPlayerHeight, setLockedPlayerHeight] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const scrubbingRef = useRef(false);
  const controlsHideTimerRef = useRef<number | null>(null);

  const capturePlayerHeight = useCallback(() => {
    const wrap = playerWrapRef.current;
    const video = mediaRef.current;
    if (!wrap || !(video instanceof HTMLVideoElement)) return;
    // Only sample while frames exist; keep the last lock during reattach/seek.
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
    const h = Math.round(wrap.getBoundingClientRect().height);
    if (h < 120) return;
    if (h !== lockedPlayerHeightRef.current) {
      lockedPlayerHeightRef.current = h;
      setLockedPlayerHeight(h);
    }
  }, []);

  const state = playerState;
  const currentFile = state?.files.find((f) => f.id === state.file_index);
  const isAudioOnly = currentFile?.kind === "audio";
  const subs: TorrentMediaFile[] = state
    ? subtitleFilesForMedia(state.files, currentFile)
    : [];
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

  const switchToFile = useCallback(
    async (targetFileId: number) => {
      if (!state || switchingRef.current || targetFileId === state.file_index) return;
      switchingRef.current = true;
      setTranscodeBusy(true);
      setTranscodeError(null);
      const prevSession = sessionIdRef.current;
      const prevFileIndex = state.file_index;
      const prevHash = state.hash;
      try {
        if (prevSession) await stopSession(prevSession);
        if (hlsRef.current) {
          releaseHls(hlsRef, mediaRef.current);
        }
        attachedPlaybackUrlRef.current = null;
        void notifyPlaybackEnded(prevHash, [prevFileIndex]).catch(() => {});
        const res = await selectPlayFile(prevHash, targetFileId);
        const next = toPlayerState(res);
        setPlayerState(next);
        sessionIdRef.current = next.transcode_session_id ?? null;
        setSelectedAudioIndex(next.selected_audio_index ?? 0);
        setActiveSubId("off");
        setActiveBrowserAudio(0);
        setPlaybackStartSec(0);
        setTimelineSec(0);
        setBufferedSec(0);
        lockedPlayerHeightRef.current = 0;
        setLockedPlayerHeight(0);
        pendingTranscodeRef.current = null;
        setFileDurationSec(
          resolveFileDurationSec(next.duration_sec, fileLengthBytesFromState(next)),
        );
        navigate(`/player/${encodeURIComponent(next.hash)}/${targetFileId}`, {
          replace: true,
          state: next,
        });
      } catch (err) {
        setTranscodeError(err instanceof Error ? err.message : String(err));
      } finally {
        setTranscodeBusy(false);
        switchingRef.current = false;
        seekGuardRef.current = false;
      }
    },
    [navigate, state, stopSession],
  );

  const navigateToPlayableFile = useCallback(
    (fileId: number) => {
      if (!state) return;
      navigate(`/player/${encodeURIComponent(state.hash)}/${fileId}`);
    },
    [navigate, state],
  );

  const attachedPlaybackUrlRef = useRef<string | null>(null);
  const recoverHlsRef = useRef<() => void>(() => {});
  const hlsRecoveringRef = useRef(false);

  const attachHls = useCallback((url: string, force = false) => {
    const media = mediaRef.current;
    if (!media) return;

    if (!force && attachedPlaybackUrlRef.current === url && hlsRef.current) {
      return;
    }
    attachedPlaybackUrlRef.current = url;

    if (hlsRef.current) {
      releaseHls(hlsRef, media);
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
      hls.attachMedia(media);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hlsRecoveringRef.current = false;
        safeMediaPlay(media);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;

        const isManifestMissing =
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          (data.response?.code === 404 ||
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT);

        // Dead/expired transcode session: do not retry the same URL forever.
        if (isManifestMissing) {
          if (hlsRecoveringRef.current || switchingRef.current) return;
          hlsRecoveringRef.current = true;
          attachedPlaybackUrlRef.current = null;
          releaseHls(hlsRef, media);
          recoverHlsRef.current();
          return;
        }

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
          return;
        }

        const detail =
          data.response?.code != null ? ` (HTTP ${data.response.code})` : "";
        setTranscodeError(
          `Ошибка HLS-потока${detail}. Попробуйте обновить страницу.`,
        );
      });
    } else if (media.canPlayType("application/vnd.apple.mpegurl")) {
      media.src = url;
    } else {
      setTranscodeError("Браузер не поддерживает HLS.");
    }
  }, []);

  const currentFilePositionSec = useCallback(() => {
    const media = mediaRef.current;
    if (showFullTimeline) {
      return playbackStartSec + (media?.currentTime ?? 0);
    }
    return media?.currentTime ?? 0;
  }, [playbackStartSec, showFullTimeline]);

  const replaceTranscodeSession = useCallback(
    async (
      audioIndex: number,
      startSec: number,
      heightOverride?: number | null,
    ) => {
      if (!state || !hlsMode) return;

      // Coalesce rapid seeks into one in-flight swap (latest wins).
      if (switchingRef.current) {
        pendingTranscodeRef.current = { audioIndex, startSec, heightOverride };
        setPlaybackStartSec(startSec);
        setTimelineSec(startSec);
        setBufferedSec(startSec);
        setTranscodeBusy(true);
        return;
      }

      switchingRef.current = true;
      setTranscodeBusy(true);
      setTranscodeError(null);
      capturePlayerHeight();
      pendingTranscodeRef.current = { audioIndex, startSec, heightOverride };

      try {
        while (pendingTranscodeRef.current) {
          const req = pendingTranscodeRef.current;
          pendingTranscodeRef.current = null;

          const audioOnly =
            state.files.find((f) => f.id === state.file_index)?.kind === "audio";
          const height = audioOnly
            ? null
            : req.heightOverride !== undefined
              ? req.heightOverride
              : videoHeight;

          setPlaybackStartSec(req.startSec);
          setTimelineSec(req.startSec);
          setBufferedSec(req.startSec);

          const prevSession = sessionIdRef.current;
          if (hlsRef.current) {
            releaseHls(hlsRef, mediaRef.current);
          }
          attachedPlaybackUrlRef.current = null;

          // Server stops replace_session_id; avoid double-delete races on the client.
          const res = await createTranscodeSession(
            state.hash,
            state.file_index,
            req.audioIndex,
            req.startSec,
            prevSession,
            height,
          );

          // A newer seek arrived while creating — discard this session and retry.
          if (pendingTranscodeRef.current) {
            await stopSession(res.session_id);
            if (sessionIdRef.current === prevSession) {
              sessionIdRef.current = null;
            }
            continue;
          }

          sessionIdRef.current = res.session_id;
          setSelectedAudioIndex(res.selected_audio_index);
          const lengthBytes =
            res.file_length ?? (state ? fileLengthBytesFromState(state) : 0);
          const resolvedDur = resolveFileDurationSec(
            res.duration_sec ?? state?.duration_sec,
            lengthBytes,
          );
          setFileDurationSec((prev) => (resolvedDur > prev ? resolvedDur : prev));
          const nextUrl = absoluteMediaUrl(res.playback_url);
          // Let the playback_url effect own HLS attach (avoids destroy/recreate races).
          attachedPlaybackUrlRef.current = null;
          setPlayerState((prev) =>
            prev
              ? {
                  ...prev,
                  playback_url: nextUrl,
                  transcode_session_id: res.session_id,
                  playback_mode: res.playback_mode,
                  audio_tracks: res.audio_tracks,
                  selected_audio_index: res.selected_audio_index,
                  duration_sec: res.duration_sec ?? prev.duration_sec,
                  file_length: res.file_length ?? prev.file_length,
                  id3_artist: prev.id3_artist,
                  id3_title: prev.id3_title,
                  id3_album: prev.id3_album,
                }
              : prev,
          );
          hlsRecoveringRef.current = false;
        }
      } catch (err) {
        hlsRecoveringRef.current = false;
        if (!pendingTranscodeRef.current) {
          setTranscodeError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        switchingRef.current = false;
        if (pendingTranscodeRef.current) {
          const pending = pendingTranscodeRef.current;
          pendingTranscodeRef.current = null;
          void replaceTranscodeSession(
            pending.audioIndex,
            pending.startSec,
            pending.heightOverride,
          );
        } else {
          setTranscodeBusy(false);
          seekGuardRef.current = false;
        }
      }
    },
    [capturePlayerHeight, hlsMode, state, stopSession, videoHeight],
  );

  recoverHlsRef.current = () => {
    if (!state || !hlsMode) {
      hlsRecoveringRef.current = false;
      return;
    }
    const startSec = showFullTimeline
      ? Math.max(0, timelineSec || playbackStartSec)
      : Math.max(0, mediaRef.current?.currentTime ?? 0);
    void replaceTranscodeSession(selectedAudioIndex, startSec);
  };

  const seekToFilePosition = useCallback(
    (targetSec: number) => {
      if (!showFullTimeline) return;
      const clamped = Math.max(0, Math.min(fullDurationSec, targetSec));
      const media = mediaRef.current;
      const localSec = clamped - playbackStartSec;

      // Already downloaded in the current HLS window — just jump, no retranscode.
      if (
        !switchingRef.current &&
        media &&
        localSec >= 0 &&
        localTimeInBuffered(media, localSec)
      ) {
        if (seekCommitTimerRef.current != null) {
          window.clearTimeout(seekCommitTimerRef.current);
          seekCommitTimerRef.current = null;
        }
        seekGuardRef.current = true;
        setTimelineSec(clamped);
        media.currentTime = localSec;
        window.setTimeout(() => {
          seekGuardRef.current = false;
        }, 80);
        return;
      }

      seekGuardRef.current = true;
      setPlaybackStartSec(clamped);
      setTimelineSec(clamped);
      setBufferedSec(clamped);

      // Outside buffer: debounce retranscode so dragging doesn't spam sessions.
      if (seekCommitTimerRef.current != null) {
        window.clearTimeout(seekCommitTimerRef.current);
      }
      seekCommitTimerRef.current = window.setTimeout(() => {
        seekCommitTimerRef.current = null;
        void replaceTranscodeSession(selectedAudioIndex, clamped);
      }, 180);
    },
    [
      fullDurationSec,
      playbackStartSec,
      replaceTranscodeSession,
      selectedAudioIndex,
      showFullTimeline,
    ],
  );

  useEffect(() => {
    if (activeSubId === "off") return;
    if (!subs.some((s) => s.id === activeSubId)) {
      setActiveSubId("off");
    }
  }, [activeSubId, currentFile?.id, state?.file_index, subs]);

  useEffect(() => {
    if (!state?.hash) return;
    const ids = [state.file_index];
    if (activeSubId !== "off") ids.push(activeSubId);
    void setDownloadScope(state.hash, ids).catch(() => {});
  }, [state?.hash, state?.file_index, activeSubId]);

  useEffect(() => {
    if (!state || hlsMode) return;
    const media = mediaRef.current;
    if (!media) return;

    function syncAudioTracks() {
      const tracks = media?.audioTracks;
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

    media.addEventListener("loadedmetadata", syncAudioTracks);
    return () => media.removeEventListener("loadedmetadata", syncAudioTracks);
  }, [state?.stream_url, activeBrowserAudio, hlsMode, state]);

  useEffect(() => {
    if (!state || hlsMode) return;
    const media = mediaRef.current;
    const tracks = media?.audioTracks;
    if (!tracks || browserAudioTracks.length === 0) return;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].enabled = i === activeBrowserAudio;
    }
  }, [activeBrowserAudio, browserAudioTracks.length, hlsMode, state]);

  useEffect(() => {
    if (!state || !hlsMode || !state.playback_url) return;
    // Skip tear-down while a session swap is in flight — replace() already released HLS.
    const url = state.playback_url;
    attachHls(url, true);
    return () => {
      if (switchingRef.current) return;
      if (attachedPlaybackUrlRef.current === url) {
        attachedPlaybackUrlRef.current = null;
        releaseHls(hlsRef, mediaRef.current);
      }
    };
  }, [attachHls, hlsMode, state?.playback_url]);

  useEffect(() => {
    return () => {
      void stopSession(sessionIdRef.current);
      if (seekTimerRef.current != null) {
        window.clearTimeout(seekTimerRef.current);
      }
      if (seekCommitTimerRef.current != null) {
        window.clearTimeout(seekCommitTimerRef.current);
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
    const media = mediaRef.current;
    if (!media) return;

    function onTimeUpdate() {
      if (scrubbingRef.current || seekGuardRef.current) return;
      setTimelineSec(playbackStartSec + media.currentTime);
    }

    media.addEventListener("timeupdate", onTimeUpdate);
    return () => media.removeEventListener("timeupdate", onTimeUpdate);
  }, [playbackStartSec, showFullTimeline, state?.playback_url]);

  useEffect(() => {
    if (!isAudioOnly || showFullTimeline || !state) return;
    const media = mediaRef.current;
    if (!media) return;

    function onTimeUpdate() {
      if (scrubbingRef.current) return;
      setAudioUiTime(media.currentTime);
    }

    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("loadedmetadata", onTimeUpdate);
    return () => {
      media.removeEventListener("timeupdate", onTimeUpdate);
      media.removeEventListener("loadedmetadata", onTimeUpdate);
    };
  }, [isAudioOnly, showFullTimeline, state?.stream_url, state?.playback_url]);

  useEffect(() => {
    if (!isAudioOnly || !state) return;
    const media = mediaRef.current;
    if (!media) return;

    const onPlay = () => setAudioPlaying(true);
    const onPause = () => setAudioPlaying(false);
    const onVolume = () => setAudioVolume(media.volume);

    setAudioPlaying(!media.paused);
    setAudioVolume(media.volume);

    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("volumechange", onVolume);
    return () => {
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("volumechange", onVolume);
    };
  }, [isAudioOnly, state?.file_index, state?.stream_url, state?.playback_url]);

  useEffect(() => {
    if (isAudioOnly || !state) return;
    const media = mediaRef.current;
    if (!media) return;

    const onPlay = () => setVideoPlaying(true);
    const onPause = () => setVideoPlaying(false);
    const onVolume = () => setVideoVolume(media.volume);

    setVideoPlaying(!media.paused);
    setVideoVolume(media.volume);

    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("volumechange", onVolume);
    return () => {
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("volumechange", onVolume);
    };
  }, [isAudioOnly, state?.file_index, state?.stream_url, state?.playback_url]);

  useEffect(() => {
    if (isAudioOnly || showFullTimeline || !state) return;
    const media = mediaRef.current;
    if (!media) return;

    function onTimeUpdate() {
      if (scrubbingRef.current) return;
      setVideoUiTime(media.currentTime);
    }

    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("loadedmetadata", onTimeUpdate);
    return () => {
      media.removeEventListener("timeupdate", onTimeUpdate);
      media.removeEventListener("loadedmetadata", onTimeUpdate);
    };
  }, [isAudioOnly, showFullTimeline, state?.stream_url, state?.playback_url]);

  useEffect(() => {
    if (isAudioOnly || !state) return;
    const media = mediaRef.current;
    if (!media) return;

    const syncBuffered = () => {
      const localEnd = bufferedEndSec(media);
      const absolute = showFullTimeline ? playbackStartSec + localEnd : localEnd;
      setBufferedSec(absolute);
      capturePlayerHeight();
    };

    syncBuffered();
    media.addEventListener("progress", syncBuffered);
    media.addEventListener("loadedmetadata", syncBuffered);
    media.addEventListener("loadeddata", syncBuffered);
    media.addEventListener("canplay", syncBuffered);
    media.addEventListener("playing", capturePlayerHeight);
    window.addEventListener("resize", capturePlayerHeight);
    return () => {
      media.removeEventListener("progress", syncBuffered);
      media.removeEventListener("loadedmetadata", syncBuffered);
      media.removeEventListener("loadeddata", syncBuffered);
      media.removeEventListener("canplay", syncBuffered);
      media.removeEventListener("playing", capturePlayerHeight);
      window.removeEventListener("resize", capturePlayerHeight);
    };
  }, [
    capturePlayerHeight,
    isAudioOnly,
    playbackStartSec,
    showFullTimeline,
    state?.file_index,
    state?.playback_url,
    state?.stream_url,
  ]);

  useEffect(() => {
    return () => {
      if (controlsHideTimerRef.current != null) {
        window.clearTimeout(controlsHideTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isAudioOnly) return;
    if (!videoPlaying) {
      setControlsVisible(true);
      if (controlsHideTimerRef.current != null) {
        window.clearTimeout(controlsHideTimerRef.current);
        controlsHideTimerRef.current = null;
      }
      return;
    }
    if (controlsHideTimerRef.current != null) {
      window.clearTimeout(controlsHideTimerRef.current);
    }
    controlsHideTimerRef.current = window.setTimeout(() => {
      if (!scrubbingRef.current) setControlsVisible(false);
    }, 2800);
  }, [isAudioOnly, videoPlaying]);

  if (bootstrapping) {
    const step = bootstrapStatus.step ?? 1;
    const stepTotal = bootstrapStatus.step_total ?? 9;
    const probePhase = bootstrapStatus.phase === "probe";
    const probeTarget = bootstrapStatus.probe_bytes_target ?? 0;
    const probeGot = bootstrapStatus.probe_bytes_downloaded ?? 0;
    return (
      <div>
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

  const prevFile = adjacentPlayableFile(state.files, state.file_index, -1);
  const nextFile = adjacentPlayableFile(state.files, state.file_index, 1);
  const showFileNav = playableFiles(state.files).length > 1;

  const showApiAudio = hlsMode && apiAudioTracks.length > 0;
  const showBrowserAudio = !hlsMode && browserAudioTracks.length > 0;
  const episodes = episodeEntries(state.files);
  const seasons = [...new Set(episodes.map((e) => e.season))];
  const currentEpisode =
    episodes.find((e) => e.file.id === state.file_index) ?? null;
  const currentSeason = currentEpisode?.season ?? seasons[0] ?? null;
  const seasonEpisodes =
    currentSeason == null
      ? []
      : episodes.filter((e) => e.season === currentSeason);
  const showSeasonEpisode = !isAudioOnly && episodes.length > 0;

  const mediaDurationSec =
    !showFullTimeline && mediaRef.current && Number.isFinite(mediaRef.current.duration)
      ? mediaRef.current.duration
      : 0;
  const seekDuration = showFullTimeline
    ? fullDurationSec
    : mediaDurationSec > 0
      ? mediaDurationSec
      : fullDurationSec;
  const audioSeekCurrent = showFullTimeline ? timelineSec : audioUiTime;
  const videoSeekCurrent = showFullTimeline ? timelineSec : videoUiTime;
  const seekEnabled = seekDuration > 0;
  const videoPlayedPct =
    seekDuration > 0 ? clampRatio(videoSeekCurrent / seekDuration) * 100 : 0;
  const videoBufferedPct =
    seekDuration > 0
      ? clampRatio(Math.max(bufferedSec, videoSeekCurrent) / seekDuration) * 100
      : 0;

  const toggleMediaPlay = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) {
      safeMediaPlay(media);
    } else {
      media.pause();
    }
  };

  const onSeekInput = (value: number) => {
    if (showFullTimeline) {
      setTimelineSec(value);
      return;
    }
    if (isAudioOnly) {
      setAudioUiTime(value);
    } else {
      setVideoUiTime(value);
    }
    const media = mediaRef.current;
    if (media) media.currentTime = value;
  };

  const onSeekCommit = (value: number) => {
    if (showFullTimeline) {
      seekToFilePosition(value);
      return;
    }
    const media = mediaRef.current;
    if (media) media.currentTime = value;
  };

  const bumpControlsVisible = () => {
    setControlsVisible(true);
    if (controlsHideTimerRef.current != null) {
      window.clearTimeout(controlsHideTimerRef.current);
    }
    if (videoPlaying) {
      controlsHideTimerRef.current = window.setTimeout(() => {
        if (!scrubbingRef.current) setControlsVisible(false);
      }, 2800);
    }
  };

  const seekValueFromClientX = (clientX: number) => {
    const el = seekBarRef.current;
    if (!el || seekDuration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return clampRatio((clientX - rect.left) / rect.width) * seekDuration;
  };

  const onSeekBarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!seekEnabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    bumpControlsVisible();
    onSeekInput(seekValueFromClientX(e.clientX));
  };

  const onSeekBarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    onSeekInput(seekValueFromClientX(e.clientX));
  };

  const onSeekBarPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    const value = seekValueFromClientX(e.clientX);
    onSeekInput(value);
    onSeekCommit(value);
    bumpControlsVisible();
  };

  const onQualityChange = (v: string) => {
    const nextHeight = v === "auto" ? null : Number(v);
    setVideoHeight(nextHeight);
    seekGuardRef.current = true;
    void replaceTranscodeSession(
      selectedAudioIndex,
      currentFilePositionSec(),
      nextHeight,
    );
  };

  const onSeasonChange = (season: number) => {
    const inSeason = episodes.filter((e) => e.season === season);
    if (inSeason.length === 0) return;
    const preferEpisode = currentEpisode?.episode;
    const target =
      (preferEpisode != null
        ? inSeason.find((e) => e.episode === preferEpisode)
        : null) ?? inSeason[0];
    if (target && target.file.id !== state.file_index) {
      void switchToFile(target.file.id);
    }
  };

  const onEpisodeChange = (fileId: number) => {
    if (fileId !== state.file_index) void switchToFile(fileId);
  };

  const goAdjacent = (file: TorrentMediaFile | null) => {
    if (!file) return;
    void switchToFile(file.id);
  };

  return (
    <div>
      {isAudioOnly && (
        <div className="player-media-meta">
          <div>
            <span className="muted">Исполнитель</span> {state.id3_artist?.trim() || "—"}
          </div>
          <div>
            <span className="muted">Название</span> {state.id3_title?.trim() || "—"}
          </div>
          <div>
            <span className="muted">Альбом</span> {state.id3_album?.trim() || "—"}
          </div>
        </div>
      )}

      {transcodeBusy && <p className="muted">Перекодирование…</p>}
      {transcodeError && <p className="error">{transcodeError}</p>}

      {isAudioOnly && (
        <div className="track-panel">
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
        </div>
      )}

      {isAudioOnly && showFileNav && (
        <div className="player-file-nav">
          <button
            type="button"
            className="secondary"
            disabled={!prevFile || transcodeBusy}
            onClick={() => prevFile && navigateToPlayableFile(prevFile.id)}
          >
            ← Предыдущий
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!nextFile || transcodeBusy}
            onClick={() => nextFile && navigateToPlayableFile(nextFile.id)}
          >
            Следующий →
          </button>
        </div>
      )}

      {isAudioOnly && (
        <div className="custom-audio-player">
          <button
            type="button"
            className="custom-audio-player__play secondary"
            aria-label={audioPlaying ? "Пауза" : "Воспроизведение"}
            disabled={transcodeBusy}
            onClick={toggleMediaPlay}
          >
            {audioPlaying ? "⏸" : "▶"}
          </button>
          <div className="custom-audio-player__seek">
            <span className="custom-audio-player__time">
              {formatPlaybackTime(audioSeekCurrent)}
            </span>
            <input
              type="range"
              className="custom-audio-player__range"
              min={0}
              max={Math.max(seekDuration, 1)}
              step={showFullTimeline ? 1 : 0.1}
              value={Math.min(audioSeekCurrent, Math.max(seekDuration, 1))}
              disabled={transcodeBusy || !seekEnabled}
              onPointerDown={() => {
                scrubbingRef.current = true;
              }}
              onPointerUp={() => {
                scrubbingRef.current = false;
              }}
              onInput={(e) => onSeekInput(Number((e.target as HTMLInputElement).value))}
              onChange={(e) => {
                scrubbingRef.current = false;
                onSeekCommit(Number(e.target.value));
              }}
            />
            <span className="custom-audio-player__time">
              {formatPlaybackTime(seekDuration)}
            </span>
          </div>
          <label className="custom-audio-player__volume">
            <span className="muted">Громкость</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={audioVolume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setAudioVolume(v);
                const media = mediaRef.current;
                if (media) media.volume = v;
              }}
            />
          </label>
        </div>
      )}

      <div
        ref={playerWrapRef}
        className={`player-wrap${isAudioOnly ? " player-wrap--audio" : ""}${
          !isAudioOnly && controlsVisible ? " player-wrap--controls-visible" : ""
        }${!isAudioOnly && !videoPlaying ? " player-wrap--paused" : ""}${
          !isAudioOnly && transcodeBusy ? " player-wrap--busy" : ""
        }`}
        style={
          !isAudioOnly && lockedPlayerHeight > 0
            ? { minHeight: lockedPlayerHeight }
            : undefined
        }
        onMouseMove={!isAudioOnly ? bumpControlsVisible : undefined}
        onMouseLeave={
          !isAudioOnly
            ? () => {
                if (videoPlaying && !scrubbingRef.current) setControlsVisible(false);
              }
            : undefined
        }
      >
        {isAudioOnly ? (
          <audio
            ref={mediaRef}
            className="player-media-hidden"
            key={
              hlsMode
                ? `hls-audio-${state.file_index}`
                : `${state.stream_url}-${state.file_index}`
            }
            src={hlsMode ? undefined : state.stream_url}
            autoPlay={!hlsMode}
            crossOrigin={hlsMode ? undefined : "anonymous"}
            onEnded={() => {
              if (nextFile) navigateToPlayableFile(nextFile.id);
            }}
            playsInline
          />
        ) : (
          <>
            <video
              ref={mediaRef}
              key={
                hlsMode
                  ? `hls-${state.file_index}-${activeSubId}`
                  : `${state.stream_url}-${state.file_index}-${activeSubId}`
              }
              src={hlsMode ? undefined : state.stream_url}
              autoPlay={!hlsMode}
              crossOrigin={hlsMode ? undefined : "anonymous"}
              onClick={toggleMediaPlay}
              onEnded={() => {
                if (nextFile) void switchToFile(nextFile.id);
              }}
            >
              {activeSub?.stream_url && (
                <track
                  kind="subtitles"
                  src={absoluteMediaUrl(activeSub.stream_url)}
                  label={activeSub.name}
                  default
                />
              )}
            </video>

            <div className="player-controls player-controls--top">
              {showFileNav && (
                <div className="player-controls__nav">
                  <button
                    type="button"
                    className="player-controls__btn"
                    disabled={!prevFile || transcodeBusy}
                    onClick={() => goAdjacent(prevFile)}
                  >
                    ← Предыдущий
                  </button>
                  <button
                    type="button"
                    className="player-controls__btn"
                    disabled={!nextFile || transcodeBusy}
                    onClick={() => goAdjacent(nextFile)}
                  >
                    Следующий →
                  </button>
                </div>
              )}
              <div className="player-controls__selects">
                {showApiAudio && (
                  <label className="player-controls__field">
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
                  <label className="player-controls__field">
                    Озвучка
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
                {subs.length > 0 && (
                  <label className="player-controls__field">
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
                {showSeasonEpisode && (
                  <label className="player-controls__field">
                    Сезон
                    <select
                      value={currentSeason ?? ""}
                      disabled={transcodeBusy || seasons.length === 0}
                      onChange={(e) => onSeasonChange(Number(e.target.value))}
                    >
                      {currentSeason == null && (
                        <option value="" disabled>
                          Сезон
                        </option>
                      )}
                      {seasons.map((s) => (
                        <option key={s} value={s}>
                          Сезон {s}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {showSeasonEpisode && (
                  <label className="player-controls__field">
                    Серия
                    <select
                      value={currentEpisode?.file.id ?? ""}
                      disabled={transcodeBusy || seasonEpisodes.length === 0}
                      onChange={(e) => onEpisodeChange(Number(e.target.value))}
                    >
                      {!currentEpisode && (
                        <option value="" disabled>
                          Серия
                        </option>
                      )}
                      {seasonEpisodes.map((e) => (
                        <option key={e.file.id} value={e.file.id}>
                          Серия {e.episode}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>

            <div className="player-controls player-controls--bottom">
              <button
                type="button"
                className="player-controls__play"
                aria-label={videoPlaying ? "Пауза" : "Воспроизведение"}
                onClick={toggleMediaPlay}
              >
                {videoPlaying ? "⏸" : "▶"}
              </button>
              <div className="player-controls__seek">
                <span className="player-controls__time">
                  {formatPlaybackTime(videoSeekCurrent)}
                </span>
                <div
                  ref={seekBarRef}
                  className={`seek-bar${transcodeBusy ? " seek-bar--busy" : ""}${
                    !seekEnabled ? " seek-bar--disabled" : ""
                  }`}
                  role="slider"
                  tabIndex={seekEnabled ? 0 : -1}
                  aria-label="Позиция воспроизведения"
                  aria-valuemin={0}
                  aria-valuemax={Math.max(seekDuration, 1)}
                  aria-valuenow={Math.min(videoSeekCurrent, Math.max(seekDuration, 1))}
                  aria-valuetext={formatPlaybackTime(videoSeekCurrent)}
                  aria-busy={transcodeBusy}
                  onPointerDown={onSeekBarPointerDown}
                  onPointerMove={onSeekBarPointerMove}
                  onPointerUp={onSeekBarPointerUp}
                  onPointerCancel={onSeekBarPointerUp}
                >
                  <div className="seek-bar__track">
                    <div
                      className="seek-bar__buffered"
                      style={{ width: `${videoBufferedPct}%` }}
                    />
                    <div
                      className="seek-bar__played"
                      style={{ width: `${videoPlayedPct}%` }}
                    />
                    {transcodeBusy && <div className="seek-bar__stripes" aria-hidden />}
                  </div>
                  <div
                    className="seek-bar__thumb"
                    style={{ left: `${videoPlayedPct}%` }}
                  />
                </div>
                <span className="player-controls__time">
                  {formatPlaybackTime(seekDuration)}
                </span>
              </div>
              <label className="player-controls__volume">
                <span className="player-controls__volume-label">Громкость</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={videoVolume}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVideoVolume(v);
                    const media = mediaRef.current;
                    if (media) media.volume = v;
                  }}
                />
              </label>
              <label className="player-controls__field player-controls__field--quality">
                Качество
                <select
                  value={videoHeight ?? "auto"}
                  disabled={transcodeBusy}
                  onChange={(e) => onQualityChange(e.target.value)}
                >
                  <option value="auto">Авто / оригинал</option>
                  {VIDEO_QUALITY_PRESETS.map((h) => (
                    <option key={h} value={h}>
                      {h}p
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </>
        )}
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
