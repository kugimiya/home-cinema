from __future__ import annotations

import logging

import httpx

from app.models import Provider, Release, ReleaseDetail
from app.providers.rutor import RuTorClient
from app.providers.torapi import TorAPIClient

logger = logging.getLogger(__name__)


class SearchService:
    def __init__(self, torapi: TorAPIClient, rutor: RuTorClient) -> None:
        self.torapi = torapi
        self.rutor = rutor

    async def search(self, query: str) -> tuple[str, list[Release]]:
        if await self.torapi.healthy():
            try:
                releases = await self.torapi.search_all(query)
                if releases:
                    return "torapi", releases
            except httpx.HTTPError as e:
                logger.warning("TorAPI search failed: %s", e)
        releases = await self.rutor.search(query)
        return "rutor_fallback", releases

    async def release_detail(self, provider: Provider, external_id: str) -> ReleaseDetail:
        if provider == Provider.rutor_direct:
            return await self.rutor.release_detail(external_id)
        if await self.torapi.healthy():
            try:
                return await self.torapi.release_detail(provider, external_id)
            except httpx.HTTPError as e:
                logger.warning("TorAPI detail failed: %s", e)
        if provider == Provider.rutor:
            return await self.rutor.release_detail(external_id)
        raise httpx.HTTPError(f"Cannot resolve release for {provider}/{external_id}")
