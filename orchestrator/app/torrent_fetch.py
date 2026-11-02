from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.models import Provider, ReleaseDetail
from app.providers.rutor import MIRRORS as RUTOR_MIRRORS

logger = logging.getLogger(__name__)

RUTOR_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; HomeCinema/0.1)"}


def torrent_download_url(detail: ReleaseDetail) -> Optional[str]:
    if detail.torrent_url:
        return detail.torrent_url.strip() or None
    if detail.provider in (Provider.rutor, Provider.rutor_direct):
        return f"https://d.rutor.info/download/{detail.external_id}"
    return None


def looks_like_torrent_file(data: bytes) -> bool:
    if len(data) < 32:
        return False
    if data.lstrip()[:1] == b"<":
        return False
    return data.lstrip()[:1] == b"d"


async def fetch_torrent_bytes(
    url: str,
    *,
    timeout: float = 45.0,
    headers: dict[str, str] | None = None,
) -> Optional[bytes]:
    hdrs = dict(RUTOR_HEADERS)
    if headers:
        hdrs.update(headers)
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers=hdrs,
        ) as client:
            r = await client.get(url)
            if r.status_code != 200:
                logger.info("torrent fetch HTTP %s for %s", r.status_code, url[:80])
                return None
            data = r.content
            if not looks_like_torrent_file(data):
                logger.info(
                    "torrent fetch not a .torrent (%s bytes) from %s",
                    len(data),
                    url[:80],
                )
                return None
            return data
    except httpx.HTTPError as e:
        logger.warning("torrent fetch failed %s: %s", url[:80], e)
        return None


async def fetch_torrent_for_release(
    detail: ReleaseDetail,
    *,
    timeout: float = 45.0,
) -> Optional[bytes]:
    url = torrent_download_url(detail)
    if not url:
        return None
    data = await fetch_torrent_bytes(url, timeout=timeout)
    if data:
        return data
    if detail.provider in (Provider.rutor_direct, Provider.rutor):
        for base in RUTOR_MIRRORS:
            alt = f"{base}/torrent/download/{detail.external_id}.torrent"
            data = await fetch_torrent_bytes(alt, timeout=timeout)
            if data:
                return data
    return None
