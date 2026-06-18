# User Settings & Settings Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global user-settings system (IDB-backed) with a Settings menu entry that opens a modal exposing EPG prefetch concurrency, cache age limit, and EPG historic filter.

**Architecture:** New `settings` object store in IndexedDB (v3→v4 migration). Pure data module `lib/settings.js` with sync `get()` / async `set()` and an in-memory cache. Modal markup in `index.html` driven by `renderer-settings.js`. Application menu entry in `main.js` with `Ctrl+,` accelerator, IPC via `preload.js`. Consumer sites replace hardcoded values with `AppSettings.get(key, default)`.

**Tech Stack:** Node.js `node --test`, `fake-indexeddb` (already installed), Electron IPC, vanilla DOM modal, IndexedDB v4.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `db.js` (modify) | v3→v4 migration; new `_idbGetAll(storeName)` helper; consumer wiring for `epgHistoricFilterDays` |
| `lib/settings.js` (new) | Pure data layer: schema, cache, load/get/set/onChange; CommonJS + window export |
| `renderer-settings.js` (new) | DOM layer: open/close/save/reset form logic |
| `renderer.js` (modify) | Call `AppSettings.load()` on init; wire `cacheAgeLimitHours` |
| `renderer-epg.js` (modify) | Wire `epgPrefetchConcurrency` consumer |
| `index.html` (modify) | Modal markup, script tags for `lib/settings.js` and `renderer-settings.js` |
| `main.js` (modify) | New Settings menu with Preferences item |
| `preload.js` (modify) | Expose `onOpenSettings` IPC bridge |
| `test/settings.test.js` (new) | Unit tests for AppSettings |
| `test/db.test.js` (modify) | Add v3→v4 migration test |
| `style.css` (modify) | Add `.form-hint`, `.form-error`, `input.invalid` rules if absent |

---

## Task 1: IDB v3→v4 migration + `_idbGetAll` helper + test

**Files:**
- Modify: `db.js` (dbVersion 3→4, new `settings` store, new `_idbGetAll` helper, CommonJS export already present from EPG task)
- Modify: `test/db.test.js` (add migration test)

- [ ] **Step 1: Write the failing test**

