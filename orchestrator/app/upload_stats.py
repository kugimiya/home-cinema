from __future__ import annotations


def accumulate_upload(
    lifetime_bytes: int, last_reported_bytes: int, reported_bytes: int
) -> tuple[int, int]:
    """Merge TorrServer upload counter into a monotonic lifetime total."""
    reported = max(0, int(reported_bytes))
    lifetime = max(0, int(lifetime_bytes))
    last = max(0, int(last_reported_bytes))
    if reported >= last:
        lifetime += reported - last
    else:
        lifetime += reported
    return lifetime, reported
