from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from app.playback_probe import PlaybackMode, ProbeResult
from app.transcode_ffmpeg import (
    PLAYLIST_NAME,
    build_ffmpeg_command,
    finalize_hls_playlist,
    spawn_ffmpeg,
    terminate_process,
    wait_for_playlist,
)

if False:  # type checking hook
    from app.clients.transcoder import TranscoderClient

logger = logging.getLogger(__name__)

SAFE_FILENAME = re.compile(r"^[a-zA-Z0-9._-]+$")


@dataclass
class TranscodeSession:
    session_id: str
    info_hash: str
    file_index: int
    file_path: str
    source_url: str
    playback_mode: PlaybackMode
    video_copy: bool
    audio_copy: bool
    audio_ordinal: int
    start_sec: float
    out_dir: Path
    video_height: int | None = None
    remote_session: bool = False
    process: Optional[asyncio.subprocess.Process] = None
    created_at: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)
    ffmpeg_started: bool = False


class TranscodeSessionManager:
    def __init__(
        self,
        work_dir: str,
        max_sessions: int,
        ttl_sec: int,
        public_base_url: str,
        *,
        transcoder: "TranscoderClient | None" = None,
    ) -> None:
        self.work_dir = Path(work_dir)
        self.max_sessions = max(1, max_sessions)
        self.ttl_sec = max(30, ttl_sec)
        self.public_base_url = public_base_url.rstrip("/")
        self._transcoder = transcoder
        self._sessions: dict[str, TranscodeSession] = {}
        self._lock = asyncio.Lock()

    def playback_url(self, session_id: str) -> str:
        # Path-only URL so the browser uses the same host as the UI (localhost vs LAN IP).
        return f"/api/transcode/{session_id}/{PLAYLIST_NAME}"

    async def create_session(
        self,
        *,
        info_hash: str,
        file_index: int,
        file_path: str,
        source_url: str,
        probe: ProbeResult,
        audio_ordinal: int,
        start_sec: float = 0.0,
        video_height: int | None = None,
        relative_path: str = "",
    ) -> TranscodeSession:
        await self._purge_expired()
        async with self._lock:
            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError(
                    f"Достигнут лимит перекодирования ({self.max_sessions} одновременных потоков). "
                    "Закройте плеер на другом устройстве, подождите ~минуту или увеличьте "
                    "TRANSCODE_MAX_SESSIONS в .env и перезапустите orchestrator/transcoder."
                )

            session_id = str(uuid.uuid4())
            out_dir = self.work_dir / session_id
            if out_dir.exists():
                shutil.rmtree(out_dir, ignore_errors=True)
            local_session = TranscodeSession(
                session_id=session_id,
                info_hash=info_hash.lower(),
                file_index=file_index,
                file_path=file_path,
                source_url=source_url,
                playback_mode=probe.playback_mode,
                video_copy=probe.video_copy,
                audio_copy=probe.audio_copy,
                audio_ordinal=max(0, audio_ordinal),
                start_sec=max(0.0, start_sec),
                out_dir=out_dir,
                video_height=video_height,
            )
            use_remote = self._transcoder is not None

        if use_remote:
            remote = await self._transcoder.create_session(
                info_hash=info_hash.lower(),
                file_index=file_index,
                relative_path=relative_path or file_path,
                playback_mode=probe.playback_mode,
                video_copy=probe.video_copy,
                audio_copy=probe.audio_copy,
                audio_index=max(0, audio_ordinal),
                start_sec=max(0.0, start_sec),
                video_height=video_height,
                source_url=source_url,
            )
            session_id = remote["session_id"]
            out_dir = Path(remote.get("out_dir") or (self.work_dir / session_id))
            session = TranscodeSession(
                session_id=session_id,
                info_hash=info_hash.lower(),
                file_index=file_index,
                file_path=file_path,
                source_url=source_url,
                playback_mode=probe.playback_mode,
                video_copy=probe.video_copy,
                audio_copy=probe.audio_copy,
                audio_ordinal=max(0, audio_ordinal),
                start_sec=max(0.0, start_sec),
                out_dir=out_dir,
                video_height=video_height,
                remote_session=True,
                ffmpeg_started=True,
            )
        else:
            session = local_session

        async with self._lock:
            self._sessions[session_id] = session
            return session

    async def get(self, session_id: str) -> Optional[TranscodeSession]:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.last_access = time.time()
            return session

    async def session_count(self) -> int:
        await self._purge_expired()
        async with self._lock:
            return len(self._sessions)

    async def stop(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if not session:
            return
        if session.remote_session and self._transcoder is not None:
            await self._transcoder.stop_session(session_id)
        terminate_process(session.process)
        if not session.remote_session:
            shutil.rmtree(session.out_dir, ignore_errors=True)

    def mark_playlist_complete_if_ffmpeg_done(self, session: TranscodeSession) -> None:
        proc = session.process
        if proc is not None and proc.returncode is not None:
            finalize_hls_playlist(session.out_dir)

    async def ensure_ffmpeg(self, session: TranscodeSession) -> None:
        if session.remote_session and session.ffmpeg_started:
            session.last_access = time.time()
            return
        if session.ffmpeg_started and session.process and session.process.returncode is None:
            session.last_access = time.time()
            return
        if session.ffmpeg_started and session.process and session.process.returncode is not None:
            self.mark_playlist_complete_if_ffmpeg_done(session)
            session.last_access = time.time()
            return

        cmd = build_ffmpeg_command(
            session.source_url,
            session.out_dir,
            playback_mode=session.playback_mode,
            video_copy=session.video_copy,
            audio_copy=session.audio_copy,
            audio_ordinal=session.audio_ordinal,
            start_sec=session.start_sec,
        )
        session.process = await spawn_ffmpeg(cmd)
        session.ffmpeg_started = True
        session.last_access = time.time()

    def resolve_file(self, session: TranscodeSession, filename: str) -> Path:
        if not SAFE_FILENAME.match(filename):
            raise ValueError("Invalid segment name")
        root = session.out_dir.resolve()
        path = (root / filename).resolve()
        if root not in path.parents:
            raise ValueError("Path traversal")
        if not path.is_file():
            raise FileNotFoundError(filename)
        return path

    async def cleanup_loop(self, interval: float = 30.0) -> None:
        while True:
            await asyncio.sleep(interval)
            await self._purge_expired()

    async def _purge_expired(self) -> None:
        async with self._lock:
            now = time.time()
            expired = [
                sid
                for sid, s in self._sessions.items()
                if now - s.last_access > self.ttl_sec
            ]
        for sid in expired:
            await self.stop(sid)
            logger.info("transcode session expired: %s", sid)


async def wait_playlist_ready(
    session: TranscodeSession,
    timeout: float = 120.0,
    *,
    transcoder: "TranscoderClient | None" = None,
) -> bool:
    if session.remote_session and transcoder is not None:
        return await transcoder.wait_playlist(session.session_id, session.out_dir, timeout)
    return await wait_for_playlist(session.out_dir, timeout)
