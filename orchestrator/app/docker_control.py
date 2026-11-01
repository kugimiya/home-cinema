from __future__ import annotations

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

ALLOWED_IDS = frozenset({"torrserver", "torapi", "orchestrator"})


class DockerControl:
    def __init__(
        self,
        *,
        enabled: bool,
        socket_path: str,
        container_names: dict[str, str],
    ) -> None:
        self.enabled = enabled
        self.socket_path = socket_path
        self.container_names = container_names

    def restart_allowed(self, service_id: str) -> bool:
        return self.enabled and service_id in ALLOWED_IDS

    async def restart_container(self, service_id: str) -> None:
        if not self.restart_allowed(service_id):
            raise PermissionError("Service restart is disabled")
        name = self.container_names.get(service_id)
        if not name:
            raise ValueError(f"Unknown service id: {service_id}")

        transport = httpx.AsyncHTTPTransport(uds=self.socket_path)
        async with httpx.AsyncClient(transport=transport, timeout=30.0) as client:
            filters = json.dumps({"name": [name]})
            listed = await client.get(
                "http://docker/v1.44/containers/json",
                params={"all": "true", "filters": filters},
            )
            listed.raise_for_status()
            containers: list[dict[str, Any]] = listed.json()
            cid = None
            for c in containers:
                names = c.get("Names") or []
                if any(name in (n or "").lstrip("/") or (n or "").endswith(name) for n in names):
                    cid = c.get("Id")
                    break
                if name in str(c.get("Names")):
                    cid = c.get("Id")
                    break
            if not cid and containers:
                cid = containers[0].get("Id")
            if not cid:
                raise RuntimeError(f"Container not found: {name}")

            r = await client.post(
                f"http://docker/v1.44/containers/{cid}/restart",
                params={"t": "10"},
            )
            r.raise_for_status()
            logger.info("Restarted container %s (%s)", name, service_id[:8] if len(service_id) > 8 else service_id)
