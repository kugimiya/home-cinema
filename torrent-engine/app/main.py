from __future__ import annotations

import asyncio
import base64
import logging
import re
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.logging_setup import configure_logging
from app.modes import TorrentMode
from app.session import get_manager

configure_logging()
logger = logging.getLogger(__name__)

_STREAM_CHUNK = 512 * 1024

_RANGE = re.compile(r"bytes=(\d+)-(\d*)")


def _fmt_bytes(n: int) -> str:
    if n >= 1024**3:
        return f"{n / 1024**3:.2f}GiB"
    if n >= 1024**2:
        return f"{n / 1024**2:.2f}MiB"
    if n >= 1024:
        return f"{n / 1024:.1f}KiB"
    return f"{n}B"


class AddTorrentBody(BaseModel):
    link: str = ""
    title: str = "Untitled"
    save_to_db: bool = True
    torrent_b64: str | None = None
    magnet: str | None = None


class ScopeBody(BaseModel):
    file_ids: list[int] = Field(default_factory=list)


class ModeBody(BaseModel):
    mode: TorrentMode


class HeartbeatBody(BaseModel):
    file_ids: list[int] = Field(default_factory=list)
    stream_active: bool = True


async def _mode_ticker() -> None:
    mgr = get_manager()
    while True:
        await asyncio.sleep(5)
        mgr.tick_modes()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_mode_ticker())
    yield
    task.cancel()


app = FastAPI(title="home-cinema torrent-engine", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "torrent-engine", "status": "ok"}


