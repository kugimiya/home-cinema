"""LAN discovery helpers for mobile/TV clients."""

from __future__ import annotations

import logging
import socket
import threading
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from fastapi import Request

logger = logging.getLogger(__name__)

SERVICE_ID = "home-cinema-orchestrator"
MDNS_SERVICE_TYPE = "_homecinema._tcp.local."


@dataclass(frozen=True)
class DiscoverPayload:
    service: str
    version: str
    api_base: str
    stream_proxy_base: str
    torrserver_base: str

    def as_dict(self) -> dict[str, str]:
        return {
            "service": self.service,
            "version": self.version,
            "api_base": self.api_base,
            "stream_proxy_base": self.stream_proxy_base,
            "torrserver_base": self.torrserver_base,
        }


def _lan_host_from_request(request: Request) -> str:
    host = (request.headers.get("host") or "").split(":")[0].strip()
    if host and host not in ("localhost", "127.0.0.1", "0.0.0.0"):
        return host
    forwarded = request.headers.get("x-forwarded-host", "").split(":")[0].strip()
    if forwarded and forwarded not in ("localhost", "127.0.0.1"):
        return forwarded
    if request.client and request.client.host:
        client = request.client.host
        if client not in ("127.0.0.1", "::1"):
            return client
    return "localhost"


def build_discover_payload(
    request: Request,
    *,
    version: str,
    orchestrator_public_url: str,
    torrserver_public_url: str,
    default_api_port: int = 8080,
    default_web_port: int = 3000,
    default_torr_port: int = 8090,
) -> DiscoverPayload:
    host = _lan_host_from_request(request)
    scheme = request.url.scheme or "http"
    api_port = request.url.port or default_api_port
    api_base = f"{scheme}://{host}:{api_port}"

    def _rewrite_public(default_url: str, fallback_port: int) -> str:
        parsed = urlparse(default_url)
        pub_host = parsed.hostname or "localhost"
        pub_port = parsed.port or fallback_port
        pub_scheme = parsed.scheme or "http"
        if pub_host in ("localhost", "127.0.0.1"):
            return f"{pub_scheme}://{host}:{fallback_port}"
        return default_url.rstrip("/")

    stream_proxy_base = _rewrite_public(orchestrator_public_url, default_web_port)
    torrserver_base = _rewrite_public(torrserver_public_url, default_torr_port)

    return DiscoverPayload(
        service=SERVICE_ID,
        version=version,
        api_base=api_base.rstrip("/"),
        stream_proxy_base=stream_proxy_base.rstrip("/"),
        torrserver_base=torrserver_base.rstrip("/"),
    )


def guess_lan_ip() -> str | None:
    """Best-effort IPv4 for mDNS advertisement (may fail in some Docker setups)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return None


class MdnsAdvertiser:
    """Registers Home Cinema orchestrator via mDNS (optional)."""

    def __init__(
        self,
        *,
        port: int,
        version: str,
        enabled: bool,
    ) -> None:
        self._port = port
        self._version = version
        self._enabled = enabled
        self._zeroconf: Any | None = None
        self._info: Any | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if not self._enabled:
            return
        ip = guess_lan_ip()
        if not ip:
            logger.warning("mDNS: no LAN IP, skipping advertisement")
            return

        def _register() -> None:
            try:
                from zeroconf import ServiceInfo, Zeroconf
            except ImportError:
                logger.warning("mDNS: zeroconf not installed, skipping")
                return
            try:
                props = {
                    "service": SERVICE_ID,
                    "version": self._version,
                }
                info = ServiceInfo(
                    MDNS_SERVICE_TYPE,
                    f"Home Cinema.{MDNS_SERVICE_TYPE}",
                    addresses=[socket.inet_aton(ip)],
                    port=self._port,
                    properties={k: v.encode("utf-8") for k, v in props.items()},
                )
                zc = Zeroconf()
                zc.register_service(info)
                self._zeroconf = zc
                self._info = info
                logger.info("mDNS: advertised %s on %s:%s", SERVICE_ID, ip, self._port)
            except Exception:
                logger.exception("mDNS: advertisement failed, continuing without mDNS")

        self._thread = threading.Thread(target=_register, name="home-cinema-mdns", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._zeroconf and self._info:
            try:
                self._zeroconf.unregister_service(self._info)
                self._zeroconf.close()
            except Exception:
                logger.exception("mDNS shutdown failed")
        self._zeroconf = None
        self._info = None
