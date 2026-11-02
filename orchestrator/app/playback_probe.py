from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Callable
from typing import Literal, Optional

from app.models import AudioTrackInfo

logger = logging.getLogger(__name__)

PlaybackMode = Literal["direct", "hls_transcode", "hls_remux"]

BROWSER_VIDEO = frozenset({"h264", "avc1", "vp9", "vp8", "av1"})
BROWSER_VIDEO_HEVC = frozenset({"hevc", "hev1", "h265"})
BROWSER_AUDIO = frozenset({"aac", "mp3", "opus", "flac", "vorbis"})
DIRECT_CONTAINERS = frozenset({"mov", "mp4", "m4v", "webm", "mkv", "matroska"})
FORCE_TRANSCODE_EXT = frozenset({".avi", ".wmv", ".asf", ".mpg", ".mpeg", ".vob"})


@dataclass
class ProbeResult:
    status: Literal["ok", "pending"] = "ok"
    playback_mode: PlaybackMode = "direct"
    direct_playable: bool = True
    audio_tracks: list[AudioTrackInfo] = field(default_factory=list)
    video_copy: bool = False
    audio_copy: bool = False
    duration_sec: Optional[float] = None


def _norm_codec(name: Optional[str]) -> str:
    if not name:
        return ""
    return name.lower().split(".")[0].strip()


def _video_browser_ok(codec: str, allow_hevc: bool) -> bool:
    c = _norm_codec(codec)
    if c in BROWSER_VIDEO:
        return True
    if allow_hevc and c in BROWSER_VIDEO_HEVC:
        return True
    return False


def _audio_browser_ok(codec: str) -> bool:
    return _norm_codec(codec) in BROWSER_AUDIO


def _track_label(stream: dict, ordinal: int) -> str:
    tags = stream.get("tags") or {}
    title = tags.get("title") or tags.get("TITLE")
    lang = tags.get("language") or tags.get("LANGUAGE")
    parts = [p for p in (title, lang) if p]
    if parts:
        return " · ".join(str(p) for p in parts)
    return f"Дорожка {ordinal + 1}"


def _parse_duration_number(raw: object) -> Optional[float]:
    if raw is None:
        return None
    try:
        value = max(0.0, float(raw))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _parse_duration_tag(raw: object) -> Optional[float]:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if ":" in text:
        parts = text.split(":")
        try:
            if len(parts) == 3:
                hours = int(parts[0])
                minutes = int(parts[1])
                seconds = float(parts[2])
                value = hours * 3600 + minutes * 60 + seconds
            elif len(parts) == 2:
                minutes = int(parts[0])
                seconds = float(parts[1])
                value = minutes * 60 + seconds
            else:
                return None
        except (TypeError, ValueError):
            return None
        return value if value > 0 else None
    return _parse_duration_number(text)


def _duration_from_tags(tags: dict) -> Optional[float]:
    for key in ("DURATION", "duration", "Duration"):
        if key in tags:
            parsed = _parse_duration_tag(tags[key])
            if parsed is not None:
                return parsed
    return None


def estimate_duration_from_file_bytes(file_length: int) -> Optional[float]:
    if file_length <= 0:
        return None
    megabytes = file_length / (1024 * 1024)
    return megabytes * 2.0


def resolve_probe_duration(
    duration_sec: Optional[float], file_length: int
) -> Optional[float]:
    """Prefer full-file estimate when ffprobe only saw a partial buffer."""
    api = duration_sec if duration_sec is not None and duration_sec > 0 else 0.0
    estimate = estimate_duration_from_file_bytes(file_length)
    if file_length <= 0:
        return duration_sec
    if estimate is None:
        return duration_sec
    if api <= 0:
        return estimate
    if api < 120 and estimate > api * 2.5:
        return estimate
    if file_length > 100 * 1024 * 1024 and api < 300 and estimate > api:
        return estimate
    return max(api, estimate)


def extract_duration_sec(data: dict) -> Optional[float]:
    """Best-effort file duration from ffprobe JSON (format, streams, tags)."""
    fmt = data.get("format") or {}
    streams = data.get("streams") or []

    best: Optional[float] = None
    fmt_dur = _parse_duration_number(fmt.get("duration"))
    if fmt_dur is not None:
        best = fmt_dur

    tag_dur = _duration_from_tags(fmt.get("tags") or {})
    if tag_dur is not None and (best is None or tag_dur > best):
        best = tag_dur

    for stream in streams:
        if stream.get("codec_type") != "video":
            continue
        stream_dur = _parse_duration_number(stream.get("duration"))
        if stream_dur is not None and (best is None or stream_dur > best):
            best = stream_dur
        st_tag = _duration_from_tags(stream.get("tags") or {})
        if st_tag is not None and (best is None or st_tag > best):
            best = st_tag

    return best