Open `test/db.test.js`. Append this test at the end (just before the file's final test or after the last existing one):
```js
test('IDB v3→v4 migration adds settings store', async () => {
  // Open at v3 to simulate existing user state.
  const v3Req = indexedDB.open('IPTVPlayerDB', 3);
  await new Promise((resolve, reject) => {
    v3Req.onsuccess = () => { v3Req.result.close(); resolve(); };
    v3Req.onerror = (e) => reject(e.target.error);
  });

  // Now open via IPTVDb at v4.
  await IPTVDb.open();
  const storeNames = Array.from(IPTVDb.db.objectStoreNames);
  assert.ok(storeNames.includes('settings'), 'settings store should exist after migration');
  assert.ok(storeNames.includes('epg_programmes'), 'existing stores preserved');
  assert.ok(storeNames.includes('accounts'), 'existing stores preserved');

  IPTVDb.db.close();
  await new Promise(r => { const req = indexedDB.deleteDatabase('IPTVPlayerDB'); req.onsuccess = r; req.onerror = r; });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/db.test.js`
Expected: FAIL with `TypeError: Cannot read property 'objectStoreNames' of null` or `settings store should exist after migration` (assertion failure). The store does not exist yet.

- [ ] **Step 3: Bump version, add migration, add `_idbGetAll` helper**

Edit `db.js`:

1. Change `dbVersion: 3,` to `dbVersion: 4,` (line 7).

2. In `onupgradeneeded`, after the existing v3 block (`if (!db.objectStoreNames.contains('epg_meta')) { ... }`), add:
```js
        // 5. Settings store (added in v4)
        if (oldVersion < 4) {
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
        }
```

3. Add a new helper method after `_idbQueryByAccountId` (after line 215):
```js
  // Internal helper: read all rows from a store.
  _idbGetAll(storeName) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/db.test.js`
Expected: all tests pass (3 original + 1 new).

- [ ] **Step 5: Commit**

```bash
git add db.js test/db.test.js
git commit -m "feat(db): add settings store via v3->v4 migration + _idbGetAll helper"
```

---

## Task 2: lib/settings.js module + tests

**Files:**
- Create: `lib/settings.js`
- Create: `test/settings.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/settings.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
require('fake-indexeddb/auto');
const { IPTVDb } = require('../db.js');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/settings.test.js`
Expected: FAIL with `Cannot find module '../lib/settings.js'`.

- [ ] **Step 3: Implement the module**

Create `lib/settings.js`:
```js
/**
 * AppSettings — global user settings with IDB persistence.
 *
 * Pure data layer. No DOM, no Electron. Holds an in-memory cache populated
 * once on app startup via load(); consumers use sync get() at point of use.
 *
 * Dual export: CommonJS for tests, window global for renderer.
 */

const SCHEMA = {
  epgPrefetchConcurrency: { type: 'int', min: 1, max: 10, default: 4 },
  cacheAgeLimitHours:     { type: 'int', min: 1, max: 168, default: 24 },
  epgHistoricFilterDays:  { type: 'int', min: 1, max: 30,  default: 7 },
};

function validate(key, value) {
  const entry = SCHEMA[key];
  if (!entry) throw new Error(`unknown setting key: ${key}`);
  if (!Number.isInteger(value)) {
    throw new TypeError(`setting ${key} must be an integer, got ${typeof value}: ${value}`);
  }
  if (value < entry.min || value > entry.max) {
    throw new RangeError(`setting ${key} out of range [${entry.min}, ${entry.max}]: ${value}`);
  }
  return value;
}

const AppSettings = {
  _cache: null,
  _loadPromise: null,
  _listeners: [],

  load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      try {
        const rows = await IPTVDb._idbGetAll('settings');
        const cache = {};
        for (const row of rows || []) {
          if (row && row.key && SCHEMA[row.key]) {
            // Trust stored value; only load() time do we accept non-validated values.
            cache[row.key] = row.value;
          }
        }
        this._cache = cache;
      } catch (err) {
        console.warn('[AppSettings] load() failed, using empty cache:', err && err.message);
        this._cache = {};
      }
    })();
    return this._loadPromise;
  },

  get(key, defaultValue) {
    if (this._cache === null) {
      throw new Error('AppSettings not loaded — call load() first');
    }
    if (this._cache[key] !== undefined) return this._cache[key];
    if (defaultValue !== undefined) return defaultValue;
    if (SCHEMA[key]) return SCHEMA[key].default;
    return undefined;
  },

  async set(key, value) {
    validate(key, value);
    if (this._cache === null) {
      throw new Error('AppSettings not loaded — call load() first');
    }
    await IPTVDb._idbPut('settings', { key, value });
    this._cache[key] = value;
    for (const fn of this._listeners.slice()) {
      try { fn(key, value); } catch (_) { /* swallow */ }
    }
  },

  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AppSettings };
}
if (typeof window !== 'undefined') {
  window.AppSettings = AppSettings;
}
```

Also add a new helper method to `db.js` (alongside `_idbGetAll` from Task 1):
```js
  // Internal helper: write a single row to a store.
  _idbPut(storeName, value) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value);
      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e.target.error);
    });
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/settings.test.js`
Expected: 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/settings.js test/settings.test.js db.js
git commit -m "feat(settings): add AppSettings module with IDB cache, load/get/set/onChange"
```

---

## Task 3: Application menu entry + IPC bridge

**Files:**
- Modify: `main.js` (add Settings menu)
- Modify: `preload.js` (add `onOpenSettings`)

- [ ] **Step 1: Add the Settings menu to main.js**

Open `main.js`. In `createMenu()` (line 41), add a new top-level menu BETWEEN the `Playlists` menu (closes at line 69) and the `Playback` menu (starts at line 70). Insert:
```js
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('open-settings');
            }
          }
        }
      ]
    },
```

- [ ] **Step 2: Add `onOpenSettings` to preload.js**

Open `preload.js`. Inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, add a new entry (e.g. after `onShowM3uModal` at line 28-30):
```js
  onOpenSettings: (callback) => {
    ipcRenderer.on('open-settings', () => callback());
  },
```

- [ ] **Step 3: Syntax check**

Run: `node -c main.js && node -c preload.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat(settings): add Settings menu entry + IPC bridge for open-settings"
```

---

## Task 4: Modal markup in index.html + script tags

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the modal markup**

Open `index.html`. Insert this modal AFTER the existing M3U modal (which ends at line 293) and BEFORE the `<!-- Load dependencies -->` comment (line 295). The modal HTML:
```html
  <!-- User Settings Modal (hidden by default) -->
  <div class="modal-overlay" id="settings-modal" style="display: none;">
    <div class="modal-card" style="max-width: 480px;">
      <div class="modal-header">
        <h2>Settings</h2>
        <button id="btn-close-settings" class="close-btn">&times;</button>
      </div>
      <div class="modal-body">
        <form id="settings-form" onsubmit="return false;">
          <div class="form-group">
            <label for="set-concurrency">EPG prefetch concurrency</label>
            <input type="number" id="set-concurrency" min="1" max="10" step="1">
            <small class="form-hint">Parallel channel EPG fetches (1–10)</small>
          </div>
          <div class="form-group">
            <label for="set-cache">Cache age limit (hours)</label>
            <input type="number" id="set-cache" min="1" max="168" step="1">
            <small class="form-hint">Hours before cached data is considered stale</small>
          </div>
          <div class="form-group">
            <label for="set-historic">EPG historic filter (days)</label>
            <input type="number" id="set-historic" min="1" max="30" step="1">
            <small class="form-hint">Days of past EPG to retain</small>
          </div>
          <div class="form-actions-row">
            <button type="button" id="btn-reset-settings" class="btn btn-secondary">Reset to defaults</button>
            <button type="button" id="btn-save-settings" class="btn btn-primary">Save</button>
          </div>
        </form>
      </div>
    </div>
  </div>

