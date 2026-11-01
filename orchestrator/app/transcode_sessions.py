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
    ) -> None:
        self.work_dir = Path(work_dir)
        self.max_sessions = max(1, max_sessions)
        self.ttl_sec = max(30, ttl_sec)
        self.public_base_url = public_base_url.rstrip("/")
        self._sessions: dict[str, TranscodeSession] = {}
        self._lock = asyncio.Lock()

    def playback_url(self, session_id: str) -> str:
        return f"{self.public_base_url}/api/transcode/{session_id}/{PLAYLIST_NAME}"

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
    ) -> TranscodeSession:
        async with self._lock:
            self._purge_expired_unlocked()
            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError(
                    f"Достигнут лимит перекодирования ({self.max_sessions}). "
                    "Закройте другой просмотр или подождите."
                )

            session_id = str(uuid.uuid4())
            out_dir = self.work_dir / session_id
            if out_dir.exists():
                shutil.rmtree(out_dir, ignore_errors=True)

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
            )
            self._sessions[session_id] = session
            return session

    async def get(self, session_id: str) -> Optional[TranscodeSession]:
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.last_access = time.time()
            return session

    async def session_count(self) -> int:
        async with self._lock:
            self._purge_expired_unlocked()
            return len(self._sessions)

    async def stop(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if not session:
            return
        terminate_process(session.process)
        shutil.rmtree(session.out_dir, ignore_errors=True)

    def mark_playlist_complete_if_ffmpeg_done(self, session: TranscodeSession) -> None:
        proc = session.process
        if proc is not None and proc.returncode is not None:
            finalize_hls_playlist(session.out_dir)

    async def ensure_ffmpeg(self, session: TranscodeSession) -> None:
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
            async with self._lock:
                self._purge_expired_unlocked()

    def _purge_expired_unlocked(self) -> None:
        now = time.time()
        expired = [
            sid
            for sid, s in self._sessions.items()
            if now - s.last_access > self.ttl_sec
        ]
        for sid in expired:
            session = self._sessions.pop(sid, None)
            if session:
                terminate_process(session.process)
                shutil.rmtree(session.out_dir, ignore_errors=True)
                logger.info("transcode session expired: %s", sid)


async def wait_playlist_ready(session: TranscodeSession, timeout: float = 120.0) -> bool:
    return await wait_for_playlist(session.out_dir, timeout)
