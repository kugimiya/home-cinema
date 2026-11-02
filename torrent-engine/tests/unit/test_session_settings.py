from app.config import Settings
from app.session_settings import build_session_configuration


def test_build_session_configuration_defaults() -> None:
    cfg = build_session_configuration(Settings())
    assert cfg.libtorrent["connections_limit"] == 500
    assert cfg.libtorrent["unchoke_slots_limit"] == 20
    assert cfg.libtorrent["active_limit"] == -1
    assert cfg.max_connections_per_torrent == 100
    assert cfg.libtorrent["user_agent"] == "home-cinema/1.0"
