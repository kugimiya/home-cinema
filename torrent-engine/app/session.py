from __future__ import annotations

import logging
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import libtorrent as lt

from app.hash_util import sha1_to_hex
from app.magnet import info_hash_from_magnet
from app.modes import (
    PRIORITY_BACKGROUND,
    PRIORITY_OFF,
    PRIORITY_STREAM,
    TorrentMode,
    apply_mode_to_scope,
    file_download_priority,
)
from app.alerts import AlertRing, serialize_alert
from app.persistence import TorrentIndex
from app.session_settings import SessionConfiguration, build_session_configuration

logger = logging.getLogger(__name__)

_MAX_PIECE_SCAN = 8000


def _configure_alert_mask(session: lt.session) -> None:
    """libtorrent 1.x vs 2.x alert category names differ."""
    try:
        cat = lt.alert.category_t
        if hasattr(cat, "all_categories"):
            session.set_alert_mask(cat.all_categories)
            return
        mask = 0
        for name in (
            "status",
            "error",
            "storage",
            "status_notification",
            "error_notification",
            "storage_notification",
        ):
            if hasattr(cat, name):
                mask |= int(getattr(cat, name))
        if mask:
            session.set_alert_mask(mask)
    except Exception as e:
        logger.debug("set_alert_mask skipped: %s", e)


def _torrent_flag(name: str) -> int | None:
    torrent_flags = getattr(lt, "torrent_flags", None)
    if torrent_flags is None:
        return None
    return getattr(torrent_flags, name, None)


def _sequential_download_flag() -> int | None:
    return _torrent_flag("sequential_download")


def _apply_add_torrent_flags(params: lt.add_torrent_params) -> None:
    """Sequential piece picking; skip full-disk verify (streaming-first)."""
    for name in ("sequential_download", "no_verify_files"):
        flag = _torrent_flag(name)
        if flag is not None:
            params.flags = params.flags | flag


def _enable_sequential_download(
    *,
    params: lt.add_torrent_params | None = None,
    handle: lt.torrent_handle | None = None,
) -> None:
    """Always pick pieces in ascending index order (never rarest-first)."""
    flag = _sequential_download_flag()
    if params is not None and flag is not None:
        params.flags = params.flags | flag
    if handle is not None and handle.is_valid():
        try:
            handle.set_sequential_download(True)
        except Exception as e:
            logger.debug("set_sequential_download skipped: %s", e)


@dataclass
class TorrentState:
    title: str
    link: str
    mode: TorrentMode = TorrentMode.completing
    scope_file_ids: set[int] = field(default_factory=set)
    last_heartbeat: float = field(default_factory=time.time)


