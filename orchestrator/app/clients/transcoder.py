from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

import httpx

from app.media_paths import find_torrent_media_file
from app.playback_probe import PlaybackMode
from app.transcode_ffmpeg import PLAYLIST_NAME

logger = logging.getLogger(__name__)


class TranscoderClient:
    def __init__(self, base_url: str, torrents_save_path: str, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.torrents_save_path = torrents_save_path
        self.timeout = timeout

    def _source_path(self, info_hash: str, relative_path: str) -> Optional[str]:
        found = find_torrent_media_file(Path(self.torrents_save_path), relative_path)
        if found is not None:
            return str(found)
        legacy = Path(self.torrents_save_path) / info_hash.lower() / relative_path
        if legacy.is_file():
            return str(legacy)
        return None

    async def create_session(
        self,
        *,
        info_hash: str,
        file_index: int,
        relative_path: str,
        playback_mode: PlaybackMode,
        video_copy: bool,
        audio_copy: bool,
        audio_index: int,
        start_sec: float,
        video_height: Optional[int],
        source_url: str,
    ) -> dict[str, Any]:
        body = {
            "hash": info_hash.lower(),
            "file_index": file_index,
            "relative_path": relative_path,
            "playback_mode": playback_mode,
            "video_copy": video_copy,
            "audio_copy": audio_copy,
            "audio_index": audio_index,
            "start_sec": start_sec,
            "video_height": video_height,
            "source_path": self._source_path(info_hash, relative_path),
            "source_url": source_url,
        }
        logger.info(
            "transcoder create hash=%s file=%s url=%s",
            info_hash[:8],
            file_index,
            self.base_url,
        )
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(f"{self.base_url}/v1/sessions", json=body)
            if r.status_code >= 400:
                detail = r.text
                try:
                    payload = r.json()
                    if isinstance(payload, dict) and payload.get("detail"):
                        detail = str(payload["detail"])
                except Exception:
                    pass
                logger.error(
                    "transcoder create failed hash=%s status=%s detail=%s",
                    info_hash[:8],
                    r.status_code,
                    (detail or "")[:200],
                )
            r.raise_for_status()
            data = r.json()
            logger.info(
                "transcoder session ok hash=%s session_id=%s",
                info_hash[:8],
                data.get("session_id", "")[:8],
            )
            return data

    async def wait_playlist(
        self, session_id: str, out_dir: Path, timeout: float = 180.0
    ) -> bool:
        import asyncio
        import time

        playlist = out_dir / PLAYLIST_NAME
        deadline = time.monotonic() + timeout
        async with httpx.AsyncClient(timeout=10.0) as client:
            while time.monotonic() < deadline:
                try:
                    r = await client.get(
                        f"{self.base_url}/v1/sessions/{session_id}/status"
                    )
                    if r.status_code == 200:
                        st = r.json()
                        rc = st.get("ffmpeg_returncode")
                        if rc is not None and int(rc) != 0:
                            logger.error(
                                "transcoder ffmpeg failed session=%s code=%s",
                                session_id[:8],
                                rc,
                            )
                            return False
                        if st.get("playlist_ready"):
                            return True
                except httpx.HTTPError:
                    pass
                if playlist.is_file() and playlist.stat().st_size > 0:
                    return True
                await asyncio.sleep(0.5)
        return False

    async def stop_session(self, session_id: str) -> None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.delete(f"{self.base_url}/v1/sessions/{session_id}")
            if r.status_code not in (200, 404):
                r.raise_for_status()
