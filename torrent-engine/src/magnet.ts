const BTIH_HEX = /btih:([a-f0-9]{40})/i;
const BTIH_B32 = /btih:([a-z2-7]{32})/i;

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "")) {
    const idx = B32_ALPHABET.indexOf(char.toUpperCase());
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function infoHashFromMagnet(link: string): string | null {
  const hex = BTIH_HEX.exec(link);
  if (hex) return hex[1]!.toLowerCase();

  const b32 = BTIH_B32.exec(link);
  if (!b32) return null;

  try {
    let encoded = b32[1]!.toUpperCase();
    encoded += "=".repeat((8 - (encoded.length % 8)) % 8);
    const raw = decodeBase32(encoded);
    return raw.toString("hex").toLowerCase();
  } catch {
    return null;
  }
}
