from __future__ import annotations


def client_session_settings(
    *,
    user_agent: str | None = None,
    peer_fingerprint: str | None = None,
    handshake_client_version: str | None = None,
) -> dict[str, str]:
    out: dict[str, str] = {}
    if user_agent:
        out["user_agent"] = user_agent
    if peer_fingerprint:
        out["peer_fingerprint"] = peer_fingerprint
    if handshake_client_version:
        out["handshake_client_version"] = handshake_client_version
    elif user_agent:
        out.setdefault("handshake_client_version", user_agent.replace("/", " ", 1))
    return out
