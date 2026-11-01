from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.clients.torrserver import (
    TorrServerClient,
    _extract_files,
    file_index_and_path,
    pick_video_file,
)
from app.config import Settings
from app.models import (
    PlayRequest,
    PlayResponse,
    Provider,
    ReleaseDetail,
    SearchResponse,
    TorrentEntry,
    TorrentFileStat,
    TorrentListResponse,
)
from app.providers.rutor import RuTorClient
from app.providers.torapi import TorAPIClient
from app.search_service import SearchService
from app.store import MetaStore, TorrentMeta

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

settings = Settings()
store = MetaStore(settings.database_path)
torapi = TorAPIClient(settings.torapi_url, settings.search_timeout)
rutor = RuTorClient(settings.search_timeout)
search_service = SearchService(torapi, rutor)
torr = TorrServerClient(
    settings.torrserver_url,
    settings.torrserver_public_url,
    settings.torrents_save_path,
    settings.play_metadata_timeout,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await torr.wait_ready()
    await torr.bootstrap_disk_settings()
    yield


app = FastAPI(title="Home Cinema Orchestrator", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/search", response_model=SearchResponse)
async def api_search(q: str = Query(..., min_length=1)) -> SearchResponse:
    source, releases = await search_service.search(q)
    return SearchResponse(query=q, source=source, releases=releases)


@app.get("/api/releases/{provider}/{external_id}", response_model=ReleaseDetail)
async def api_release_detail(provider: Provider, external_id: str) -> ReleaseDetail:
    try:
        return await search_service.release_detail(provider, external_id)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@app.post("/api/play", response_model=PlayResponse)
async def api_play(body: PlayRequest) -> PlayResponse:
    magnet = body.magnet
    title = body.title or "Untitled"
    quality: Optional[str] = None
    voice: Optional[str] = None
    provider_str: Optional[str] = None
    external_id: Optional[str] = None

    if body.provider and body.external_id:
        detail = await search_service.release_detail(body.provider, body.external_id)
        magnet = magnet or detail.magnet
        title = detail.title or title
        quality = detail.quality
        voice = detail.voice
        provider_str = body.provider.value
        external_id = body.external_id

    if not magnet:
        raise HTTPException(status_code=400, detail="magnet link is required")

    try:
        added = await torr.add_torrent(magnet, title, save_to_db=True)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"TorrServer add failed: {e}") from e

    info_hash = (added.get("hash") or "").lower()
    if not info_hash and "btih:" in magnet.lower():
        import re

        m = re.search(r"btih:([a-f0-9]+)", magnet, re.I)
        if m:
            info_hash = m.group(1).lower()
    if not info_hash:
        raise HTTPException(status_code=502, detail="Could not determine info hash")

    try:
        status = await torr.wait_for_files(info_hash)
    except TimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e)) from e

    files = _extract_files(status)
    if not files:
        raise HTTPException(status_code=504, detail="No files in torrent metadata")
    video = pick_video_file(files)
    file_index, file_path = file_index_and_path(video)

    store.upsert(
        TorrentMeta(
            info_hash=info_hash,
            title=title,
            provider=provider_str,
            external_id=external_id,
            quality=quality,
            voice=voice,
        )
    )

    stream_url = torr.build_stream_url(info_hash, file_path, file_index)
    return PlayResponse(
        hash=info_hash,
        title=title,
        stream_url=stream_url,
        file_name=file_path,
        file_index=file_index,
    )


@app.get("/api/torrents", response_model=TorrentListResponse)
async def api_torrents() -> TorrentListResponse:
    items = await torr.list_torrents()
    entries: list[TorrentEntry] = []
    for item in items:
        h = (item.get("hash") or "").lower()
        if not h:
            continue
        detail = await torr.get_torrent(h)
        merged = {**item, **detail} if detail else item
        meta = store.get(h)
        file_stats_raw = merged.get("file_stats") or []
        if not file_stats_raw:
            file_stats_raw = _extract_files(merged)
        file_stats = [
            TorrentFileStat(
                id=int(f.get("id") or f.get("Id") or 0),
                path=f.get("path") or f.get("Path") or "",
                length=int(f.get("length") or f.get("Length") or 0),
            )
            for f in file_stats_raw
        ]
        entries.append(
            TorrentEntry(
                hash=h,
                title=merged.get("title") or (meta.title if meta else h),
                stat_string=merged.get("stat_string"),
                torrent_size=merged.get("torrent_size"),
                loaded_size=merged.get("loaded_size"),
                preloaded_bytes=merged.get("preloaded_bytes"),
                bytes_written_data=merged.get("bytes_written_data"),
                download_speed=merged.get("download_speed"),
                upload_speed=merged.get("upload_speed"),
                total_peers=merged.get("total_peers"),
                connected_seeders=merged.get("connected_seeders"),
                quality=meta.quality if meta else None,
                voice=meta.voice if meta else None,
                search_query=meta.search_query if meta else None,
                provider=meta.provider if meta else None,
                file_stats=file_stats,
            )
        )
    return TorrentListResponse(torrents=entries)


@app.delete("/api/torrents/{info_hash}")
async def api_delete_torrent(
    info_hash: str,
    delete_files: bool = Query(default=True, alias="deleteFiles"),
) -> dict[str, str]:
    h = info_hash.lower()
    try:
        await torr.drop_torrent(h)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    if delete_files:
        torr.delete_cache_dir(h)
    store.delete(h)
    return {"status": "deleted", "hash": h}
