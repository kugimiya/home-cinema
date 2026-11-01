from __future__ import annotations

import html
import logging
import re
from typing import Optional
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

from app.metadata import parse_quality, parse_voice
from app.models import Provider, Release, ReleaseDetail

logger = logging.getLogger(__name__)

MIRRORS = ("https://rutor.info", "https://rutor.is")
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; HomeCinema/0.1)"}


class RuTorClient:
    def __init__(self, timeout: float) -> None:
        self.timeout = timeout

    async def search(self, query: str) -> list[Release]:
        last_error: Optional[Exception] = None
        for base in MIRRORS:
            try:
                url = f"{base}/search/0/0/000/0/{quote(query)}"
                async with httpx.AsyncClient(timeout=self.timeout, headers=HEADERS) as client:
                    r = await client.get(url)
                    r.raise_for_status()
                    return _parse_search_html(r.text, base)
            except httpx.HTTPError as e:
                logger.warning("RuTor mirror %s failed: %s", base, e)
                last_error = e
        if last_error:
            raise last_error
        return []

    async def release_detail(self, external_id: str) -> ReleaseDetail:
        last_error: Optional[Exception] = None
        for base in MIRRORS:
            try:
                url = f"{base}/torrent/{external_id}"
                async with httpx.AsyncClient(timeout=self.timeout, headers=HEADERS) as client:
                    r = await client.get(url)
                    r.raise_for_status()
                    return _parse_detail_html(r.text, external_id, base)
            except httpx.HTTPError as e:
                last_error = e
        if last_error:
            raise last_error
        raise httpx.HTTPError("RuTor detail unavailable")


def _parse_search_html(text: str, base: str) -> list[Release]:
    soup = BeautifulSoup(text, "lxml")
    releases: list[Release] = []
    for tr in soup.select("table tr.gai, table tr.tum"):
        link = tr.select_one('a[href^="/torrent/"]')
        mag = tr.select_one('a[href^="magnet:"]')
        if not link or not mag:
            continue
        href = link.get("href", "")
        m_id = re.search(r"/torrent/(\d+)/", href)
        if not m_id:
            continue
        title = link.get_text(strip=True)
        peers_cell = tr.get_text(" ", strip=True)
        seeds, peers = _guess_seeds_peers(peers_cell)
        releases.append(
            Release(
                provider=Provider.rutor_direct,
                external_id=m_id.group(1),
                title=title,
                quality=parse_quality(title),
                voice=parse_voice(title),
                magnet=html.unescape(mag.get("href", "")),
                url=f"{base}{href}",
                seeds=seeds,
                peers=peers,
            )
        )
    return releases


def _parse_detail_html(text: str, external_id: str, base: str) -> ReleaseDetail:
    soup = BeautifulSoup(text, "lxml")
    h1 = soup.select_one("#all h1, h1")
    title = h1.get_text(strip=True) if h1 else external_id
    magnet_el = soup.select_one('a[href^="magnet:"]')
    magnet = html.unescape(magnet_el.get("href", "")) if magnet_el else None
    hash_val = None
    if magnet:
        m = re.search(r"btih:([A-Fa-f0-9]+)", magnet, re.I)
        if m:
            hash_val = m.group(1).upper()
    size = _table_value(soup, "Размер")
    seeds = _table_value(soup, "Сиды")
    peers = _table_value(soup, "Пиры")
    return ReleaseDetail(
        provider=Provider.rutor_direct,
        external_id=external_id,
        title=title,
        quality=parse_quality(title),
        voice=parse_voice(title),
        size=size,
        seeds=seeds,
        peers=peers,
        magnet=magnet,
        hash=hash_val,
        url=f"{base}/torrent/{external_id}",
    )


def _table_value(soup: BeautifulSoup, label: str) -> Optional[str]:
    for td in soup.select("#details td.header"):
        if td.get_text(strip=True) == label:
            nxt = td.find_next_sibling("td")
            if nxt:
                return nxt.get_text(" ", strip=True)
    return None


def _guess_seeds_peers(cell: str) -> tuple[Optional[str], Optional[str]]:
    m = re.search(r"(\d+)\s*[\×xX]\s*(\d+)", cell)
    if m:
        return m.group(1), m.group(2)
    return None, None
