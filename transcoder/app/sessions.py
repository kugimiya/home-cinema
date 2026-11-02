from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional

from app.ffmpeg_builder import PLAYLIST_NAME, build_ffmpeg_command

logger = logging.getLogger(__name__)

PlaybackMode = Literal["direct", "hls_transcode", "hls_remux"]


@dataclass
class TranscodeSession:
    session_id: str
    source: str
    out_dir: Path
    playback_mode: PlaybackMode
    process: Optional[asyncio.subprocess.Process] = None
    created_at: float = field(default_factory=time.time)


class SessionManager:
    def __init__(self, work_dir: str, max_sessions: int) -> None:
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.max_sessions = max(1, max_sessions)
        self._sessions: dict[str, TranscodeSession] = {}
        self._lock = asyncio.Lock()

    async def create(
        self,
        *,
        source_path: str | None,
        source_url: str | None,
        playback_mode: PlaybackMode,
        video_copy: bool,
        audio_copy: bool,
        audio_ordinal: int,
        start_sec: float,
        video_height: int | None,
    ) -> TranscodeSession:
        source = source_path if source_path and Path(source_path).is_file() else source_url
        if not source:
            raise FileNotFoundError("No valid source_path or source_url")

        async with self._lock:
            self._purge_finished_unlocked()
            while len(self._sessions) >= self.max_sessions:
                if not self._evict_oldest_unlocked():
                    raise RuntimeError(
                        "max sessions reached — закройте другой просмотр или подождите"
                    )
            session_id = str(uuid.uuid4())
            out_dir = self.work_dir / session_id
            cmd = build_ffmpeg_command(
                source,
                out_dir,
                playback_mode=playback_mode,
                video_copy=video_copy,
                audio_copy=audio_copy,
                audio_ordinal=audio_ordinal,
                start_sec=start_sec,
                video_height=video_height,
            )
            log_path = out_dir / "ffmpeg.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_file = open(log_path, "wb")  # noqa: SIM115
            logger.info("ffmpeg start session=%s source=%s", session_id[:8], source[:120])
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=log_file,
                start_new_session=True,
            )
            session = TranscodeSession(
                session_id=session_id,
                source=source,
                out_dir=out_dir,
                playback_mode=playback_mode,
                process=proc,
            )
            self._sessions[session_id] = session
            asyncio.create_task(self._log_ffmpeg_exit(session_id, proc))
            return session

    async def _log_ffmpeg_exit(
        self, session_id: str, proc: asyncio.subprocess.Process
    ) -> None:
        try:
            code = await proc.wait()
        except Exception as e:
            logger.warning("ffmpeg wait failed session=%s: %s", session_id[:8], e)
            return
        if code != 0:
            logger.error("ffmpeg exit session=%s code=%s", session_id[:8], code)
        else:
            logger.info("ffmpeg finished session=%s", session_id[:8])

    def _purge_finished_unlocked(self) -> None:
        dead = [
            sid
            for sid, s in self._sessions.items()
            if s.process is None or s.process.returncode is not None
        ]
        for sid in dead:
            self._sessions.pop(sid, None)
            logger.info("transcoder purged finished session=%s", sid[:8])

    def _evict_oldest_unlocked(self) -> bool:
        if not self._sessions:
            return False
        oldest = min(self._sessions.values(), key=lambda s: s.created_at)
        sid = oldest.session_id
        self._sessions.pop(sid, None)
        proc = oldest.process
        if proc is not None and proc.returncode is None:
            try:
                os.kill(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        logger.info("transcoder evicted oldest session=%s", sid[:8])
        return True

    async def stop(self, session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if session and session.process and session.process.returncode is None:
            try:
                os.kill(session.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def get(self, session_id: str) -> TranscodeSession | None:
        return self._sessions.get(session_id)

    def resolve_file(self, session_id: str, filename: str) -> Path:
        if (
            filename != PLAYLIST_NAME
            and not filename.endswith(".m4s")
            and filename != "init.mp4"
        ):
            raise FileNotFoundError("invalid segment")
        session = self._sessions.get(session_id)
        if not session:
            raise FileNotFoundError("session not found")
        path = session.out_dir / filename
        if not path.is_file():
            raise FileNotFoundError("file not ready")
        return path

    async def wait_playlist(self, session_id: str, timeout: float = 120.0) -> bool:
        session = self._sessions.get(session_id)
        if not session:
            return False
        playlist = session.out_dir / PLAYLIST_NAME
        deadline = time.time() + timeout
        while time.time() < deadline:
            if playlist.is_file() and playlist.stat().st_size > 0:
                return True
            await asyncio.sleep(0.25)
        return False
