const { test } = require('node:test');
const assert = require('node:assert');
const { prefetchEpgHistory } = require('../lib/epg-prefetch.js');

const sampleStream = (streamId, name) => ({ streamId, name, epgChannelId: `epg-${streamId}` });

const okFetcher = (ms = 50) => async (stream) => {
  await new Promise(r => setTimeout(r, ms));
  return { epg_listings: [{ start_timestamp: 1, stop_timestamp: 2, title: Buffer.from(stream.name).toString('base64') }] };
};

test('prefetchEpgHistory: processes all streams and returns stats', async () => {
  const streams = [sampleStream(1, 'A'), sampleStream(2, 'B'), sampleStream(3, 'C')];
  const fetcher = okFetcher(10);
  const stats = await prefetchEpgHistory(streams, { fetcher, concurrency: 2, perFetchTimeoutMs: 1000 });
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.succeeded, 3);
  assert.strictEqual(stats.failed, 0);
  assert.strictEqual(stats.skipped, 0);
});

test('prefetchEpgHistory: skips streams missing streamId or epgChannelId', async () => {
  const streams = [
    sampleStream(1, 'A'),
    { streamId: 2, name: 'B' },                 // no epgChannelId
    { name: 'C', epgChannelId: 'epg-3' },      // no streamId
    sampleStream(4, 'D')
  ];
  const fetcher = okFetcher(5);
  const stats = await prefetchEpgHistory(streams, { fetcher, concurrency: 2, perFetchTimeoutMs: 1000 });
  assert.strictEqual(stats.total, 4);
  assert.strictEqual(stats.succeeded, 2);
  assert.strictEqual(stats.skipped, 2);
});

test('prefetchEpgHistory: concurrency cap is respected (timing-based)', async () => {
  // 6 streams x 100ms each. concurrency=3 → 2 batches → ~200ms total (not 600ms).
  const streams = Array.from({ length: 6 }, (_, i) => sampleStream(i, `S${i}`));
  const fetcher = okFetcher(100);
  const start = Date.now();
  await prefetchEpgHistory(streams, { fetcher, concurrency: 3, perFetchTimeoutMs: 5000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected <500ms with concurrency=3, got ${elapsed}ms`);
  assert.ok(elapsed >= 180, `expected >=180ms (two batches), got ${elapsed}ms`);
});

test('prefetchEpgHistory: per-fetch timeout skips slow stream without hanging', async () => {
  const slowFetcher = async (stream) => {
    await new Promise(r => setTimeout(r, 500));
    return { epg_listings: [] };
  };
  const streams = [sampleStream(1, 'fast'), sampleStream(2, 'slow')];
  const start = Date.now();
  const stats = await prefetchEpgHistory(streams, { fetcher: slowFetcher, concurrency: 2, perFetchTimeoutMs: 50 });
  const elapsed = Date.now() - start;
  assert.strictEqual(stats.total, 2);
  assert.strictEqual(stats.succeeded, 0);
  assert.strictEqual(stats.failed, 2);
  assert.ok(elapsed < 300, `expected <300ms (timeout=50ms), got ${elapsed}ms`);
});

test('prefetchEpgHistory: fetcher error counted as failure, others continue', async () => {
  const fetcher = async (stream) => {
    if (stream.streamId === 2) throw new Error('boom');
    return { epg_listings: [] };
  };
  const streams = [sampleStream(1, 'A'), sampleStream(2, 'B'), sampleStream(3, 'C')];
  const stats = await prefetchEpgHistory(streams, { fetcher, concurrency: 2, perFetchTimeoutMs: 1000 });
  assert.strictEqual(stats.succeeded, 2);
  assert.strictEqual(stats.failed, 1);
});

test('prefetchEpgHistory: onProgress invoked with correct indices', async () => {
  const streams = [sampleStream(1, 'A'), sampleStream(2, 'B'), sampleStream(3, 'C')];
  const seen = [];
  await prefetchEpgHistory(streams, {
    fetcher: okFetcher(5),
    concurrency: 1,
    perFetchTimeoutMs: 1000,
    onProgress: (i, total, stream) => seen.push([i, total, stream.streamId])
  });
  // Concurrency=1 → exactly one progress per stream, in order
  assert.deepStrictEqual(seen, [[1,3,1], [2,3,2], [3,3,3]]);
});

test('prefetchEpgHistory: empty stream list returns zero stats', async () => {
  const stats = await prefetchEpgHistory([], { fetcher: okFetcher(), concurrency: 2, perFetchTimeoutMs: 1000 });
  assert.deepStrictEqual(stats, { total: 0, succeeded: 0, failed: 0, skipped: 0, results: [] });
});

test('prefetchEpgHistory: returns per-stream results in queue order', async () => {
  const streams = [sampleStream(1, 'A'), sampleStream(2, 'B')];
  const fetcher = async (s) => ({ epg_listings: [{ title: s.name }] });
  const stats = await prefetchEpgHistory(streams, { fetcher, concurrency: 2, perFetchTimeoutMs: 1000 });
  assert.strictEqual(stats.results.length, 2);
  assert.strictEqual(stats.results[0].stream.streamId, 1);
  assert.strictEqual(stats.results[0].listings.epg_listings[0].title, 'A');
  assert.strictEqual(stats.results[1].stream.streamId, 2);
  assert.strictEqual(stats.results[1].listings.epg_listings[0].title, 'B');
});

test('prefetchEpgHistory: results record errors with null listings', async () => {
  const fetcher = async (s) => { if (s.streamId === 2) throw new Error('x'); return { epg_listings: [] }; };
  const streams = [sampleStream(1, 'A'), sampleStream(2, 'B'), sampleStream(3, 'C')];
  const stats = await prefetchEpgHistory(streams, { fetcher, concurrency: 2, perFetchTimeoutMs: 1000 });
  const byId = Object.fromEntries(stats.results.map(r => [r.stream.streamId, r]));
  assert.strictEqual(byId[1].error, null);
  assert.strictEqual(byId[1].listings.epg_listings.length, 0);
  assert.strictEqual(byId[2].error.message, 'x');
  assert.strictEqual(byId[2].listings, null);
  assert.strictEqual(byId[3].error, null);
});

test('prefetchEpgHistory: skipped streams not in results', async () => {
  const fetcher = async (s) => ({ epg_listings: [] });
  const streams = [
    sampleStream(1, 'A'),
    { name: 'no-id' },  // skipped: no streamId, no epgChannelId
    sampleStream(3, 'C')
  ];
  const stats = await prefetchEpgHistory(streams, { fetcher, concurrency: 2, perFetchTimeoutMs: 1000 });
  assert.strictEqual(stats.skipped, 1);
  assert.strictEqual(stats.results.length, 2);
  const ids = stats.results.map(r => r.stream.streamId).sort();
  assert.deepStrictEqual(ids, [1, 3]);
});
