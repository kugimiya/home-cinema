from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.metadata import parse_quality, parse_voice
from app.models import Provider, Release, ReleaseDetail

logger = logging.getLogger(__name__)

PROVIDER_MAP = {
    "RuTracker": Provider.rutracker,
    "Kinozal": Provider.kinozal,
    "RuTor": Provider.rutor,
    "NoNameClub": Provider.nonameclub,
}

API_PROVIDER = {
    Provider.rutracker: "rutracker",
    Provider.kinozal: "kinozal",
    Provider.rutor: "rutor",
    Provider.nonameclub: "nonameclub",
}


class TorAPIClient:
    def __init__(self, base_url: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def healthy(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(f"{self.base_url}/api/provider/list")
                return r.status_code == 200
        except httpx.HTTPError:
            return False

    async def search_all(self, query: str) -> list[Release]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.get(
                f"{self.base_url}/api/search/title/all",
                params={"query": query, "page": "0"},
            )
            r.raise_for_status()
            data = r.json()
        releases: list[Release] = []
        if not isinstance(data, dict):
            return releases
        for provider_name, items in data.items():
            provider = PROVIDER_MAP.get(provider_name)
            if not provider:
                continue
            if isinstance(items, dict) and items.get("Result"):
                continue
            if not isinstance(items, list):
                continue
            for item in items:
                rel = _item_to_release(provider, item)
                if rel:
                    releases.append(rel)
        return releases

    async def release_detail(self, provider: Provider, external_id: str) -> ReleaseDetail:
        api_name = API_PROVIDER.get(provider)
        if not api_name:
            raise ValueError(f"TorAPI does not support provider {provider}")
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.get(
                f"{self.base_url}/api/search/id/{api_name}",
                params={"query": external_id},
            )
            r.raise_for_status()
            data = r.json()
        data = _normalize_detail_payload(data, external_id)
        if isinstance(data, dict) and data.get("Result"):
            raise httpx.HTTPError(data.get("Result", "Not found"))
        return _detail_from_torapi(provider, external_id, data)


def _normalize_detail_payload(data: Any, external_id: str) -> dict[str, Any]:
    """TorAPI returns a dict for some trackers and a one-item list for RuTor."""
    if isinstance(data, list):
        if not data:
            raise httpx.HTTPError("Not found")
        for item in data:
            if not isinstance(item, dict):
                continue
            item_id = item.get("Id")
            if item_id is not None and str(item_id) == str(external_id):
                return item
        first = data[0]
        if isinstance(first, dict):
            return first
        raise httpx.HTTPError("Unexpected TorAPI response")
    if isinstance(data, dict):
        return data
    raise httpx.HTTPError("Unexpected TorAPI response")


def _item_to_release(provider: Provider, item: dict[str, Any]) -> Optional[Release]:
    title = item.get("Name") or item.get("Title") or ""
    if not title:
        return None
    ext_id = str(item.get("Id") or "")
    if not ext_id:
        return None
    fmt = item.get("Format")
    lang = item.get("Language")
    return Release(
        provider=provider,
        external_id=ext_id,
        title=title.strip(),
        quality=parse_quality(title, fmt),
        voice=parse_voice(title, lang),
        size=item.get("Size"),
        seeds=str(item.get("Seeds")) if item.get("Seeds") is not None else None,
        peers=str(item.get("Peers")) if item.get("Peers") is not None else None,
        url=item.get("Url"),
    )


def _detail_from_torapi(
    provider: Provider, external_id: str, data: dict[str, Any]
) -> ReleaseDetail:
    title = data.get("Name") or data.get("Title") or ""
    magnet = data.get("Magnet")
    hash_val = data.get("Hash")
    audio = data.get("Audio")
    return ReleaseDetail(
        provider=provider,
        external_id=external_id,
        title=title.strip() or external_id,
        quality=parse_quality(title, data.get("Format")),
        voice=parse_voice(title, audio or data.get("Language")),
        size=data.get("Size"),
        magnet=magnet,
        hash=hash_val,
        url=data.get("Url"),
        description=data.get("Description"),
    )
