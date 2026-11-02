from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path
from typing import Optional

from app.playback_probe import PlaybackMode

logger = logging.getLogger(__name__)

PLAYLIST_NAME = "index.m3u8"


def build_ffmpeg_command(
    source_url: str,
    out_dir: Path,
    *,
    playback_mode: PlaybackMode,
    video_copy: bool,
    audio_copy: bool,
    audio_ordinal: int,
    start_sec: float,
) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    playlist = out_dir / PLAYLIST_NAME
    segment_pattern = str(out_dir / "seg_%03d.m4s")

    cmd: list[str] = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y"]
    if start_sec > 0.05:
        cmd.extend(["-ss", f"{start_sec:.3f}"])
    cmd.extend(
        [
            "-fflags",
            "+genpts+discardcorrupt",
            "-probesize",
            "32M",
            "-analyzeduration",
            "10M",
            "-i",
            source_url,
            "-map",
            "0:v:0",
            "-map",
            f"0:a:{audio_ordinal}?",
        ]
    )

    if playback_mode == "hls_remux" and video_copy and audio_copy:
        cmd.extend(["-c:v", "copy", "-c:a", "copy"])
    else:
        if video_copy:
            cmd.extend(["-c:v", "copy"])
        else:
            cmd.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-profile:v",
                    "main",
                ]
            )
        if audio_copy:
            cmd.extend(["-c:a", "copy"])
        else:
            cmd.extend(["-c:a", "aac", "-b:a", "128k", "-ac", "2"])

    cmd.extend(
        [
            "-f",
            "hls",
            "-hls_time",
            "6",
            "-hls_list_size",
            "0",
            "-hls_segment_type",
            "fmp4",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "-hls_flags",
            "independent_segments",
            "-hls_segment_filename",
            segment_pattern,
            str(playlist),
        ]
    )
    return cmd


async def spawn_ffmpeg(cmd: list[str]) -> asyncio.subprocess.Process:
    logger.info("starting ffmpeg: %s", " ".join(cmd[:8]))
    return await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )


async def wait_for_playlist(out_dir: Path, timeout: float = 120.0) -> bool:
    playlist = out_dir / PLAYLIST_NAME
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if playlist.is_file() and playlist.stat().st_size > 0:
            return True
        await asyncio.sleep(0.25)
    return False


def finalize_hls_playlist(out_dir: Path) -> bool:
    """Append EXT-X-ENDLIST so clients stop live manifest polling."""
    playlist = out_dir / PLAYLIST_NAME
    if not playlist.is_file():
        return False
    text = playlist.read_text(encoding="utf-8", errors="replace")
    if "#EXT-X-ENDLIST" in text:
        return False
    playlist.write_text(text.rstrip() + "\n#EXT-X-ENDLIST\n", encoding="utf-8")
    return True


def is_hls_playlist_complete(out_dir: Path) -> bool:
    playlist = out_dir / PLAYLIST_NAME
    if not playlist.is_file():
        return False
    try:
        return "#EXT-X-ENDLIST" in playlist.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def terminate_process(proc: Optional[asyncio.subprocess.Process]) -> None:
    if proc is None:
        return
    if proc.returncode is not None:
        return
    try:
        os.kill(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except OSError:
        proc.kill()
