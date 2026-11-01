from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ProbeLiveStats:
    bytes_downloaded: int = 0
    bytes_target: int = 0
    download_speed: float | None = None
    total_peers: int | None = None
    subphase: str = ""
    elapsed_sec: int = 0

_SUBPHASE_LABEL: dict[str, str] = {
    "cache": "результат ffprobe из кэша",
    "prefetch_head": "подгрузка начала файла для ffprobe",
    "analyze_head": "ffprobe по сохранённой голове файла",
    "analyze_stream": "ffprobe читает поток TorrServer",
    "retry_wait": "пауза перед повтором ffprobe",
}


def _fmt_bytes(n: int) -> str:
    if n <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB"]
    v = float(n)
    i = 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    if i == 0:
        return f"{int(v)} {units[i]}"
    return f"{v:.1f} {units[i]}"


def format_probe_status_message(
    stats: ProbeLiveStats,
    *,
    step: int,
    step_total: int,
    attempt: int,
    attempt_max: int,
) -> str:
    phase = _SUBPHASE_LABEL.get(stats.subphase, stats.subphase or "ffprobe")
    head = f"Этап {step} из {step_total}: {phase}"
    if stats.subphase == "cache":
        return f"{head}."
    if stats.subphase == "retry_wait":
        return f"{head} (попытка {attempt} из {attempt_max} не удалась)."

    parts: list[str] = [head]
    if stats.subphase in ("prefetch_head", "analyze_head", "analyze_stream"):
        parts.append(f"Попытка {attempt} из {attempt_max}.")
    if stats.bytes_target > 0:
        parts.append(
            f"С начала файла: {_fmt_bytes(stats.bytes_downloaded)} / {_fmt_bytes(stats.bytes_target)}."
        )
    if stats.download_speed is not None and stats.download_speed > 0:
        parts.append(f"Скорость: {_fmt_bytes(int(stats.download_speed))}/s.")
    elif stats.subphase == "prefetch_head":
        parts.append("Скорость: 0 — ждём данные с пиров или диска.")
    if stats.total_peers is not None:
        parts.append(f"Пиры: {stats.total_peers}.")
    if stats.elapsed_sec > 0 and stats.subphase == "analyze_stream":
        parts.append(f"ffprobe: {stats.elapsed_sec} с.")
    return " ".join(parts)
