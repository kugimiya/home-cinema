from pathlib import Path

from app.ffmpeg_builder import build_ffmpeg_command


def test_scale_height_in_command() -> None:
    cmd = build_ffmpeg_command(
        "/torrents/x/video.mkv",
        Path("/tmp/out"),
        playback_mode="hls_transcode",
        video_copy=True,
        audio_copy=False,
        audio_ordinal=0,
        start_sec=0,
        video_height=480,
    )
    text = " ".join(cmd)
    assert "scale=-2:min(480\\,ih)" in text
    assert "-c:v libx264" in text


def test_remux_copy_when_no_scale() -> None:
    cmd = build_ffmpeg_command(
        "http://example/stream",
        Path("/tmp/out2"),
        playback_mode="hls_remux",
        video_copy=True,
        audio_copy=True,
        audio_ordinal=0,
        start_sec=0,
        video_height=None,
    )
    assert "-c:v" in cmd and "copy" in cmd
    assert "-c:a" in cmd and cmd[cmd.index("-c:a") + 1] == "copy"
