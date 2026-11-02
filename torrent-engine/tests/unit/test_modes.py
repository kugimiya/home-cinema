import unittest

from app.modes import (
    PRIORITY_BACKGROUND,
    PRIORITY_OFF,
    PRIORITY_STREAM,
    TorrentMode,
    apply_mode_to_scope,
    file_download_priority,
)


class TestFileDownloadPriority(unittest.TestCase):
    def test_stream_active(self) -> None:
        active = {3}
        self.assertEqual(file_download_priority(3, active), PRIORITY_STREAM)

    def test_background_when_other_active(self) -> None:
        self.assertEqual(file_download_priority(9, {3}), PRIORITY_BACKGROUND)

    def test_off_when_empty_scope(self) -> None:
        self.assertEqual(file_download_priority(1, set()), PRIORITY_OFF)


class TestApplyMode(unittest.TestCase):
    def test_paused_clears_active(self) -> None:
        self.assertEqual(apply_mode_to_scope(TorrentMode.paused, {1, 2}), set())

    def test_streaming_keeps_scope(self) -> None:
        self.assertEqual(apply_mode_to_scope(TorrentMode.streaming, {2}), {2})


if __name__ == "__main__":
    unittest.main()