```

- [ ] **Step 2: Add script tags**

In the script tag block (lines 295-304), modify it to:
```html
  <!-- Load dependencies -->
  <script src="node_modules/mpegts.js/dist/mpegts.js"></script>
  <script src="db.js"></script>
  <script src="lib/settings.js"></script>
  <script src="epg-parse.js"></script>
  <script src="renderer-state.js"></script>
  <script src="renderer-playback.js"></script>
  <script src="renderer-xtream.js"></script>
  <script src="lib/epg-prefetch.js"></script>
  <script src="renderer-epg.js"></script>
  <script src="renderer-settings.js"></script>
  <script src="renderer.js"></script>
```

CRITICAL: `lib/settings.js` MUST load BEFORE `renderer-settings.js` (so the `AppSettings` global is set). `renderer-settings.js` loads BEFORE `renderer.js` (so its `openSettingsModal` is defined when `renderer.js` binds the IPC handler).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(settings): add settings modal markup + script tag wiring"
```

---

## Task 5: Style additions

**Files:**
- Modify: `style.css`

- [ ] **Step 1: Check if classes already exist**

Run: `grep -n "form-hint\|form-error\|input.invalid" style.css`
Expected output: no matches (classes don't exist yet). If `.form-hint` exists, skip its rule.

- [ ] **Step 2: Add the style rules**

Append to the end of `style.css`:
```css
.form-hint {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.form-error {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: #ff453a;
}
input.invalid,
input[type="number"].invalid {
  border-color: #ff453a;
  outline-color: #ff453a;
}
```

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "feat(settings): add form-hint, form-error, input.invalid styles"
```

---

## Task 6: renderer-settings.js modal logic

**Files:**
- Create: `renderer-settings.js`

- [ ] **Step 1: Implement the modal logic**

Create `renderer-settings.js`:
```js
/**
 * Settings modal — open/close/save/reset logic.
 * Reads/writes via window.AppSettings. No direct IDB access.
 */

// Schema mirror (kept in sync with lib/settings.js SCHEMA; the source of truth
// is the AppSettings module — we only need the defaults and ranges for the form).
const FORM_SCHEMA = {
  epgPrefetchConcurrency: { min: 1, max: 10, default: 4, el: 'set-concurrency' },
  cacheAgeLimitHours:     { min: 1, max: 168, default: 24, el: 'set-cache' },
  epgHistoricFilterDays:  { min: 1, max: 30, default: 7, el: 'set-historic' },
};

const modal = () => document.getElementById('settings-modal');

function openSettingsModal() {
  if (!window.AppSettings) {
    console.error('[Settings] AppSettings not available; modal not opened');
    return;
  }
  // Populate inputs from current settings (or schema defaults).
  for (const [key, meta] of Object.entries(FORM_SCHEMA)) {
    const input = document.getElementById(meta.el);
    if (input) input.value = AppSettings.get(key, meta.default);
    clearError(input);
  }
  modal().style.display = 'flex';
}

function closeSettingsModal() {
  const m = modal();
  if (m) m.style.display = 'none';
}

function setError(input, message) {
  if (!input) return;
  input.classList.add('invalid');
  let err = input.parentElement.querySelector('.form-error');
  if (!err) {
    err = document.createElement('small');
    err.className = 'form-error';
    input.parentElement.appendChild(err);
  }
  err.textContent = message;
}

function clearError(input) {
  if (!input) return;
  input.classList.remove('invalid');
  const err = input.parentElement.querySelector('.form-error');
  if (err) err.textContent = '';
}

async function saveSettings() {
  let allOk = true;
  for (const [key, meta] of Object.entries(FORM_SCHEMA)) {
    const input = document.getElementById(meta.el);
    clearError(input);
    const raw = input ? input.value : '';
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== String(raw).trim()) {
      setError(input, `Must be an integer between ${meta.min} and ${meta.max}`);
      allOk = false;
      continue;
    }
    if (parsed < meta.min || parsed > meta.max) {
      setError(input, `Must be between ${meta.min} and ${meta.max}`);
      allOk = false;
      continue;
    }
    try {
      await AppSettings.set(key, parsed);
    } catch (err) {
      setError(input, (err && err.message) || 'Save failed');
      allOk = false;
    }
  }
  if (allOk) closeSettingsModal();
}

