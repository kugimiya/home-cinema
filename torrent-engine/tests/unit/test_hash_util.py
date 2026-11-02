from app.hash_util import sha1_to_hex


def test_sha1_to_hex_from_string() -> None:
    assert sha1_to_hex("ABCD") == "abcd"


def test_sha1_to_hex_mock_to_string() -> None:
    class _H:
        def to_string(self) -> bytes:
            return bytes.fromhex("ab" * 20)

    assert sha1_to_hex(_H()) == "ab" * 20