def _parse_probe_payload(data: dict, path: str, allow_hevc: bool) -> ProbeResult:
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    format_name = (fmt.get("format_name") or "").lower()
    ext = Path(path).suffix.lower()

    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    if not video_streams:
        raise ValueError("No video stream in file")

    duration_sec = extract_duration_sec(data)

    video_codec = video_streams[0].get("codec_name") or ""
    audio_tracks: list[AudioTrackInfo] = []
    for i, stream in enumerate(audio_streams):
        tags = stream.get("tags") or {}
        audio_tracks.append(
            AudioTrackInfo(
                index=i,
                stream_index=int(stream.get("index", i)),
                codec=stream.get("codec_name"),
                language=tags.get("language") or tags.get("LANGUAGE"),
                title=tags.get("title") or tags.get("TITLE"),
                label=_track_label(stream, i),
            )
        )

    if not audio_tracks:
        audio_tracks.append(
            AudioTrackInfo(
                index=0,
                stream_index=0,
                codec=None,
                language=None,
                title=None,
                label="Дорожка 1",
            )
        )

    video_ok = _video_browser_ok(video_codec, allow_hevc)
    all_audio_ok = all(_audio_browser_ok(a.codec or "") for a in audio_tracks)
    container_ok = ext in {".mp4", ".m4v", ".webm"} or any(
        c in format_name for c in DIRECT_CONTAINERS
    )
    force_transcode = ext in FORCE_TRANSCODE_EXT

    if (
        not force_transcode
        and video_ok
        and all_audio_ok
        and container_ok
        and ext not in FORCE_TRANSCODE_EXT
    ):
        return ProbeResult(
            status="ok",
            playback_mode="direct",
            direct_playable=True,
            audio_tracks=audio_tracks,
            video_copy=True,
            audio_copy=True,
            duration_sec=duration_sec,
        )

    video_copy = video_ok and not force_transcode
    audio_copy = all_audio_ok and not force_transcode
    if video_copy and audio_copy:
        mode: PlaybackMode = "hls_remux"
    else:
        mode = "hls_transcode"

    return ProbeResult(
        status="ok",
        playback_mode=mode,
        direct_playable=False,
        audio_tracks=audio_tracks,
        video_copy=video_copy,
        audio_copy=audio_copy,
        duration_sec=duration_sec,
    )


async def _ffprobe_exec(
    target: str,
    timeout: float,
    *,
    on_tick: Callable[[int], None] | None = None,
) -> dict:
    cmd: list[str] = [
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
    ]
    if "://" in target:
        # Avoid scanning multi-GB MKV over HTTP (index at end of file).
        cmd.extend(
            [
                "-probesize",
                str(32 * 1024 * 1024),
                "-analyzeduration",
                str(15 * 1_000_000),
            ]
        )
    cmd.append(target)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    communicate_task = asyncio.create_task(proc.communicate())
    start = time.monotonic()
    try:
        while not communicate_task.done():
            elapsed = int(time.monotonic() - start)
            if on_tick is not None:
                on_tick(elapsed)
            if time.monotonic() - start > timeout:
                proc.kill()
                await proc.wait()
                raise TimeoutError("ffprobe timed out") from None
            await asyncio.sleep(1.0)
        stdout, stderr = await communicate_task
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise

    if proc.returncode != 0:
        err = (stderr or b"").decode(errors="replace").strip()
        raise RuntimeError(err or f"ffprobe exit {proc.returncode}")

    return json.loads(stdout.decode())


async def ffprobe_url(
    url: str,
    timeout: float,
    *,
    on_tick: Callable[[int], None] | None = None,
) -> dict:
    return await _ffprobe_exec(url, timeout, on_tick=on_tick)


async def ffprobe_path(path: str, timeout: float) -> dict:
    return await _ffprobe_exec(path, timeout)


async def probe_playback(
    url: str,
    file_path: str,
    *,
    allow_hevc: bool,
    timeout: float,
    retries: int,
    retry_delay: float,
    on_attempt: Callable[[int, int], None] | None = None,
    on_tick: Callable[[int, str], None] | None = None,
) -> ProbeResult:
    last_err: Optional[Exception] = None
    total = max(1, retries)
    for attempt in range(total):
        if on_attempt is not None:
            on_attempt(attempt + 1, total)

        def tick(elapsed: int) -> None:
            if on_tick is not None:
                on_tick(elapsed, "analyze_stream")

        try:
            data = await ffprobe_url(url, timeout, on_tick=tick if on_tick else None)
            return _parse_probe_payload(data, file_path, allow_hevc)
        except (RuntimeError, json.JSONDecodeError, ValueError, KeyError) as e:
            last_err = e
            msg = str(e).lower()
            pending = any(
                x in msg
                for x in (
                    "invalid data",
                    "could not find codec",
                    "end of file",
                    "connection",
                    "404",
                    "403",
                    "timed out",
                    "i/o error",
                )
            )
            if pending and attempt < retries - 1:
                logger.info("probe retry %s/%s: %s", attempt + 1, retries, e)
                if on_tick is not None:
                    on_tick(0, "retry_wait")
                await asyncio.sleep(retry_delay)
                continue
            if pending:
                return ProbeResult(status="pending")
            raise
        except TimeoutError as e:
            last_err = e
            if attempt < retries - 1:
                if on_tick is not None:
                    on_tick(0, "retry_wait")
                await asyncio.sleep(retry_delay)
                continue
            return ProbeResult(status="pending")

    if last_err:
        logger.warning("probe failed: %s", last_err)
    return ProbeResult(status="pending")
