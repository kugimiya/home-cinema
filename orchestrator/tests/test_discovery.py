from starlette.requests import Request

from app.discovery import SERVICE_ID, build_discover_payload


def _request(host: str, client: str = "192.168.1.10") -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/discover",
        "headers": [(b"host", host.encode())],
        "query_string": b"",
        "client": (client, 12345),
        "server": ("127.0.0.1", 8080),
        "scheme": "http",
        "root_path": "",
    }
    return Request(scope)


def test_discover_rewrites_localhost_urls_for_lan_client() -> None:
    payload = build_discover_payload(
        _request("192.168.1.5:8080"),
        version="0.1.0",
        orchestrator_public_url="http://localhost:3000",
        torrserver_public_url="http://localhost:8090",
    )
    assert payload.service == SERVICE_ID
    assert payload.api_base == "http://192.168.1.5:8080"
    assert payload.stream_proxy_base == "http://192.168.1.5:3000"
    assert payload.torrserver_base == "http://192.168.1.5:8090"
