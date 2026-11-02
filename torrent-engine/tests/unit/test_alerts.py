from app.alerts import AlertRing, serialize_alert


class _FakeAlert:
    def message(self) -> str:
        return "test message"

    def category(self) -> int:
        return 42


def test_serialize_alert_minimal() -> None:
    d = serialize_alert(_FakeAlert())
    assert d["type"] == "_FakeAlert"
    assert d["message"] == "test message"
    assert d["category"] == 42
    assert "at" in d


def test_alert_ring_capacity() -> None:
    ring = AlertRing(10)
    for i in range(15):
        ring.extend([{"type": "x", "at": float(i), "message": str(i)}])
    recent = ring.list_recent(100)
    assert len(recent) == 10
    assert recent[-1]["message"] == "14"
