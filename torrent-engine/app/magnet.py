from __future__ import annotations

import base64
import re
from typing import Optional

_BTIH_HEX = re.compile(r"btih:([a-f0-9]{40})", re.I)
_BTIH_B32 = re.compile(r"btih:([a-z2-7]{32})", re.I)


def info_hash_from_magnet(link: str) -> Optional[str]:
    m = _BTIH_HEX.search(link)
    if m:
        return m.group(1).lower()
    m = _BTIH_B32.search(link)
    if not m:
        return None
    try:
        encoded = m.group(1).upper()
        encoded += "=" * (-len(encoded) % 8)
        raw = base64.b32decode(encoded)
    except (ValueError, TypeError):
        return None
    return raw.hex().lower()
