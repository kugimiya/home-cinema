from app.client_identity import client_session_settings


def test_client_session_settings_empty() -> None:
    assert client_session_settings() == {}


def test_client_session_settings_user_agent() -> None:
    ident = client_session_settings(user_agent="home-cinema/1.0")
    assert ident["user_agent"] == "home-cinema/1.0"
    assert ident["handshake_client_version"] == "home-cinema 1.0"
