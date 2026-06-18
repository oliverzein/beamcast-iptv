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
