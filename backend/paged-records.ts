/**
 * Legacy AppDeploy tables do not support indexed lookups. Enumerate with
 * nextToken to avoid silently ignoring subscribers past the first page.
 * A hard cap fails explicitly rather than pretending notifications succeeded.
 * When subscriber volume grows, migrate to entity/connection indexed tables.
 */
export async function collectPages<T>(
  load: (nextToken?: string) => Promise<{ items: T[]; nextToken?: string }>,
  maxPages = 50
): Promise<T[]> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('Invalid page limit');
  const result: T[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await load(token);
    result.push(...page.items);
    if (!page.nextToken) return result;
    if (tokens.has(page.nextToken)) throw new Error('Database pagination loop detected');
    tokens.add(page.nextToken);
    token = page.nextToken;
  }
  throw new Error('Subscription table exceeds safe page limit; use indexed storage');
}

export async function forEachBatch<T>(
  records: readonly T[],
  size: number,
  process: (batch: T[]) => Promise<void>
): Promise<void> {
  if (!Number.isSafeInteger(size) || size < 1 || size > 500) throw new Error('Invalid batch size');
  for (let i = 0; i < records.length; i += size) {
    await process(records.slice(i, i + size));
  }
}