class TorrentSessionManager:
    def __init__(
        self,
        save_path: str,
        session_config: SessionConfiguration,
    ) -> None:
        self.save_path = Path(save_path)
        self.save_path.mkdir(parents=True, exist_ok=True)
        self._index = TorrentIndex(str(self.save_path))
        self._lock = threading.RLock()
        self._states: dict[str, TorrentState] = {}
        self._handles: dict[str, lt.torrent_handle] = {}
        self._alert_ring = AlertRing(400)
        self._session_config = session_config
        self._listen_port = session_config.listen_port
        lt_settings = dict(session_config.libtorrent)
        self._connections_limit = int(lt_settings.get("connections_limit") or 500)
        self._unchoke_slots_limit = int(lt_settings.get("unchoke_slots_limit") or 20)
        self._max_connections_per_torrent = session_config.max_connections_per_torrent
        self._max_upload_slots_per_torrent = session_config.max_upload_slots_per_torrent
        self._client_identity = {
            k: lt_settings[k]
            for k in ("user_agent", "peer_fingerprint", "handshake_client_version")
            if k in lt_settings
        }
        self._dht_bootstrap_nodes = str(lt_settings.get("dht_bootstrap_nodes") or "").strip()
        self._session_settings = {
            "enable_dht": bool(lt_settings.get("enable_dht", True)),
            "enable_lsd": bool(lt_settings.get("enable_lsd", True)),
            "enable_upnp": bool(lt_settings.get("enable_upnp", True)),
            "enable_natpmp": bool(lt_settings.get("enable_natpmp", True)),
            "unchoke_slots_limit": self._unchoke_slots_limit,
            "max_connections_per_torrent": self._max_connections_per_torrent,
            "max_upload_slots_per_torrent": self._max_upload_slots_per_torrent,
            "download_rate_limit": lt_settings.get("download_rate_limit"),
            "upload_rate_limit": lt_settings.get("upload_rate_limit"),
            "connection_speed": lt_settings.get("connection_speed"),
            "peer_turnover": lt_settings.get("peer_turnover"),
        }

        self._session = lt.session(lt_settings)
        _configure_alert_mask(self._session)
        logger.info(
            "session started save_path=%s listen_port=%s connections_limit=%s unchoke_slots=%s "
            "max_conn/torrent=%s max_upload_slots/torrent=%s user_agent=%r peer_fingerprint=%r",
            self.save_path,
            self._listen_port,
            self._connections_limit,
            self._unchoke_slots_limit,
            self._max_connections_per_torrent,
            self._max_upload_slots_per_torrent,
            self._client_identity.get("user_agent"),
            self._client_identity.get("peer_fingerprint"),
        )
        self._restore_persisted()

    def drain_alerts(self, limit: int = 100) -> list[dict[str, Any]]:
        self._collect_alerts()
        return self._alert_ring.list_recent(limit)

    def _collect_alerts(self) -> None:
        try:
            raw = self._session.pop_alerts()
        except Exception as e:
            logger.debug("pop_alerts skipped: %s", e)
            return
        if not raw:
            return
        batch = [serialize_alert(a) for a in raw]
        self._alert_ring.extend(batch)

    def session_status(self) -> dict[str, Any]:
        self._collect_alerts()
        now = time.time()
        with self._lock:
            total_dl = 0
            total_ul = 0
            active_dl = 0
            waiting_meta = 0
            seeding = 0
            for h in self._handles.values():
                if not h.is_valid():
                    continue
                st = h.status()
                total_dl += int(st.download_rate or 0)
                total_ul += int(st.upload_rate or 0)
                if st.download_rate and st.download_rate > 0:
                    active_dl += 1
                if not st.has_metadata:
                    waiting_meta += 1
                if st.is_seeding:
                    seeding += 1
            return {
                "save_path": str(self.save_path),
                "connections_limit": self._connections_limit,
                "listen": f"0.0.0.0:{self._listen_port}",
                **self._session_settings,
                "torrent_count": len(self._handles),
                "download_rate": total_dl,
                "upload_rate": total_ul,
                "active_downloads": active_dl,
                "waiting_metadata": waiting_meta,
                "seeding_count": seeding,
                "alert_buffer_size": self._alert_ring.size(),
                "user_agent": self._client_identity.get("user_agent"),
                "peer_fingerprint": self._client_identity.get("peer_fingerprint"),
                "handshake_client_version": self._client_identity.get(
                    "handshake_client_version"
                ),
                "dht_bootstrap_nodes": self._dht_bootstrap_nodes or None,
                "collected_at": now,
            }

    def _restore_persisted(self) -> None:
        for info_hash, link, title in self._index.all_entries():
            if not link:
                continue
            try:
                tf = self._torrent_file_path(info_hash)
                restore_link = str(tf) if tf.is_file() else link
                self._add_link_unlocked(restore_link, title, info_hash=info_hash)
                st = self._states.setdefault(
                    info_hash,
                    TorrentState(title=title, link=link, mode=TorrentMode.completing),
                )
                handle = self._handle_for(info_hash)
                if handle and handle.status().is_seeding:
                    st.mode = TorrentMode.seeding
                self._apply_priorities_unlocked(info_hash)
                logger.info("Restored torrent %s", info_hash[:8])
            except Exception as e:
                logger.warning("Restore failed %s: %s", info_hash[:8], e)

    def _handle_for(self, info_hash: str) -> Optional[lt.torrent_handle]:
        h = info_hash.lower()
        handle = self._handles.get(h)
        if handle is not None and handle.is_valid():
            return handle
        return None

    def _torrent_file_path(self, info_hash: str) -> Path:
        return self.save_path / ".engine" / "torrents" / f"{info_hash.lower()}.torrent"

    def _save_torrent_file_unlocked(self, info_hash: str, data: bytes) -> Path:
        path = self._torrent_file_path(info_hash)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def _params_from_torrent_bytes(self, data: bytes) -> lt.add_torrent_params:
        params: lt.add_torrent_params
        try:
            params = lt.read_torrent_buffer(data)
        except AttributeError:
            ti = lt.torrent_info(data)
            params = lt.add_torrent_params()
            params.ti = ti
        params.save_path = str(self.save_path)
        _apply_add_torrent_flags(params)
        return params

    def _apply_torrent_connection_limits(self, handle: lt.torrent_handle) -> None:
        if not handle.is_valid():
            return
        try:
            handle.set_max_connections(self._max_connections_per_torrent)
        except Exception as e:
            logger.debug("set_max_connections skipped: %s", e)
        try:
            handle.set_max_uploads(self._max_upload_slots_per_torrent)
        except Exception as e:
            logger.debug("set_max_uploads skipped: %s", e)

    def _drop_handle_unlocked(self, info_hash: str) -> None:
        h = info_hash.lower()
        handle = self._handles.pop(h, None)
        if handle and handle.is_valid():
            try:
                self._session.remove_torrent(handle)
            except Exception as e:
                logger.debug("remove_torrent %s: %s", h[:8], e)
        self._states.pop(h, None)

    def _add_link_unlocked(
        self, link: str, title: str, *, info_hash: Optional[str] = None
    ) -> str:
        stripped = link.strip()
        if stripped.startswith("magnet:"):
            params = lt.parse_magnet_uri(stripped)
        else:
            tf_path = Path(stripped)
            if not tf_path.is_file():
                raise FileNotFoundError(f"Torrent file not found: {stripped}")
            params = self._params_from_torrent_bytes(tf_path.read_bytes())
        params.save_path = str(self.save_path)
        _apply_add_torrent_flags(params)
        handle = self._session.add_torrent(params)
        _enable_sequential_download(handle=handle)
        self._apply_torrent_connection_limits(handle)
        ih = info_hash or sha1_to_hex(handle.info_hash())
        h = ih.lower()
        self._handles[h] = handle
        self._states.setdefault(h, TorrentState(title=title, link=link))
        self._index.remember(h, link=link, title=title)
        self._apply_priorities_unlocked(h)
        return h

    def add_torrent_bytes(
        self,
        data: bytes,
        title: str,
        *,
        magnet: str = "",
        save_to_db: bool = True,
        replace_without_metadata: bool = True,
    ) -> dict[str, Any]:
        with self._lock:
            params = self._params_from_torrent_bytes(data)
            ti = params.ti
            if ti is None:
                ti = lt.torrent_info(data)
            h = sha1_to_hex(ti.info_hash())
            existing = self._handle_for(h)
            if existing:
                if existing.status().has_metadata and not replace_without_metadata:
                    st = self._states[h]
                    return self._detail_unlocked(h, st)
                self._drop_handle_unlocked(h)
            _enable_sequential_download(params=params)
            handle = self._session.add_torrent(params)
            _enable_sequential_download(handle=handle)
            self._apply_torrent_connection_limits(handle)
            self._handles[h] = handle
            self._save_torrent_file_unlocked(h, data)
            link = magnet.strip() or str(self._torrent_file_path(h))
            self._states[h] = TorrentState(title=title, link=link)
            if save_to_db:
                self._index.remember(h, link=link, title=title)
            self._apply_priorities_unlocked(h)
            return self._detail_unlocked(h, self._states[h])

    def add_torrent(self, link: str, title: str, save_to_db: bool = True) -> dict[str, Any]:
        with self._lock:
            ih = info_hash_from_magnet(link) if link.startswith("magnet:") else None
            if ih and ih in self._handles:
                st = self._states[ih]
                return self._detail_unlocked(ih, st)
            h = self._add_link_unlocked(link, title, info_hash=ih)
            st = self._states[h]
            if save_to_db:
                self._index.remember(h, link=link, title=title)
            return self._detail_unlocked(h, st)

    def wait_metadata(self, info_hash: str, timeout: float = 120.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                handle = self._handle_for(info_hash)
                if handle and handle.status().has_metadata:
                    return True
            time.sleep(0.5)
        return False

    def _file_storage(self, handle: lt.torrent_handle) -> lt.file_storage:
        ti = handle.torrent_file()
        if ti is None:
            raise RuntimeError("No metadata yet")
        return ti.files()

    def _apply_priorities_unlocked(self, info_hash: str) -> None:
        handle = self._handle_for(info_hash)
        if not handle or not handle.status().has_metadata:
            return
        _enable_sequential_download(handle=handle)
        st = self._states.get(info_hash.lower())
        if not st:
            return
        active = apply_mode_to_scope(st.mode, st.scope_file_ids)
        fs = self._file_storage(handle)
        if st.mode == TorrentMode.seeding:
            # All priorities 0 pauses the torrent in libtorrent — keep files active to seed.
            for idx in range(fs.num_files()):
                handle.file_priority(idx, 7)
            handle.set_upload_mode(False)
        elif st.mode == TorrentMode.completing and not active:
            # Restored / idle multi-file torrents: empty scope must not pause all files (pri 0).
            for idx in range(fs.num_files()):
                handle.file_priority(idx, 1)
        else:
            for idx in range(fs.num_files()):
                file_idx = idx + 1  # 1-based file ids for orchestrator API
                pri = file_download_priority(file_idx, active)
                lt_pri = 0 if pri == PRIORITY_OFF else (1 if pri == PRIORITY_BACKGROUND else 7)
                handle.file_priority(idx, lt_pri)
        if st.mode == TorrentMode.paused:
            handle.pause()
        else:
            handle.resume()

    def set_scope(self, info_hash: str, file_ids: list[int]) -> None:
        h = info_hash.lower()
        with self._lock:
            st = self._states.setdefault(
                h, TorrentState(title=h, link="", mode=TorrentMode.streaming)
            )
            st.scope_file_ids = {int(i) for i in file_ids if int(i) > 0}
            if st.mode == TorrentMode.paused:
                st.mode = TorrentMode.streaming
            logger.info(
                "scope hash=%s mode=%s active_files=%s",
                h[:8],
                st.mode.value,
                sorted(st.scope_file_ids),
            )
            self._apply_priorities_unlocked(h)

    def set_mode(self, info_hash: str, mode: TorrentMode) -> None:
        h = info_hash.lower()
        with self._lock:
            st = self._states.setdefault(
                h, TorrentState(title=h, link="", mode=mode)
            )
            st.mode = mode
            if mode == TorrentMode.completing and not st.scope_file_ids:
                handle = self._handle_for(h)
                if handle and handle.status().has_metadata:
                    fs = self._file_storage(handle)
                    st.scope_file_ids = {1} if fs.num_files() == 1 else st.scope_file_ids
            logger.info(
                "mode hash=%s -> %s scope=%s",
                h[:8],
                mode.value,
                sorted(st.scope_file_ids),
            )
            self._apply_priorities_unlocked(h)

    def heartbeat(self, info_hash: str, file_ids: list[int], stream_active: bool) -> None:
        h = info_hash.lower()
        with self._lock:
            st = self._states.setdefault(
                h, TorrentState(title=h, link="", mode=TorrentMode.streaming)
            )
            st.last_heartbeat = time.time()
            if file_ids:
                st.scope_file_ids = {int(i) for i in file_ids if int(i) > 0}
            if stream_active:
                st.mode = TorrentMode.streaming
            self._apply_priorities_unlocked(h)

    def tick_modes(self) -> None:
        """Promote completing→seeding when progress complete."""
        self._collect_alerts()
        with self._lock:
            for h, st in list(self._states.items()):
                handle = self._handle_for(h)
                if not handle:
                    continue
                status = handle.status()
                if status.is_seeding and st.mode == TorrentMode.completing:
                    st.mode = TorrentMode.seeding
                    self._apply_priorities_unlocked(h)

    def remove_torrent(self, info_hash: str) -> None:
        h = info_hash.lower()
        with self._lock:
            handle = self._handle_for(h)
            if handle:
                try:
                    self._session.remove_torrent(handle, lt.delete_files)
                except (AttributeError, TypeError):
                    self._session.remove_torrent(handle)
            self._handles.pop(h, None)
            self._states.pop(h, None)
            self._index.remove(h)
        torrent_dir = self.save_path / h
        if torrent_dir.is_dir():
            shutil.rmtree(torrent_dir, ignore_errors=True)

    def _resolve_file_path(self, info_hash: str, file_index: int) -> tuple[Path, int]:
        handle = self._handle_for(info_hash)
        if not handle or not handle.status().has_metadata:
            raise FileNotFoundError("Torrent or metadata missing")
        fs = self._file_storage(handle)
        idx = file_index - 1
        if idx < 0 or idx >= fs.num_files():
            raise FileNotFoundError("File index out of range")
        rel = fs.file_path(idx)
        length = fs.file_size(idx)
        base = Path(handle.save_path()) / handle.name()
        path = base / rel
        if not path.is_file():
            alt = self.save_path / info_hash.lower() / rel
            if alt.is_file():
                path = alt
        return path, length

    def read_file_range(
        self, info_hash: str, file_index: int, start: int, end: int, timeout: float = 60.0
    ) -> bytes:
        """Read byte range, waiting for pieces while in downloading state."""
        t0 = time.time()
        deadline = t0 + timeout
        last_log = t0
        want_total = max(0, end - start + 1)
        logger.debug(
            "read_range hash=%s file=%s bytes=%s-%s want=%s",
            info_hash[:8],
            file_index,
            start,
            end,
            want_total,
        )
        while time.time() < deadline:
            with self._lock:
                handle = self._handle_for(info_hash)
                if not handle:
                    raise FileNotFoundError("Torrent missing")
                path, length = self._resolve_file_path(info_hash, file_index)
                end_clamped = min(end, length - 1) if length else end
                if start >= length:
                    return b""
                self._prioritize_byte_range(handle, file_index, start, end_clamped)
                status = handle.status()
            if path.is_file():
                size = path.stat().st_size
                if size > start:
                    with path.open("rb") as f:
                        f.seek(start)
                        want = end_clamped - start + 1
                        data = f.read(want)
                    if len(data) >= want or status.is_seeding:
                        logger.info(
                            "read_range ok hash=%s file=%s got=%s/%s path=%s elapsed=%.1fs",
                            info_hash[:8],
                            file_index,
                            len(data),
                            want,
                            path.name,
                            time.time() - t0,
                        )
                        return data
                    now = time.time()
                    if now - last_log >= 5.0:
                        last_log = now
                        logger.info(
                            "read_range wait hash=%s file=%s disk=%s need_end=%s "
                            "progress=%.1f%% peers=%s dl=%s B/s",
                            info_hash[:8],
                            file_index,
                            size,
                            end_clamped + 1,
                            (size / length * 100.0) if length else 0.0,
                            status.num_peers,
                            status.download_rate,
                        )
            time.sleep(0.25)
        logger.warning(
            "read_range timeout hash=%s file=%s bytes=%s-%s after=%.1fs",
            info_hash[:8],
            file_index,
            start,
            end,
            timeout,
        )
        raise TimeoutError("Timed out waiting for torrent pieces")

    def _prioritize_byte_range(
        self, handle: lt.torrent_handle, file_index: int, start: int, end: int
    ) -> None:
        if not handle.status().has_metadata:
            return
        ti = handle.torrent_file()
        if ti is None:
            return
        fs = ti.files()
        idx = file_index - 1
        file_offset = fs.file_offset(idx)
        piece_length = ti.piece_length()
        first_piece = (file_offset + start) // piece_length
        last_piece = (file_offset + end) // piece_length
        # Stagger deadlines so time-critical picker completes pieces in order.
        ms_per_piece = max(1, piece_length // 1024)
        for i, p in enumerate(range(first_piece, last_piece + 1)):
            handle.piece_priority(p, 7)
            handle.set_piece_deadline(p, i * ms_per_piece)

    def list_torrents(self) -> list[dict[str, Any]]:
        with self._lock:
            out = []
            for h, st in self._states.items():
                detail = self._detail_unlocked(h, st)
                if detail:
                    out.append(detail)
            return out

    def get_torrent(self, info_hash: str) -> dict[str, Any]:
        h = info_hash.lower()
        with self._lock:
            st = self._states.get(h)
            if not st:
                return {}
            return self._detail_unlocked(h, st)

    def _detail_unlocked(self, info_hash: str, st: TorrentState) -> dict[str, Any]:
        handle = self._handle_for(info_hash)
        if not handle:
            return {}
        status = handle.status()
        files: list[dict[str, Any]] = []
        torrent_size = 0
        loaded_size = 0
        if status.has_metadata:
            fs = self._file_storage(handle)
            progress = _file_progress_fractions(handle, fs.num_files())
            active = apply_mode_to_scope(st.mode, st.scope_file_ids)
            completing_all = st.mode == TorrentMode.completing and not active
            for idx in range(fs.num_files()):
                file_idx = idx + 1
                length = fs.file_size(idx)
                torrent_size += length
                frac = progress[idx] if idx < len(progress) else 0.0
                downloaded = int(float(frac) * length)
                downloaded = min(downloaded, length)
                loaded_size += downloaded
                if st.mode == TorrentMode.seeding:
                    pri = PRIORITY_STREAM
                elif completing_all:
                    pri = PRIORITY_BACKGROUND
                else:
                    pri = file_download_priority(file_idx, active)
                files.append(
                    {
                        "id": file_idx,
                        "path": fs.file_path(idx),
                        "length": length,
                        "downloaded_bytes": downloaded,
                        "completed": length > 0 and downloaded >= length * 0.995,
                        "priority": pri,
                    }
                )
        try:
            total_wanted = int(status.total_wanted)
            if total_wanted > 0:
                torrent_size = total_wanted
        except (AttributeError, TypeError, ValueError):
            pass
        try:
            total_done = int(status.total_done)
            if total_done > 0:
                loaded_size = total_done
        except (AttributeError, TypeError, ValueError):
            pass
        num_seeds = 0
        for attr in ("num_seeds", "num_complete_seeds", "list_seeds"):
            val = getattr(status, attr, None)
            if val is not None:
                try:
                    num_seeds = int(val)
                    break
                except (TypeError, ValueError):
                    continue
        progress = float(getattr(status, "progress", 0.0) or 0.0)
        num_connections = getattr(status, "num_connections", None)
        if num_connections is None:
            num_connections = status.num_peers
        all_time_download = int(getattr(status, "all_time_download", 0) or 0)
        error_msg: str | None = None
        if hasattr(status, "error"):
            try:
                err = status.error
                if err:
                    error_msg = str(err)
            except Exception:
                pass
        is_paused = bool(getattr(status, "paused", False))
        if not is_paused and hasattr(status, "flags"):
            try:
                tf = getattr(lt, "torrent_flags", None)
                if tf is not None and hasattr(tf, "paused"):
                    is_paused = bool(int(status.flags) & int(tf.paused))
            except Exception:
                pass
        pieces_total: int | None = None
        pieces_have: int | None = None
        piece_length: int | None = None
        if status.has_metadata:
            try:
                ti = handle.torrent_file()
                if ti is not None:
                    pieces_total = int(ti.num_pieces())
                    piece_length = int(ti.piece_length())
                    if pieces_total <= _MAX_PIECE_SCAN:
                        pieces_have = sum(
                            1 for i in range(pieces_total) if handle.have_piece(i)
                        )
                    elif pieces_total > 0:
                        pieces_have = int(progress * pieces_total)
            except Exception:
                pass
        hb_age = max(0.0, time.time() - st.last_heartbeat)
        return {
            "hash": info_hash.lower(),
            "title": st.title,
            "stat_string": status.state.name if hasattr(status.state, "name") else str(status.state),
            "torrent_size": torrent_size,
            "loaded_size": loaded_size,
            "download_speed": status.download_rate,
            "upload_speed": status.upload_rate,
            "total_peers": status.num_peers,
            "bytes_written_data": status.all_time_upload,
            "connected_seeders": num_seeds,
            "mode": st.mode.value,
            "file_stats": files,
            "has_metadata": bool(status.has_metadata),
            "is_seeding": bool(status.is_seeding),
            "is_finished": bool(getattr(status, "is_finished", False)),
            "is_paused": is_paused,
            "progress": progress,
            "num_connections": int(num_connections or 0),
            "all_time_download": all_time_download,
            "error": error_msg,
            "save_path": str(handle.save_path()),
            "torrent_name": handle.name(),
            "scope_file_ids": sorted(st.scope_file_ids),
            "last_heartbeat_age_sec": round(hb_age, 1),
            "sequential_download": True,
            "pieces_total": pieces_total,
            "pieces_have": pieces_have,
            "piece_length": piece_length,
        }


def _file_progress_fractions(handle: lt.torrent_handle, num_files: int) -> list[float]:
    try:
        raw = handle.file_progress()
    except Exception:
        return [0.0] * num_files
    if raw is None:
        return [0.0] * num_files
    if isinstance(raw, (list, tuple)):
        return [float(x) for x in raw]
    # Some bindings expose a vector-like object
    try:
        return [float(raw[i]) for i in range(min(num_files, len(raw)))]
    except (TypeError, IndexError):
        return [0.0] * num_files


_manager: Optional[TorrentSessionManager] = None


def get_manager() -> TorrentSessionManager:
    global _manager
    if _manager is None:
        from app.config import settings

        session_cfg = build_session_configuration(settings)
        _manager = TorrentSessionManager(settings.save_path, session_cfg)
    return _manager
