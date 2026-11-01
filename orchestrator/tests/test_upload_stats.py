from __future__ import annotations

import unittest

from app.upload_stats import accumulate_upload


class TestAccumulateUpload(unittest.TestCase):
    def test_grows_with_reported(self) -> None:
        life, last = accumulate_upload(100, 80, 120)
        self.assertEqual(life, 140)
        self.assertEqual(last, 120)

    def test_handles_counter_reset(self) -> None:
        life, last = accumulate_upload(500, 400, 50)
        self.assertEqual(life, 550)
        self.assertEqual(last, 50)

    def test_negative_inputs_clamped(self) -> None:
        life, last = accumulate_upload(-1, -1, 10)
        self.assertEqual(life, 10)
        self.assertEqual(last, 10)


if __name__ == "__main__":
    unittest.main()
