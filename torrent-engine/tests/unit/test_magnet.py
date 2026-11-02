import unittest

from app.magnet import info_hash_from_magnet


class TestMagnet(unittest.TestCase):
    def test_hex_btih(self) -> None:
        magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        self.assertEqual(
            info_hash_from_magnet(magnet),
            "0123456789abcdef0123456789abcdef01234567",
        )


if __name__ == "__main__":
    unittest.main()
