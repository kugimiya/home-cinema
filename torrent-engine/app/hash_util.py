from __future__ import annotations

from typing import Any


def sha1_to_hex(value: Any) -> str:
    """libtorrent 1.x uses to_hex(); 2.x sha1_hash often uses to_string() or str."""
    if value is None:
        return ""
    to_hex = getattr(value, "to_hex", None)
    if callable(to_hex):
        return to_hex().lower()
    to_bytes = getattr(value, "to_bytes", None)
    if callable(to_bytes):
        raw = to_bytes()
        if isinstance(raw, (bytes, bytearray)):
            return bytes(raw).hex().lower()
    to_string = getattr(value, "to_string", None)
    if callable(to_string):
        raw = to_string()
        if isinstance(raw, (bytes, bytearray)):
            return bytes(raw).hex().lower()
        text = str(raw).strip().lower()
        if len(text) == 40 and all(c in "0123456789abcdef" for c in text):
            return text
        return text
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        if len(raw) == 20:
            return raw.hex().lower()
        return raw.decode("utf-8", errors="replace").lower()
    text = str(value).strip().lower()
    if text.startswith("0x"):
        text = text[2:]
    return text
