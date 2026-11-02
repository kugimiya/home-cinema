import unittest

from app.playback_probe import extract_duration_sec, resolve_probe_duration


class TestExtractDurationSec(unittest.TestCase):
    def test_format_duration(self) -> None:
        data = {"format": {"duration": "7200.5"}, "streams": []}
        self.assertEqual(extract_duration_sec(data), 7200.5)

    def test_matroska_duration_tag(self) -> None:
        data = {
            "format": {
                "duration": "120.0",
                "tags": {"DURATION": "02:00:00.000000000"},
            },
            "streams": [],
        }
        self.assertEqual(extract_duration_sec(data), 7200.0)

    def test_video_stream_duration(self) -> None:
        data = {
            "format": {},
            "streams": [
                {"codec_type": "video", "duration": "5400.25"},
            ],
        }
        self.assertEqual(extract_duration_sec(data), 5400.25)

    def test_resolve_probe_duration_partial_head(self) -> None:
        file_length = 8693914042
        resolved = resolve_probe_duration(28.0, file_length)
        self.assertIsNotNone(resolved)
        assert resolved is not None
        self.assertGreater(resolved, 3600.0)


if __name__ == "__main__":
    unittest.main()
