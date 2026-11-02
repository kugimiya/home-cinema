from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from pathlib import Path

from app.config import settings
from app.ffmpeg_builder import PLAYLIST_NAME
from app.media_paths import find_torrent_media_file
from app.sessions import SessionManager

logger = logging.getLogger(__name__)

app = FastAPI(title="home-cinema transcoder")
mgr = SessionManager(settings.work_dir, settings.max_sessions)

PlaybackMode = Literal["direct", "hls_transcode", "hls_remux"]


class CreateSessionBody(BaseModel):
    hash: str
    file_index: int
    relative_path: str = ""
    video_height: Optional[int] = None
    audio_index: int = 0
    start_sec: float = 0.0
    playback_mode: PlaybackMode = "hls_transcode"
    video_copy: bool = False
    audio_copy: bool = False
    source_path: Optional[str] = None
    source_url: Optional[str] = None


class CreateSessionResponse(BaseModel):
    session_id: str
    out_dir: str


def _resolve_source_path(body: CreateSessionBody) -> tuple[str | None, str | None]:
    if body.source_path and Path(body.source_path).is_file():
        return body.source_path, body.source_url
    if body.relative_path:
        found = find_torrent_media_file(
            Path(settings.torrents_path), body.relative_path
        )
        if found is not None:
            return str(found), body.source_url
        legacy = Path(settings.torrents_path) / body.hash.lower() / body.relative_path
        if legacy.is_file():
            return str(legacy), body.source_url
    return None, body.source_url


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/sessions", response_model=CreateSessionResponse)
async def create_session(body: CreateSessionBody) -> CreateSessionResponse:
    path, url = _resolve_source_path(body)
    if not path and not url:
        url = (
            f"{settings.torrent_engine_url.rstrip('/')}/v1/torrents/"
            f"{body.hash.lower()}/files/{body.file_index}/stream"
        )
    logger.info(
        "create session hash=%s file=%s mode=%s source_path=%s source_url=%s",
        body.hash[:8],
        body.file_index,
        body.playback_mode,
        bool(path),
        bool(url),
    )
    try:
        session = await mgr.create(
            source_path=path,
            source_url=url,
            playback_mode=body.playback_mode,
            video_copy=body.video_copy,
            audio_copy=body.audio_copy,
            audio_ordinal=body.audio_index,
            start_sec=body.start_sec,
            video_height=body.video_height,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    logger.info("session started id=%s out_dir=%s", session.session_id, session.out_dir)
    return CreateSessionResponse(session_id=session.session_id, out_dir=str(session.out_dir))


@app.get("/v1/sessions/{session_id}/status")
async def session_status(session_id: str) -> dict[str, object]:
    session = mgr.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    proc = session.process
    playlist = session.out_dir / PLAYLIST_NAME
    return {
        "session_id": session_id,
        "ffmpeg_running": proc is not None and proc.returncode is None,
        "ffmpeg_returncode": proc.returncode if proc is not None else None,
        "playlist_ready": playlist.is_file() and playlist.stat().st_size > 0,
    }


@app.delete("/v1/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, str]:
    await mgr.stop(session_id)
    return {"status": "stopped"}


@app.get("/v1/sessions/{session_id}/{filename}")
async def get_file(session_id: str, filename: str):
    try:
        path = mgr.resolve_file(session_id, filename)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    media = "application/vnd.apple.mpegurl" if filename.endswith(".m3u8") else "video/mp4"
    return FileResponse(path, media_type=media)
