from __future__ import annotations

from typing import Any, Callable, Optional

from app.torrent_files import file_index_and_path
from app.metadata import parse_quality, parse_voice
from app.models import MediaKind, TorrentMediaFile

VIDEO_EXT = (".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts", ".m2ts")
SUBTITLE_EXT = (".srt", ".ass", ".ssa", ".vtt", ".sub", ".sup")
AUDIO_EXT = (".mp3", ".flac", ".aac", ".m4a", ".wav", ".opus")


def media_kind_for_path(path: str) -> MediaKind:
    lower = path.lower()
    if lower.endswith(VIDEO_EXT):
        return MediaKind.video
    if lower.endswith(SUBTITLE_EXT):
        return MediaKind.subtitle
    if lower.endswith(AUDIO_EXT):
        return MediaKind.audio
    return MediaKind.other


def _basename(path: str) -> str:
    return path.replace("\\", "/").rsplit("/", 1)[-1]


def torrent_file_to_media(
    file_entry: dict[str, Any],
    *,
    stream_url: Optional[str] = None,
) -> TorrentMediaFile:
    idx, path = file_index_and_path(file_entry)
    length = int(file_entry.get("length") or file_entry.get("Length") or 0)
    name = _basename(path)
    kind = media_kind_for_path(path)
    return TorrentMediaFile(
        id=idx,
        path=path,
        name=name,
        length=length,
        kind=kind,
        quality=parse_quality(name) or parse_quality(path),
        voice=parse_voice(name) or parse_voice(path),
        stream_url=stream_url,
    )


def build_media_catalog(
    raw_files: list[dict[str, Any]],
    *,
    stream_url_for: Optional[Callable[[int, str], str]] = None,
) -> list[TorrentMediaFile]:
    items: list[TorrentMediaFile] = []
    for entry in raw_files:
        idx, path = file_index_and_path(entry)
        url = stream_url_for(idx, path) if stream_url_for else None
        items.append(torrent_file_to_media(entry, stream_url=url))
    items.sort(key=lambda f: (f.kind.value, f.path.lower()))
    return items


def pick_default_video(files: list[TorrentMediaFile]) -> Optional[TorrentMediaFile]:
    videos = [f for f in files if f.kind == MediaKind.video]
    if not videos:
        return None
    if len(videos) == 1:
        return videos[0]
    return max(videos, key=lambda f: f.length)
