from __future__ import annotations

from app.models import MediaKind, TorrentFileStat, TorrentMediaFile
from app.probe_warm import (
    ProbeWarmManager,
    overlay_warm_on_stats,
    select_auto_video_ids,
    select_manual_video_ids,
)
from app.activity_tracker import ActivityTracker
from unittest.mock import MagicMock


def _catalog() -> list[TorrentMediaFile]:
    return [
        TorrentMediaFile(id=1, path="a/01.mkv", name="01.mkv", length=1000, kind=MediaKind.video),
        TorrentMediaFile(id=2, path="a/02.mkv", name="02.mkv", length=1000, kind=MediaKind.video),
        TorrentMediaFile(id=3, path="a/03.mkv", name="03.mkv", length=1000, kind=MediaKind.video),
        TorrentMediaFile(id=4, path="a/subs.srt", name="subs.srt", length=10, kind=MediaKind.subtitle),
    ]


def test_select_auto_video_ids_next_n():
    cat = _catalog()
    assert select_auto_video_ids(cat, 1, 2) == [2, 3]
    assert select_auto_video_ids(cat, 1, 1) == [2]
    assert select_auto_video_ids(cat, 3, 2) == []


def test_select_auto_video_ids_all():
    cat = _catalog()
    assert select_auto_video_ids(cat, 1, -1) == [2, 3]
    assert select_auto_video_ids(cat, 1, 0) == []


def test_select_manual_video_ids_limit():
    raw = [
        {"id": 1, "path": "01.mkv", "length": 5000},
        {"id": 2, "path": "02.mkv", "length": 5000},
    ]

    def never_ready(_h: str, _fid: int, _length: int, _d: int) -> bool:
        return False

    items = select_manual_video_ids(raw, 1, is_ready=never_ready, info_hash="ab")
    assert len(items) == 1
    assert items[0][0] == 1


def test_is_file_ready_from_downloaded():
    torr = MagicMock()
    mgr = ProbeWarmManager(
        torr,
        ActivityTracker(),
        warm_bytes=100,
        auto_files=2,
        manual_files=-1,
        concurrency=1,
        fetch_cache=MagicMock(),
    )
    assert mgr.is_file_ready("aa", 1, 1000, 150) is True
    assert mgr.is_file_ready("aa", 2, 1000, 10) is False


def test_overlay_warm_on_stats_disabled():
    torr = MagicMock()
    mgr = ProbeWarmManager(
        torr,
        ActivityTracker(),
        warm_bytes=0,
        auto_files=2,
        manual_files=-1,
        concurrency=1,
        fetch_cache=MagicMock(),
    )
    stats = [
        TorrentFileStat(id=1, path="x.mkv", length=100, downloaded_bytes=0),
    ]
    out = overlay_warm_on_stats(stats, "aa", mgr)
    assert out[0].warm_status == "off"
    assert out[0].warm_target_bytes == 0


def test_overlay_warm_ready_when_downloaded():
    torr = MagicMock()
    mgr = ProbeWarmManager(
        torr,
        ActivityTracker(),
        warm_bytes=100,
        auto_files=2,
        manual_files=-1,
        concurrency=1,
        fetch_cache=MagicMock(),
    )
    stats = [
        TorrentFileStat(id=1, path="x.mkv", length=1000, downloaded_bytes=200),
    ]
    out = overlay_warm_on_stats(stats, "aa", mgr)
    assert out[0].warm_status == "ready"
    assert out[0].warm_target_bytes == 100


def test_get_file_state_uses_path_for_target():
    torr = MagicMock()

    def target_fn(_h: str, _fid: int, _path: str, _length: int) -> int:
        return 99

    mgr = ProbeWarmManager(
        torr,
        ActivityTracker(),
        warm_bytes=100,
        auto_files=2,
        manual_files=-1,
        concurrency=1,
        fetch_cache=MagicMock(),
        warm_target_fn=target_fn,
    )
    st = mgr.get_file_state("aa", 1, 1000, 0, False, "x.mkv")
    assert st.target_bytes == 99
