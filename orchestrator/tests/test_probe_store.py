from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.models import AudioTrackInfo
from app.playback_probe import ProbeResult
from app.probe_store import ProbeCacheStore, default_warm_head_bytes


class TestProbeStore(unittest.TestCase):
    def test_default_warm_head_mp4_larger(self) -> None:
        n = default_warm_head_bytes("movie.mp4", 100_000_000, fallback=4_194_304)
        self.assertGreaterEqual(n, 8 * 1024 * 1024)

    def test_cache_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "t.sqlite3"
            store = ProbeCacheStore(str(db))
            result = ProbeResult(
                status="ok",
                playback_mode="direct",
                direct_playable=True,
                audio_tracks=[
                    AudioTrackInfo(index=0, stream_index=0, label="Дорожка 1"),
                ],
                video_copy=True,
                audio_copy=True,
                duration_sec=120.0,
            )
            store.save_probe(
                "aa" * 20,
                3,
                "ep.mkv",
                1000,
                result,
                warm_head_bytes=5_000_000,
            )
            self.assertEqual(store.get_warm_head_bytes("aa" * 20, 3), 5_000_000)
            cached = store.get_cached_probe("aa" * 20, 3, "ep.mkv", 1000)
            self.assertIsNotNone(cached)
            assert cached is not None
            self.assertEqual(cached.playback_mode, "direct")
            self.assertEqual(cached.duration_sec, 120.0)


if __name__ == "__main__":
    unittest.main()
