import unittest

from app.file_progress import progress_from_cache, progress_from_file_stats


class TestEngineFileProgress(unittest.TestCase):
    def test_engine_files_sentinel(self) -> None:
        raw = [{"id": 1, "length": 1000, "path": "a.mkv"}]
        cache = {
            "_engine_files": [
                {"id": 1, "downloaded_bytes": 500, "priority": 7, "length": 1000},
            ]
        }
        prog = progress_from_cache(raw, cache)
        self.assertEqual(prog[1]["downloaded"], 500)
        self.assertEqual(prog[1]["priority"], 7)

    def test_progress_from_file_stats(self) -> None:
        prog = progress_from_file_stats(
            [{"id": 2, "downloaded_bytes": 99, "priority": 1, "length": 200}]
        )
        self.assertEqual(prog[2]["downloaded"], 99)

    def test_empty_cache_uses_file_stats(self) -> None:
        raw = [{"id": 1, "length": 1_000_000, "downloaded_bytes": 999_000, "priority": 7}]
        prog = progress_from_cache(raw, {})
        self.assertEqual(prog[1]["downloaded"], 999_000)
        self.assertEqual(prog[1]["priority"], 7)


if __name__ == "__main__":
    unittest.main()
