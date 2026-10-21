import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectPages, forEachBatch } from '../backend/paged-records.ts';

describe('Realtime subscriber paging safety', () => {
  it('collects beyond 1000 records by following nextToken', async () => {
    const records = Array.from({ length: 1205 }, (_, id) => id);
    const result = await collectPages(async token => {
      const start = token ? Number(token) : 0;
      const items = records.slice(start, start + 200);
      return { items, nextToken: start + 200 < records.length ? String(start + 200) : undefined };
    });
    assert.deepEqual(result, records);
  });
  it('throws on endless pagination instead of returning incomplete data', async () => {
    await assert.rejects(
      collectPages(async () => ({ items: [1], nextToken: 'repeat' })),
      /loop/i
    );
    await assert.rejects(
      collectPages(async token => ({ items: [1], nextToken: String(Number(token || 0) + 1) }), 2),
      /safe page limit/i
    );
  });
  it('splits deletions into safe, awaited batches', async () => {
    const sizes: number[] = [];
    await forEachBatch(Array.from({ length: 1205 }, (_, i) => i), 200, async batch => { sizes.push(batch.length); });
    assert.deepEqual(sizes, [200, 200, 200, 200, 200, 200, 5]);
  });
  it('rejects invalid page and batch limits', async () => {
    await assert.rejects(collectPages(async () => ({ items: [] }), 0), /Invalid/);
    await assert.rejects(forEachBatch([1], 501, async () => {}), /Invalid/);
  });
});
