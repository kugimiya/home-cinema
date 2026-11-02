export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)}MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${n}B`;
}
