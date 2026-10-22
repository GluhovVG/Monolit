/** Normalises the ALLOWED_EMAILS secret: lowercase, de-duplicated, valid-looking emails only. */
export function parseEmailList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map(item => item.trim().toLowerCase())
        .filter(item => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item))
    )
  );
}
