from __future__ import annotations

from pathlib import Path


def find_torrent_media_file(torrents_root: Path, relative_path: str) -> Path | None:
    """Locate a file under torrent save path (libtorrent uses save_path / torrent_name / rel)."""
    if not relative_path.strip():
        return None
    rel_norm = relative_path.replace("\\", "/").strip("/")
    root = torrents_root
    if not root.is_dir():
        return None

    direct = root / rel_norm
    if direct.is_file():
        return direct
    by_name = root / Path(rel_norm).name
    if by_name.is_file():
        return by_name

    for entry in root.iterdir():
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        candidate = entry / rel_norm
        if candidate.is_file():
            return candidate

    leaf = Path(rel_norm).name
    if not leaf:
        return None
    for candidate in root.rglob(leaf):
        if not candidate.is_file():
            continue
        try:
            if candidate.relative_to(root).as_posix().endswith(rel_norm):
                return candidate
        except ValueError:
            continue
        if candidate.name == leaf and rel_norm.endswith(leaf):
            return candidate
    return None
