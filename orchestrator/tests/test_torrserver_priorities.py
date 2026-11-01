from __future__ import annotations

import unittest

from app.clients.torrserver import (
    PRIORITY_BACKGROUND,
    PRIORITY_OFF,
    PRIORITY_STREAM,
    file_download_priority,
)


class TestFileDownloadPriority(unittest.TestCase):
    def test_streaming_file(self) -> None:
        active = {3, 5}
        self.assertEqual(file_download_priority(3, active), PRIORITY_STREAM)

    def test_background_when_other_active(self) -> None:
        self.assertEqual(file_download_priority(9, {3}), PRIORITY_BACKGROUND)

    def test_off_when_nothing_active(self) -> None:
        self.assertEqual(file_download_priority(1, set()), PRIORITY_OFF)


if __name__ == "__main__":
    unittest.main()
