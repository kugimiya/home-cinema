export function sha1ToHex(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const toHex = obj.to_hex;
    if (typeof toHex === "function") {
      return String(toHex.call(value)).toLowerCase();
    }
    const toBytes = obj.to_bytes;
    if (typeof toBytes === "function") {
      const raw = toBytes.call(value);
      if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
        return Buffer.from(raw).toString("hex").toLowerCase();
      }
    }
    const toString = obj.to_string;
    if (typeof toString === "function") {
      const raw = toString.call(value);
      if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
        return Buffer.from(raw).toString("hex").toLowerCase();
      }
      const text = String(raw).trim().toLowerCase();
      if (text.length === 40 && /^[0-9a-f]+$/.test(text)) return text;
      return text;
    }
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    const raw = Buffer.from(value);
    if (raw.length === 20) return raw.toString("hex").toLowerCase();
    return raw.toString("utf8").toLowerCase();
  }

  let text = String(value).trim().toLowerCase();
  if (text.startsWith("0x")) text = text.slice(2);
  return text;
}