function resetSettings() {
  for (const meta of Object.values(FORM_SCHEMA)) {
    const input = document.getElementById(meta.el);
    if (input) input.value = meta.default;
    clearError(input);
  }
}

// Wire up handlers once DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-close-settings')?.addEventListener('click', closeSettingsModal);
  document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);
  document.getElementById('btn-reset-settings')?.addEventListener('click', resetSettings);

  // Esc key closes the modal.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal() && modal().style.display === 'flex') {
      closeSettingsModal();
    }
  });
});

// Expose for renderer.js to call from the IPC bridge.
if (typeof window !== 'undefined') {
  window.openSettingsModal = openSettingsModal;
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `node -c renderer-settings.js`
Expected: no output (exit 0). Note: `node -c` will warn about `window` references but should still exit 0. If you see errors, fix them.

- [ ] **Step 3: Commit**

```bash
git add renderer-settings.js
git commit -m "feat(settings): add renderer-settings.js with modal open/close/save/reset"
```

---

## Task 7: Wire IPC handler in renderer.js + load AppSettings on init

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: Find the init code**

Open `renderer.js`. Locate the existing init code (look for `restoreLastState`, `await IPTVDb.open()`, or similar). The first lines of init are around line 47 (`await restoreLastState();`).

- [ ] **Step 2: Add AppSettings.load() after IPTVDb.open()**

Find the place where `IPTVDb.open()` is awaited (likely near line 47 or earlier). Add the load call right after it. If the init currently does:
```js
const db = await IPTVDb.open();
```
Add after:
```js
await AppSettings.load();
```

If the init does NOT explicitly await `IPTVDb.open()` (because it relies on `restoreLastState` triggering it), add a new line near the top of the init flow:
```js
await IPTVDb.open();
await AppSettings.load();
```

(The exact insertion point depends on the current code. Place the two `await`s adjacent, in that order, at the start of the init flow.)

- [ ] **Step 3: Wire the IPC handler**

Add a new line in the init flow (anywhere after the DOM is ready — `DOMContentLoaded` is fine):
```js
if (window.electronAPI && window.electronAPI.onOpenSettings) {
  window.electronAPI.onOpenSettings(() => window.openSettingsModal && window.openSettingsModal());
}
```

- [ ] **Step 4: Syntax check**

Run: `node -c renderer.js`
Expected: exit 0.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all tests pass (db, settings, epg-parse, epg-prefetch).

- [ ] **Step 6: Commit**

```bash
git add renderer.js
git commit -m "feat(settings): load AppSettings on init, wire open-settings IPC handler"
```

---

## Task 8: Wire consumer for cacheAgeLimitHours

**Files:**
- Modify: `renderer-xtream.js:335`

- [ ] **Step 1: Replace the hardcoded value**

Open `renderer-xtream.js`. Locate the line:
```js
const cacheAgeLimit = 24 * 60 * 60 * 1000; // 24 hours
```
(at line 335). Replace it with:
```js
const cacheAgeLimit = AppSettings.get('cacheAgeLimitHours', 24) * 60 * 60 * 1000;
```

- [ ] **Step 2: Syntax check**

Run: `node -c renderer-xtream.js`
Expected: exit 0.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add renderer-xtream.js
git commit -m "feat(settings): wire cacheAgeLimitHours consumer in renderer-xtream"
```

---

## Task 9: Wire consumer for epgPrefetchConcurrency

**Files:**
- Modify: `renderer-epg.js:51`

- [ ] **Step 1: Replace the hardcoded value**

Open `renderer-epg.js`. Locate the line:
```js
      concurrency: 4,
```
(at line 51). Replace it with:
```js
      concurrency: AppSettings.get('epgPrefetchConcurrency', 4),
```

- [ ] **Step 2: Syntax check**

Run: `node -c renderer-epg.js`
Expected: exit 0.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add renderer-epg.js
git commit -m "feat(settings): wire epgPrefetchConcurrency consumer in renderer-epg"
```

---

## Task 10: Wire consumer for epgHistoricFilterDays in db.js

**Files:**
- Modify: `db.js` (line 290 and line 379)

- [ ] **Step 1: Replace the first cutoff**

Open `db.js`. Locate the line:
```js
          const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
```
(at line 290, inside `saveEpg`). Replace it with:
```js
          const cutoff = Math.floor(Date.now() / 1000) - AppSettings.get('epgHistoricFilterDays', 7) * 86400;
```

- [ ] **Step 2: Replace the second cutoff**

Locate the OTHER identical line at line 379 (inside `mergeChannelEpg`). Replace it the same way:
```js
        const cutoff = Math.floor(Date.now() / 1000) - AppSettings.get('epgHistoricFilterDays', 7) * 86400;
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass. The `db.js` consumer only runs when `saveEpg`/`mergeChannelEpg` are called (during sync), which is well after `AppSettings.load()` resolves on app startup. No load-order issue.

- [ ] **Step 4: Commit**

```bash
git add db.js
git commit -m "feat(settings): wire epgHistoricFilterDays consumer in db.js"
```

---

## Task 11: Manual verification

**Files:** none

- [ ] **Step 1: Launch app**

Run: `npm start`
Expected: app launches without console errors. On first launch with v4 IDB, the `settings` store is created (empty).

- [ ] **Step 2: Open Settings dialog**

Click application menu `Settings → Preferences...` (or press `Ctrl+,`).
Expected: settings modal opens with all three fields showing defaults (4, 24, 7).

- [ ] **Step 3: Change concurrency and save**

Change `EPG prefetch concurrency` to 8. Click `Save`. Modal closes.

- [ ] **Step 4: Verify persistence**

Close the app completely. Reopen. Open Settings again.
Expected: concurrency field shows 8.

- [ ] **Step 5: Test reset**

Open Settings. Click `Reset to defaults`. All fields show 4, 24, 7. Click `Save`. Reopen Settings. Defaults still there.

- [ ] **Step 6: Test validation**

Open Settings. Set concurrency to 999. Click `Save`.
Expected: red border on input, inline error text "Must be between 1 and 10". Modal stays open. No write to IDB.

- [ ] **Step 7: Test that consumer reads the value**

With concurrency set to 8, trigger an EPG sync. Open DevTools console.
Expected: prefetch log shows `concurrency: 8` somewhere (e.g. via `prefetchEpgHistory` call). The prefetch runs with 8 parallel workers.

- [ ] **Step 8: Test IDB content**

In DevTools → Application → IndexedDB → IPTVPlayerDB → settings.
Expected: 3 rows (if all three were saved), each with `{key, value}` shape. `epgPrefetchConcurrency.value === 8` (or whatever was last saved).

- [ ] **Step 9: Test Esc-to-close**

Open Settings. Press Escape. Modal closes without saving. Reopen. Previous value still there.

- [ ] **Step 10: Commit any tuning**

If any values needed adjustment (e.g. default range), commit the change.

---

## Self-Review Notes

- **Spec coverage:**
  - Section 1 (Scope): implicit — only what's in scope is implemented
  - Section 2 (Architecture): Tasks 2, 3, 4, 6, 7 cover it
  - Section 3 (Data Model): Task 1 (migration), Task 2 (schema)
  - Section 4 (UI): Tasks 3, 4, 5, 6
  - Section 5 (Consumer Wiring): Tasks 7, 8, 9, 10
  - Section 6 (Error Handling): Task 6 (validation, inline errors), Task 2 (load error handling)
  - Section 7 (Testing): Task 1 (migration test), Task 2 (10 unit tests), Task 11 (manual)
  - Section 8 (Files Touched): all files covered
  - Section 9 (Style): Task 5
- **Placeholder scan:** No TBDs. All step code blocks complete.
- **Type consistency:** `AppSettings.get/set/load/onChange` signatures used identically across Tasks 2, 6, 7, 8, 9, 10. Schema keys (`epgPrefetchConcurrency`, `cacheAgeLimitHours`, `epgHistoricFilterDays`) identical across Tasks 2 (SCHEMA), 6 (FORM_SCHEMA), 8, 9, 10. Form element IDs (`set-concurrency`, `set-cache`, `set-historic`) identical across Tasks 4, 6. IPC channel name (`open-settings`) identical across Tasks 3, 4, 7. `_idbGetAll` and `_idbPut` defined in Task 1, used in Task 2.
- **db.js load order:** Task 10 explicit note about consumer running post-init.
- **Script tag order:** Task 4 Step 2 explicit ordering.
- **No use of `iptcRenderer.send` from main without preload bridge:** Task 3 main.js calls `mainWindow.webContents.send('open-settings')` which pairs with Task 3 preload.js `ipcRenderer.on('open-settings', ...)` bridge.
