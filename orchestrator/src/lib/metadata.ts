const QUALITY_PATTERNS: Array<[RegExp, string]> = [
  [/\b2160p\b|\b4K\b|UHD/i, "2160p"],
  [/\b1080p\b|\b1080i\b/i, "1080p"],
  [/\b720p\b/i, "720p"],
  [/\b480p\b|DVDrip|DVDRip/i, "480p"],
];

const VOICE_TAGS = [
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
];

export function parseQuality(title: string, formatField?: string | null): string | null {
  if (formatField?.trim()) {
    const ff = formatField.trim();
    if (/2160|4K|UHD/i.test(ff)) return "2160p";
    if (/1080/i.test(ff)) return "1080p";
    if (/720/i.test(ff)) return "720p";
    return ff.slice(0, 32) || null;
  }
  for (const [pattern, label] of QUALITY_PATTERNS) {
    if (pattern.test(title)) return label;
  }
  if (/WEB-DL|WEBRip|BDRip|BDRemux|HDRip|FilmScan/i.test(title)) {
    const m = title.match(/(WEB-DL|WEBRip|BDRip|BDRemux|HDRip|FilmScanRip)/i);
    if (m) return m[1]!;
  }
  return null;
}

export function parseVoice(title: string, languageField?: string | null): string | null {
  if (languageField?.trim()) return languageField.trim().slice(0, 120);
  const found: string[] = [];
  const lower = title.toLowerCase();
  for (const tag of VOICE_TAGS) {
    if (lower.includes(tag.toLowerCase()) || title.includes(tag)) found.push(tag);
  }
  if (/многоголос|дублирован|любительск/i.test(title)) found.push("multi/dub");
  if (found.length === 0) return null;
  return [...new Set(found)].join(", ").slice(0, 120);
}
