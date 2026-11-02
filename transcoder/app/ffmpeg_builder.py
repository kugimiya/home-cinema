from __future__ import annotations

from pathlib import Path
from typing import Literal

PlaybackMode = Literal["direct", "hls_transcode", "hls_remux"]

PLAYLIST_NAME = "index.m3u8"


def build_ffmpeg_command(
    source: str,
    out_dir: Path,
    *,
    playback_mode: PlaybackMode,
    video_copy: bool,
    audio_copy: bool,
    audio_ordinal: int,
    start_sec: float,
    video_height: int | None = None,
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
            source,
            "-map",
            "0:v:0",
            "-map",
            f"0:a:{audio_ordinal}?",
        ]
    )

    need_scale = video_height is not None and video_height > 0
    if need_scale:
        video_copy = False

    if playback_mode == "hls_remux" and video_copy and audio_copy and not need_scale:
        cmd.extend(["-c:v", "copy", "-c:a", "copy"])
    else:
        if video_copy and not need_scale:
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
            if need_scale:
                cmd.extend(["-vf", f"scale=-2:min({video_height}\\,ih)"])
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