@app.post("/v1/torrents")
def add_torrent(body: AddTorrentBody) -> dict[str, Any]:
    mgr = get_manager()
    try:
        if body.torrent_b64:
            raw = base64.b64decode(body.torrent_b64, validate=True)
            magnet = (body.magnet or body.link or "").strip()
            detail = mgr.add_torrent_bytes(
                raw,
                body.title,
                magnet=magnet,
                save_to_db=body.save_to_db,
            )
        else:
            link = body.link.strip()
            if not link:
                raise HTTPException(status_code=400, detail="link or torrent_b64 required")
            detail = mgr.add_torrent(link, body.title, save_to_db=body.save_to_db)
        logger.info(
            "add_torrent title=%r hash=%s files=%s",
            body.title,
            (detail.get("hash") or "")[:8],
            len(detail.get("file_stats") or []),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("add torrent failed")
        raise HTTPException(status_code=400, detail=str(e)) from e
    return detail


@app.get("/v1/torrents")
def list_torrents() -> list[dict[str, Any]]:
    return get_manager().list_torrents()


@app.get("/v1/session/status")
def session_status() -> dict[str, Any]:
    return get_manager().session_status()


@app.get("/v1/alerts")
def list_alerts(limit: int = Query(100, ge=1, le=400)) -> dict[str, Any]:
    items = get_manager().drain_alerts(limit)
    return {"alerts": items, "count": len(items)}


@app.get("/v1/torrents/{info_hash}")
def get_torrent(info_hash: str) -> dict[str, Any]:
    detail = get_manager().get_torrent(info_hash.lower())
    if not detail:
        raise HTTPException(status_code=404, detail="Not found")
    return detail


@app.delete("/v1/torrents/{info_hash}")
def delete_torrent(info_hash: str) -> dict[str, str]:
    get_manager().remove_torrent(info_hash.lower())
    return {"status": "removed", "hash": info_hash.lower()}


@app.post("/v1/torrents/{info_hash}/scope")
def set_scope(info_hash: str, body: ScopeBody) -> dict[str, str]:
    h = info_hash.lower()
    logger.info("set_scope hash=%s file_ids=%s", h[:8], body.file_ids)
    get_manager().set_scope(h, body.file_ids)
    return {"status": "ok", "hash": h}


@app.post("/v1/torrents/{info_hash}/mode")
def set_mode(info_hash: str, body: ModeBody) -> dict[str, str]:
    h = info_hash.lower()
    logger.info("set_mode hash=%s mode=%s", h[:8], body.mode.value)
    get_manager().set_mode(h, body.mode)
    return {"status": "ok", "hash": h, "mode": body.mode.value}


@app.post("/v1/torrents/{info_hash}/heartbeat")
def heartbeat(info_hash: str, body: HeartbeatBody) -> dict[str, str]:
    get_manager().heartbeat(info_hash.lower(), body.file_ids, body.stream_active)
    return {"status": "ok"}


def _parse_range(header: str | None, file_size: int) -> tuple[int, int]:
    if not header:
        return 0, max(0, file_size - 1)
    m = _RANGE.match(header.strip())
    if not m:
        return 0, max(0, file_size - 1)
    start = int(m.group(1))
    end_s = m.group(2)
    end = int(end_s) if end_s else max(0, file_size - 1)
    return start, min(end, max(0, file_size - 1))


@app.get("/v1/torrents/{info_hash}/files/{file_index}/stream")
async def stream_file_v1(
    info_hash: str,
    file_index: int,
    request: Request,
) -> Response:
    return await _stream_response(info_hash.lower(), file_index, request)


@app.get("/stream/{file_path:path}")
async def stream_legacy(
    request: Request,
    file_path: str,
    link: str = Query(...),
    index: int = Query(1),
) -> Response:
    _ = unquote(file_path)
    return await _stream_response(link.lower(), index, request)


async def _stream_response(info_hash: str, file_index: int, request: Request) -> Response:
    mgr = get_manager()
    detail = mgr.get_torrent(info_hash)
    if not detail:
        raise HTTPException(status_code=404, detail="Torrent not found")
    files = detail.get("file_stats") or []
    length = 0
    for f in files:
        if int(f.get("id") or 0) == file_index:
            length = int(f.get("length") or 0)
            break
    if length <= 0:
        raise HTTPException(status_code=404, detail="File not found")

    range_header = request.headers.get("range")
    start, end = _parse_range(range_header, length)
    mgr.set_scope(info_hash, [file_index])
    mgr.set_mode(info_hash, TorrentMode.streaming)

    span = end - start + 1
    logger.info(
        "stream hash=%s file=%s http_range=%s bytes=%s span=%s (%s) file_size=%s (%s)",
        info_hash[:8],
        file_index,
        range_header or "(full file)",
        f"{start}-{end}",
        span,
        _fmt_bytes(span),
        length,
        _fmt_bytes(length),
    )

    loop = asyncio.get_running_loop()
    use_chunked = span > _STREAM_CHUNK or not range_header

    if not use_chunked:
        def read_block() -> bytes:
            return mgr.read_file_range(info_hash, file_index, start, end, timeout=120.0)

        try:
            data = await loop.run_in_executor(None, read_block)
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        except TimeoutError as e:
            raise HTTPException(status_code=504, detail=str(e)) from e

        headers: dict[str, str] = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(len(data)),
        }
        headers["Content-Range"] = f"bytes {start}-{start + len(data) - 1}/{length}"
        return Response(
            content=data,
            status_code=206,
            headers=headers,
            media_type="application/octet-stream",
        )

    async def body_iter():
        pos = start
        while pos <= end:
            chunk_end = min(end, pos + _STREAM_CHUNK - 1)
            p, ce = pos, chunk_end

            def read_chunk(p0: int = p, p1: int = ce) -> bytes:
                return mgr.read_file_range(
                    info_hash, file_index, p0, p1, timeout=120.0
                )

            try:
                data = await loop.run_in_executor(None, read_chunk)
            except FileNotFoundError:
                logger.warning(
                    "stream abort hash=%s file=%s at=%s (missing file)",
                    info_hash[:8],
                    file_index,
                    pos,
                )
                break
            except TimeoutError:
                logger.warning(
                    "stream abort hash=%s file=%s at=%s (timeout)",
                    info_hash[:8],
                    file_index,
                    pos,
                )
                break
            if not data:
                break
            pos += len(data)
            yield data

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(span),
    }
    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{length}"
        status = 206
    else:
        status = 200
    return StreamingResponse(
        body_iter(),
        status_code=status,
        headers=headers,
        media_type="application/octet-stream",
    )
