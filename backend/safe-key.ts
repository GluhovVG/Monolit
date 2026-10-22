/** Table-safe deterministic key (FNV-1a 32-bit, hex) for arbitrary text such as department names. */
export function safeKey(input: string): string {
  let hash = 0x811c9dc5;
  for (const ch of input) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
