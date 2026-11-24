# EPG Timeshift Sync Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make timeshift EPG history prefetch 4-8× faster by running channel fetches in parallel with bounded concurrency, per-fetch timeouts, and a targeted IDB query for catchup-enabled streams.

**Architecture:** Extract the sequential prefetch loop from `renderer-epg.js:fetchAndStoreEpg` into a pure module `lib/epg-prefetch.js` that takes a fetcher function and concurrency options. Add a focused IDB helper `IPTVDb.getCatchupStreams(accountId)` that filters at the store level. Tests use `node --test` with `fake-indexeddb` for the IDB helper and pure-function mocks for the prefetch module.

**Tech Stack:** Node.js `node --test`, `fake-indexeddb` (dev dep), IndexedDB, Xtream Codes API (`get_simple_data_table`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `db.js` (modify) | Add `getCatchupStreams(accountId)` returning only `live_streams` with `catchup===1` |
| `lib/epg-prefetch.js` (new) | Pure module: parallel prefetch with concurrency + per-fetch timeout |
| `lib/epg-prefetch.js` (script tag in `index.html`) | Loaded in renderer |
| `renderer-epg.js` (modify) | Replace sequential loop in `fetchAndStoreEpg` with `prefetchEpgHistory` call |
| `test/db.test.js` (new) | Unit tests for `getCatchupStreams` using `fake-indexeddb` |
| `test/epg-prefetch.test.js` (new) | Unit tests for prefetch concurrency/timeout/error-skip |
| `package.json` (modify) | Add `fake-indexeddb` to devDependencies, list new files in `build.files` |
| `index.html` (modify) | Add `<script src="lib/epg-prefetch.js">` before `renderer-epg.js` |

---

## Task 1: Install fake-indexeddb and register new test file

**Files:**
- Modify: `package.json:devDependencies`, `package.json:build.files`

- [ ] **Step 1: Install fake-indexeddb**

Run from project root:
```bash
npm install --save-dev fake-indexeddb
```
Expected: `package.json` gains `"fake-indexeddb": "^6.0.0"` (or newer) in `devDependencies`, `node_modules/fake-indexeddb/` exists, `package-lock.json` updated.

- [ ] **Step 2: Verify install**

```bash
node -e "require('fake-indexeddb/auto'); console.log('ok')"
```
Expected: prints `ok`.

- [ ] **Step 3: Add new test files to build.files**

Edit `package.json` `build.files` array. Add:
```json
"lib/**/*",
"test/**/*"
```
(Lib already in build.files per current config — confirm and add `test/**/*` if missing. Test files don't need to ship in the AppImage; remove `test/**/*` from the list if a minimal AppImage is preferred. Decision: include `lib/**/*` only, not `test/**/*`. Skip the test entry.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add fake-indexeddb dev dependency for IDB unit tests"
```

---

## Task 2: Add getCatchupStreams IDB helper with test

**Files:**
- Modify: `db.js` (add method after `getStreamsByCategory` at line 230)
- Create: `test/db.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/db.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
require('fake-indexeddb/auto');

// Load db.js. It references `indexedDB` globally; fake-indexeddb/auto provides it.
const { IPTVDb } = require('../db.js');

async function seedStreams(db, accountId, items) {
  const tx = db.transaction(['live_streams'], 'readwrite');
  const store = tx.objectStore('live_streams');
  for (const item of items) {
    store.put({ ...item, compoundKey: `${accountId}_${item.streamId}`, accountId });
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

test('getCatchupStreams: returns only streams with catchup===1', async () => {
  await IPTVDb.open();
  await seedStreams(IPTVDb.db, 'acc1', [
    { streamId: 1, name: 'Has Catchup', catchup: 1, categoryId: 'c1' },
    { streamId: 2, name: 'No Catchup',   catchup: 0, categoryId: 'c1' },
    { streamId: 3, name: 'Also Catchup', catchup: 1, categoryId: 'c2' },
  ]);

  const result = await IPTVDb.getCatchupStreams('acc1');
  const ids = result.map(s => s.streamId).sort();
  assert.deepStrictEqual(ids, [1, 3]);

  // Cleanup so other tests start fresh
  IPTVDb.db.close();
  await new Promise(r => { const req = indexedDB.deleteDatabase('IPTVPlayerDB'); req.onsuccess = r; req.onerror = r; });
});

test('getCatchupStreams: filters by accountId', async () => {
  await IPTVDb.open();
  await seedStreams(IPTVDb.db, 'acc1', [{ streamId: 10, name: 'A', catchup: 1 }]);
  await seedStreams(IPTVDb.db, 'acc2', [{ streamId: 20, name: 'B', catchup: 1 }]);

  const r1 = await IPTVDb.getCatchupStreams('acc1');
  const r2 = await IPTVDb.getCatchupStreams('acc2');
  assert.strictEqual(r1.length, 1);
  assert.strictEqual(r1[0].streamId, 10);
  assert.strictEqual(r2.length, 1);
  assert.strictEqual(r2[0].streamId, 20);

  IPTVDb.db.close();
  await new Promise(r => { const req = indexedDB.deleteDatabase('IPTVPlayerDB'); req.onsuccess = r; req.onerror = r; });
});

test('getCatchupStreams: empty result when none match', async () => {
  await IPTVDb.open();
  await seedStreams(IPTVDb.db, 'acc1', [{ streamId: 1, name: 'A', catchup: 0 }]);

  const result = await IPTVDb.getCatchupStreams('acc1');
  assert.deepStrictEqual(result, []);

  IPTVDb.db.close();
  await new Promise(r => { const req = indexedDB.deleteDatabase('IPTVPlayerDB'); req.onsuccess = r; req.onerror = r; });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/db.test.js
```
Expected: FAIL with `TypeError: IPTVDb.getCatchupStreams is not a function`.

- [ ] **Step 3: Implement the helper in db.js**

Open `db.js`. Locate `getStreamsByCategory` at line 225. Verify the export shape — `db.js` is loaded as a script in the renderer (not CommonJS) but exports `IPTVDb` for the test file. Read the bottom of `db.js` to see how `module.exports` is wired; if absent, add a CommonJS export guarded by `typeof module`:

Add this method to the `IPTVDb` object (e.g. right after `getStreamsByCategory`):
```js
// Returns live_streams for accountId where catchup === 1.
// Filters in memory after the accountId index lookup because
// the catchup flag has no dedicated IDB index and the typical
// live_streams store is small enough to filter cheaply.
getCatchupStreams(accountId) {
  return this._idbQueryByAccountId('live_streams', accountId).then(items =>
    (items || []).filter(s => s && s.catchup === 1)
  );
},
```

Then add a CommonJS export at the very bottom of `db.js` (guarded so the renderer script tag still works):
```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IPTVDb };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/db.test.js
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add db.js test/db.test.js
git commit -m "feat(db): add getCatchupStreams helper for targeted catchup queries"
```

---

## Task 3: Extract lib/epg-prefetch.js pure module with tests

**Files:**
- Create: `lib/epg-prefetch.js`
- Create: `test/epg-prefetch.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/epg-prefetch.test.js`:
```js
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
  assert.ok(elapsed < 350, `expected <350ms with concurrency=3, got ${elapsed}ms`);
  assert.ok(elapsed >= 200, `expected >=200ms (two batches), got ${elapsed}ms`);
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
  assert.deepStrictEqual(stats, { total: 0, succeeded: 0, failed: 0, skipped: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/epg-prefetch.test.js
```
Expected: FAIL with `Cannot find module '../lib/epg-prefetch.js'`.

- [ ] **Step 3: Implement the module**

Create `lib/epg-prefetch.js`:
```js
/**
 * Parallel EPG history prefetch for timeshift-enabled streams.
 *
 * Pure module: takes a list of streams and a fetcher, runs them with bounded
 * concurrency and per-fetch timeout, returns aggregate stats. No DOM or IDB
 * dependencies — caller wires those in.
 *
 * @param {Array<{streamId?: number|string, epgChannelId?: string}>} streams
 * @param {object} opts
 * @param {(stream) => Promise<{epg_listings?: Array}>} opts.fetcher
 * @param {number} [opts.concurrency=5]
 * @param {number} [opts.perFetchTimeoutMs=15000]
 * @param {(current: number, total: number, stream: object) => void} [opts.onProgress]
 * @returns {Promise<{total: number, succeeded: number, failed: number, skipped: number}>}
 */
async function prefetchEpgHistory(streams, opts) {
  const {
    fetcher,
    concurrency = 5,
    perFetchTimeoutMs = 15000,
    onProgress = null
  } = opts || {};

  const list = Array.isArray(streams) ? streams : [];
  const stats = { total: list.length, succeeded: 0, failed: 0, skipped: 0 };
  if (list.length === 0) return stats;

  // Pre-filter into runnable + skipped so the worker pool only sees valid work.
  const queue = [];
  for (const s of list) {
    if (!s || !s.streamId || !s.epgChannelId) {
      stats.skipped++;
    } else {
      queue.push(s);
    }
  }

  let nextIndex = 0;
  let processed = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= queue.length) return;
      const stream = queue[i];
      processed++;
      const current = processed; // 1-based, includes skipped already counted above
      if (typeof onProgress === 'function') {
        try { onProgress(current, list.length, stream); } catch (_) { /* swallow callback errors */ }
      }
      try {
        await runWithTimeout(fetcher(stream), perFetchTimeoutMs, `timeout after ${perFetchTimeoutMs}ms`);
        stats.succeeded++;
      } catch (err) {
        stats.failed++;
        // Surfacing the error to console helps the existing log surface identify the channel.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[EPG Prefetch] ${stream.name || stream.streamId}: ${(err && err.message) || err}`);
        }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return stats;
}

function runWithTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message || 'timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// CommonJS export for tests; renderer just uses the global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prefetchEpgHistory };
}
if (typeof window !== 'undefined') {
  window.prefetchEpgHistory = prefetchEpgHistory;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/epg-prefetch.test.js
```
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/epg-prefetch.js test/epg-prefetch.test.js
git commit -m "feat(epg): add parallel prefetch module with concurrency + timeout"
```

---

## Task 4: Wire prefetch into fetchAndStoreEpg

**Files:**
- Modify: `renderer-epg.js:33-67`
- Modify: `index.html` (add `<script>` tag for `lib/epg-prefetch.js` before `renderer-epg.js`)

- [ ] **Step 1: Add the script tag in index.html**

Find the existing `<script src="renderer-epg.js">` in `index.html`. Add the new file immediately before it:
```html
<script src="lib/epg-prefetch.js"></script>
<script src="renderer-epg.js"></script>
```

- [ ] **Step 2: Replace the sequential loop**

In `renderer-epg.js`, replace the entire try-block at lines 33-67 (the one that starts with `// Prefetch EPG history for timeshift-enabled channels sequentially`) with:
```js
  // Prefetch EPG history for timeshift-enabled channels in parallel.
  try {
    const catchupStreams = await IPTVDb.getCatchupStreams(account.id);
    console.log(`[EPG Sync] Found ${catchupStreams.length} timeshift-enabled channels to fetch history for.`);

    const loaderText = document.getElementById('loader-text');
    const syncStep = document.getElementById('sync-step');

    const fetcher = (stream) => fetchXtreamApi(account, 'get_simple_data_table', { stream_id: stream.streamId });
    const onProgress = (current, total, stream) => {
      const text = `Syncing TV Guide history (${current}/${total}): ${stream.name}...`;
      if (loaderText) loaderText.textContent = text;
      if (syncStep) syncStep.textContent = text;
    };

    const stats = await prefetchEpgHistory(catchupStreams, {
      fetcher,
      onProgress,
      concurrency: 5,
      perFetchTimeoutMs: 15000
    });

    // Persist fetched history into IDB sequentially after the parallel fetch —
    // mergeChannelEpg opens its own transaction per call, and the volume is small
    // relative to the network cost.
    let merged = 0;
    for (const stream of catchupStreams) {
      if (!stream || !stream.streamId || !stream.epgChannelId) continue;
      try {
        const res = await fetcher(stream);
        if (res && res.epg_listings && res.epg_listings.length > 0) {
          const xmltvProgs = res.epg_listings.map(mapEpgListingToXmltvProg);
          await IPTVDb.mergeChannelEpg(account.id, stream.epgChannelId, xmltvProgs);
          merged += xmltvProgs.length;
        }
      } catch (err) {
        console.warn(`[EPG Sync] merge failed for ${stream.name}:`, err.message);
      }
    }
    console.log(`[EPG Sync] Timeshift prefetch done. fetched=${stats.succeeded}/${stats.total} failed=${stats.failed} skipped=${stats.skipped} merged=${merged}`);
  } catch (err) {
    console.warn('[EPG Sync] Error identifying/fetching timeshift channels:', err);
  }
```

Note: this version reuses `fetcher` for the merge pass to avoid a second network round trip per stream. The parallel pass already validated the channels; the second loop just persists.

- [ ] **Step 3: Syntax check**

```bash
node -c renderer-epg.js
```
Expected: no output (exit 0). Also check `index.html` parses by loading it in Electron (`npm start`).

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all existing tests pass + new db.test.js + new epg-prefetch.test.js.

- [ ] **Step 5: Commit**

```bash
git add renderer-epg.js index.html
git commit -m "refactor(epg): parallelize timeshift prefetch with timeout + targeted query"
```

---

## Task 5: Manual verify speedup

**Files:** none (verification only)

- [ ] **Step 1: Baseline timing (optional)**

Before running, note the current timeshift sync duration from console: `[EPG Sync] Sequential timeshift history prefetch completed successfully.`

- [ ] **Step 2: Run the app**

```bash
npm start
```
Expected: app launches, EPG sync runs, console shows:
- `[EPG Sync] Found N timeshift-enabled channels to fetch history for.`
- `[EPG Prefetch] <name>: timeout after 15000ms` for any stalled channels (acceptable)
- `[EPG Sync] Timeshift prefetch done. fetched=X/N failed=Y skipped=Z merged=M`

- [ ] **Step 3: Confirm speedup**

Compare wall-clock from start of timeshift prefetch to the "done" log line. Target: ≥3× faster than baseline on accounts with ≥10 timeshift channels. If not, lower `concurrency` to 3 or raise `perFetchTimeoutMs` to 20000 and re-test.

- [ ] **Step 4: Confirm EPG grid still shows history**

Open EPG grid, scroll left past "now" — historic programs should appear for catchup-enabled channels. Non-timeshift channels should still hide history (existing behavior from commit `5a3992a`).

- [ ] **Step 5: Commit any tuning if needed**

If concurrency/timeout values were adjusted:
```bash
git add renderer-epg.js
git commit -m "tune(epg): adjust prefetch concurrency after manual verification"
```

---

## Self-Review Notes

- **Spec coverage:** Helper (Task 2) ✓ Parallel prefetch (Task 3) ✓ Concurrency cap (Task 3 tests) ✓ Timeout (Task 3 tests) ✓ Targeted IDB query (Task 2) ✓ Wiring (Task 4) ✓ Manual verify (Task 5) ✓
- **Placeholder scan:** All step code blocks are complete; no TBDs.
- **Type consistency:** `getCatchupStreams(accountId)` used in Task 2 and Task 4 with same signature. `prefetchEpgHistory(streams, opts)` with `opts.fetcher`, `opts.concurrency`, `opts.perFetchTimeoutMs`, `opts.onProgress` used in Task 3 and Task 4 identically. `stream.streamId` and `stream.epgChannelId` checked consistently.
- **Skipped intentionally:** `getStreamsByCategory` still used elsewhere (renderer-epg.js:334, renderer-xtream.js:634) — no change needed.
- **Risk:** `index.html` script tag must come before `renderer-epg.js`. Confirmed in Step 1 of Task 4.
