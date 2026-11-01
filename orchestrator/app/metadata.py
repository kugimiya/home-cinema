import re
from typing import Optional

QUALITY_PATTERNS = [
    (re.compile(r"\b2160p\b|\b4K\b|UHD", re.I), "2160p"),
    (re.compile(r"\b1080p\b|\b1080i\b", re.I), "1080p"),
    (re.compile(r"\b720p\b", re.I), "720p"),
    (re.compile(r"\b480p\b|DVDrip|DVDRip", re.I), "480p"),
]

VOICE_TAGS = [
    "LostFilm",
    "HDrezka",
    "TVShows",
    "MVO",
    "DUB",
    "DUBLYAZH",
    "Оригинал",
    "Sub",
    "ПМ",
    "ЛО",
    "ДБ",
    "D, P",
    "P2",
    "A",
]


def parse_quality(title: str, format_field: Optional[str] = None) -> Optional[str]:
    if format_field:
        ff = format_field.strip()
        if re.search(r"2160|4K|UHD", ff, re.I):
            return "2160p"
        if re.search(r"1080", ff, re.I):
            return "1080p"
        if re.search(r"720", ff, re.I):
            return "720p"
        return ff[:32] if ff else None
    for pattern, label in QUALITY_PATTERNS:
        if pattern.search(title):
            return label
    if re.search(r"WEB-DL|WEBRip|BDRip|BDRemux|HDRip|FilmScan", title, re.I):
        m = re.search(r"(WEB-DL|WEBRip|BDRip|BDRemux|HDRip|FilmScanRip)", title, re.I)
        if m:
            return m.group(1)
    return None


def parse_voice(title: str, language_field: Optional[str] = None) -> Optional[str]:
    if language_field and language_field.strip():
        return language_field.strip()[:120]
    found: list[str] = []
    lower = title.lower()
    for tag in VOICE_TAGS:
        if tag.lower() in lower or tag in title:
            found.append(tag)
    if re.search(r"многоголос|дублирован|любительск", title, re.I):
        found.append("multi/dub")
    return ", ".join(dict.fromkeys(found))[:120] if found else None
