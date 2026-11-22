const { test } = require('node:test');
const assert = require('node:assert');
require('fake-indexeddb/auto');
const { IPTVDb } = require('../db.js');
globalThis.IPTVDb = IPTVDb;

// Helper: reset the IDB between tests.
async function resetDb() {
  if (IPTVDb.db) {
    try { IPTVDb.db.close(); } catch (_) {}
  }
  await new Promise(r => { const req = indexedDB.deleteDatabase('IPTVPlayerDB'); req.onsuccess = r; req.onerror = r; });
}

test('AppSettings: load() populates cache from IDB', async () => {
  await resetDb();
  await IPTVDb.open();
  // Pre-populate the store
  const tx = IPTVDb.db.transaction(['settings'], 'readwrite');
  tx.objectStore('settings').put({ key: 'epgPrefetchConcurrency', value: 7 });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = (e) => rej(e.target.error); });

  // Re-require to get a fresh module instance (cache must be null)
  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;

  await AppSettings.load();
  assert.strictEqual(AppSettings.get('epgPrefetchConcurrency', 4), 7);

  await resetDb();
});

test('AppSettings: load() on empty store resolves with empty cache, get returns schema default', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;

  await AppSettings.load();
  // No key in store, no defaultValue passed: falls back to SCHEMA default
  assert.strictEqual(AppSettings.get('epgPrefetchConcurrency'), 4);
  assert.strictEqual(AppSettings.get('cacheAgeLimitHours'), 24);
  assert.strictEqual(AppSettings.get('epgHistoricFilterDays'), 7);

  await resetDb();
});

test('AppSettings: get() with explicit defaultValue when key missing', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  assert.strictEqual(AppSettings.get('epgPrefetchConcurrency', 99), 99);

  await resetDb();
});

test('AppSettings: set() writes to IDB and updates cache', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  await AppSettings.set('epgPrefetchConcurrency', 8);
  assert.strictEqual(AppSettings.get('epgPrefetchConcurrency', 4), 8);

  // Verify in IDB
  const rows = await IPTVDb._idbGetAll('settings');
  const row = rows.find(r => r.key === 'epgPrefetchConcurrency');
  assert.strictEqual(row.value, 8);

  await resetDb();
});

test('AppSettings: set() rejects on unknown key', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  await assert.rejects(
    () => AppSettings.set('notAKey', 5),
    /unknown setting key/
  );

  await resetDb();
});

test('AppSettings: set() rejects on non-integer', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  await assert.rejects(
    () => AppSettings.set('epgPrefetchConcurrency', 'abc'),
    /integer/
  );
  await assert.rejects(
    () => AppSettings.set('epgPrefetchConcurrency', 1.5),
    /integer/
  );

  await resetDb();
});

test('AppSettings: set() rejects on out-of-range (below min)', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  await assert.rejects(
    () => AppSettings.set('epgPrefetchConcurrency', 0),
    /range|min|max/i
  );

  await resetDb();
});

test('AppSettings: set() rejects on out-of-range (above max)', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  await assert.rejects(
    () => AppSettings.set('epgPrefetchConcurrency', 11),
    /range|min|max/i
  );

  await resetDb();
});

test('AppSettings: onChange listener fires on set() with key + new value', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  const seen = [];
  const unsub = AppSettings.onChange((k, v) => seen.push([k, v]));
  await AppSettings.set('cacheAgeLimitHours', 48);
  assert.deepStrictEqual(seen, [['cacheAgeLimitHours', 48]]);
  unsub();
  await AppSettings.set('cacheAgeLimitHours', 72);
  assert.strictEqual(seen.length, 1, 'listener should not fire after unsubscribe');

  await resetDb();
});

test('AppSettings: get() before load() throws', async () => {
  await resetDb();
  await IPTVDb.open();

  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  // Do not call load()

  assert.throws(
    () => AppSettings.get('epgPrefetchConcurrency', 4),
    /not loaded/i
  );

  await resetDb();
});

test('AppSettings: SCHEMA is exported and has expected keys', () => {
  const { SCHEMA } = require('../lib/settings.js');
  assert.ok(SCHEMA.epgPrefetchConcurrency, 'epgPrefetchConcurrency in SCHEMA');
  assert.ok(SCHEMA.cacheAgeLimitHours, 'cacheAgeLimitHours in SCHEMA');
  assert.ok(SCHEMA.epgHistoricFilterDays, 'epgHistoricFilterDays in SCHEMA');
  assert.strictEqual(typeof SCHEMA.epgPrefetchConcurrency.default, 'number');
});

test('AppSettings: download schema defaults and enum/string validation', async () => {
  await resetDb();
  await IPTVDb.open();
  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings, SCHEMA } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  assert.strictEqual(SCHEMA.downloadDir.default, '');
  assert.strictEqual(AppSettings.get('downloadDir'), '');
  assert.strictEqual(AppSettings.get('downloadFolderStructure'), 'structured');
  assert.strictEqual(AppSettings.get('downloadDefaultPreset'), 'hevc');
  assert.strictEqual(AppSettings.get('downloadDefaultResolution'), '1080p');
  assert.strictEqual(AppSettings.get('downloadClickAction'), 'dialog');
  assert.strictEqual(AppSettings.get('downloadDuplicateAction'), 'ask');
  assert.strictEqual(AppSettings.get('downloadHwAccel'), 'auto');

  await AppSettings.set('downloadDir', '/tmp/vod');
  assert.strictEqual(AppSettings.get('downloadDir'), '/tmp/vod');
  await AppSettings.set('downloadFolderStructure', 'flat');
  assert.strictEqual(AppSettings.get('downloadFolderStructure'), 'flat');
  await AppSettings.set('downloadDefaultPreset', 'h264');
  assert.strictEqual(AppSettings.get('downloadDefaultPreset'), 'h264');
  await AppSettings.set('downloadDefaultResolution', '720p');
  assert.strictEqual(AppSettings.get('downloadDefaultResolution'), '720p');
  await AppSettings.set('downloadClickAction', 'instant');
  assert.strictEqual(AppSettings.get('downloadClickAction'), 'instant');
  await AppSettings.set('downloadDuplicateAction', 'overwrite');
  assert.strictEqual(AppSettings.get('downloadDuplicateAction'), 'overwrite');
  await AppSettings.set('downloadHwAccel', 'cpu');
  assert.strictEqual(AppSettings.get('downloadHwAccel'), 'cpu');
  await AppSettings.set('downloadHwAccel', '/dev/dri/renderD128');
  assert.strictEqual(AppSettings.get('downloadHwAccel'), '/dev/dri/renderD128');

  await assert.rejects(() => AppSettings.set('downloadDefaultPreset', 'avi'), RangeError);
  await assert.rejects(() => AppSettings.set('downloadDefaultPreset', 123), TypeError);
  await assert.rejects(() => AppSettings.set('downloadDir', 123), TypeError);
  await assert.rejects(() => AppSettings.set('downloadHwAccel', '/dev/null'), RangeError);
  await assert.rejects(() => AppSettings.set('downloadHwAccel', 42), TypeError);

  await resetDb();
});
