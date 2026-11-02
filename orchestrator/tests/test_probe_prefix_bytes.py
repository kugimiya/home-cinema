import unittest

from app.probe_messages import probe_prefix_bytes_from_start

TARGET = 4 * 1024 * 1024
FULL = 8693914042


class TestProbePrefixBytes(unittest.TestCase):
    def test_head_takes_precedence_and_caps_at_target(self) -> None:
        self.assertEqual(
            probe_prefix_bytes_from_start(
                target=TARGET, head_bytes=2 * 1024 * 1024, torrent_downloaded=FULL
            ),
            2 * 1024 * 1024,
        )

    def test_torrent_total_capped_not_shown_as_full_file(self) -> None:
        self.assertEqual(
            probe_prefix_bytes_from_start(
                target=TARGET, torrent_downloaded=FULL
            ),
            TARGET,
        )

    def test_local_file_capped_at_target(self) -> None:
        self.assertEqual(
            probe_prefix_bytes_from_start(
                target=TARGET, local_file_size=FULL
            ),
            TARGET,
        )


if __name__ == "__main__":
    unittest.main()
