const BTIH_IN_MAGNET = /[?&]xt=urn:btih:([a-z0-9]+)/i;

/** Accept magnet URI or bare info-hash (40 hex or 32 base32). */
export function normalizeMagnetInput(raw: string): string | null {
  const trimmed = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!trimmed) return null;
  if (/^magnet:\?/i.test(trimmed)) return trimmed;
  const hex40 = /^[a-f0-9]{40}$/i.test(trimmed);
  const b32 = /^[a-z2-7]{32}$/i.test(trimmed);
  if (hex40 || b32) {
    return `magnet:?xt=urn:btih:${trimmed.toLowerCase()}`;
  }
  return null;
}

export function isValidMagnetLink(magnet: string): boolean {
  if (!/^magnet:\?/i.test(magnet)) return false;
  const m = magnet.match(BTIH_IN_MAGNET);
  if (!m) return false;
  const hash = m[1]!;
  return hash.length === 40 || hash.length === 32;
}
