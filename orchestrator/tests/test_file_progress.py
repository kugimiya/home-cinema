from __future__ import annotations

import unittest

from app.file_progress import upload_bytes_per_file


class TestUploadBytesPerFile(unittest.TestCase):
    def test_split_by_active_downloaded(self) -> None:
        progress = {
            1: {"downloaded": 1000, "priority": 7},
            2: {"downloaded": 3000, "priority": 0},
        }
        shares = upload_bytes_per_file(progress, 4_000_000)
        self.assertEqual(shares[1], 4_000_000)
        self.assertEqual(shares[2], 0)

    def test_split_proportional_when_no_priority(self) -> None:
        progress = {
            1: {"downloaded": 1000, "priority": 0},
            2: {"downloaded": 3000, "priority": 0},
        }
        shares = upload_bytes_per_file(progress, 400)
        self.assertEqual(shares[1], 100)
        self.assertEqual(shares[2], 300)


if __name__ == "__main__":
    unittest.main()
