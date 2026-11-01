from __future__ import annotations

from typing import Any


def _file_id(entry: dict[str, Any]) -> int:
    return int(entry.get("id") or entry.get("Id") or 0)


def _file_length(entry: dict[str, Any]) -> int:
    return int(entry.get("length") or entry.get("Length") or 0)


def progress_from_cache(
    files: list[dict[str, Any]], cache: dict[str, Any] | None
) -> dict[int, dict[str, int]]:
    """Map TorrServer cache pieces to per-file downloaded bytes and priority."""
    if not files:
        return {}

    sorted_files = sorted(files, key=_file_id)
    spans: list[tuple[int, int, int]] = []
    start = 0
    for f in sorted_files:
        fid = _file_id(f)
        length = _file_length(f)
        spans.append((fid, start, start + length))
        start += length

    result: dict[int, dict[str, int]] = {
        _file_id(f): {"downloaded": 0, "priority": 0} for f in sorted_files
    }
    if not cache:
        return result

    piece_len = int(cache.get("PiecesLength") or cache.get("piecesLength") or 0)
    pieces = cache.get("Pieces") or cache.get("pieces") or {}
    if not piece_len or not isinstance(pieces, dict):
        return result

    def file_for_offset(offset: int) -> int | None:
        for fid, begin, end in spans:
            if begin <= offset < end:
                return fid
        return None

    for key, piece in pieces.items():
        if not isinstance(piece, dict):
            continue
        try:
            piece_index = int(key)
        except (TypeError, ValueError):
            continue
        offset = piece_index * piece_len
        fid = file_for_offset(offset)
        if fid is None:
            continue
        completed = bool(piece.get("Completed") or piece.get("completed"))
        if completed:
            size = int(piece.get("Length") or piece.get("length") or piece_len)
        else:
            size = int(piece.get("Size") or piece.get("size") or 0)
        result[fid]["downloaded"] += size
        pri = int(piece.get("Priority") or piece.get("priority") or 0)
        if pri > result[fid]["priority"]:
            result[fid]["priority"] = pri

    return result


def upload_bytes_per_file(
    progress: dict[int, dict[str, int]],
    bytes_written_data: int | None,
) -> dict[int, int]:
    """Estimate per-file upload from torrent totals (TorrServer has no per-file upload API)."""
    total_upload = max(0, int(bytes_written_data or 0))
    file_ids = list(progress.keys())
    if total_upload == 0 or not file_ids:
        return dict.fromkeys(file_ids, 0)

    def weight(fid: int, *, active_only: bool) -> int:
        prog = progress.get(fid, {})
        downloaded = int(prog.get("downloaded") or 0)
        if downloaded <= 0:
            return 0
        if active_only and int(prog.get("priority") or 0) < 1:
            return 0
        return downloaded

    weights = {fid: weight(fid, active_only=True) for fid in file_ids}
    weight_sum = sum(weights.values())
    if weight_sum <= 0:
        weights = {fid: weight(fid, active_only=False) for fid in file_ids}
        weight_sum = sum(weights.values())
    if weight_sum <= 0:
        return dict.fromkeys(file_ids, 0)

    shares: dict[int, int] = {}
    assigned = 0
    ordered = sorted(file_ids, key=lambda i: weights[i], reverse=True)
    for idx, fid in enumerate(ordered):
        if idx == len(ordered) - 1:
            shares[fid] = max(0, total_upload - assigned)
        else:
            part = int(total_upload * weights[fid] / weight_sum)
            shares[fid] = part
            assigned += part
    return shares
