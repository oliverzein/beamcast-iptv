# User Settings & Settings Dialog — Design Spec

**Status:** Draft
**Date:** 2026-06-18
**Goal:** Expose user-tunable knobs (starting with EPG prefetch concurrency, cache age limit, EPG historic filter) via a dedicated settings dialog accessible from the application menu. Persist values in IndexedDB. No restart required for in-session changes (where consumers re-read live); restart required for changes that are read once at startup.

---

## 1. Scope

**In scope (v1):**
- New "Settings" application menu entry with one item: "Preferences..." (accelerator `Ctrl/Cmd+,`).
- New settings dialog modal opened from the menu via IPC.
- Three settings exposed: EPG prefetch concurrency, cache age limit (hours), EPG historic filter (days).
- Global scope (one setting value shared across all accounts).
- Persistence in IndexedDB via a new `settings` object store.
- Pure data module `lib/settings.js` with sync `get()` / async `set()` API.
- Wiring of consumer sites to read from the new module.
- Unit tests for the settings module and IDB migration.

**Out of scope (v1):**
- Per-account settings overrides.
- Live re-apply of changed values (e.g. mid-sync concurrency change). Consumers read at point of use; existing in-flight operations are not cancelled.
- Search/filter, profiles, import/export of settings.
- Settings change history, audit log.
- UI for EPG prefetch timeout, parse worker timeout, or any other value (deferred to v2 if requested).
- Reset to defaults confirmation dialog (button is unconfirmed; closes modal with defaults populated, user must click Save).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│  Main process (main.js)                             │
│  └─ Settings menu → IPC 'open-settings' → renderer │
└─────────────────────────────────────────────────────┘
                       │ IPC
                       ▼
┌─────────────────────────────────────────────────────┐
│  Renderer (index.html)                              │
│  ├─ new <div id="settings-modal">                   │
│  ├─ preload.js: ipcRenderer.on('open-settings', fn) │
│  ├─ lib/settings.js                                  │
│  │    ├─ AppSettings.load()      (startup, IDB→cache)│
│  │    ├─ AppSettings.get(k, def)  (sync)             │
│  │    ├─ AppSettings.set(k, v)    (IDB write+cache)  │
│  │    └─ AppSettings.onChange(fn)                    │
│  └─ renderer-settings.js: openSettingsModal()       │
│       (form, inputs, save/reset wiring)              │
└─────────────────────────────────────────────────────┘
                       │
                       ▼ consumers
┌─────────────────────────────────────────────────────┐
│  Consumer sites (read at point of use):             │
│  ├─ renderer-epg.js:51  → get('epgPrefetchConcurrency', 4) │
│  ├─ renderer-xtream.js:335 → get('cacheAgeLimitHours', 24) │
│  └─ db.js saveEpg/mergeChannelEpg                    │
│     → get('epgHistoricFilterDays', 7)               │
└─────────────────────────────────────────────────────┘
```

**Module boundaries:**
- `lib/settings.js` — pure data layer. No DOM. IDB-only via `IPTVDb`. Exposes `AppSettings` as a window global in the renderer and a CommonJS export for tests.
- `renderer-settings.js` — DOM/form layer. Reads/writes via `AppSettings`. No direct IDB access.
- `index.html` — modal markup, script tags.
- `main.js` — menu definition, IPC send.
- `preload.js` — IPC receive bridge.

**Why global scope, not per-account:** v1 explicitly scoped global. Per-account overrides are a v2 feature; out of scope here.

**Why IDB, not localStorage:** Consistent with existing pattern (db.js already manages account/category/stream/EPG caches in IDB). Settings benefit from the same atomicity and migration tooling. Adds one object store via v3→v4 migration.

**Why in-memory cache + sync `get()`:** Consumers are synchronous call sites in non-async paths (e.g. `db.js saveEpg`). Async-on-every-read would force callers to plumb `await` everywhere. Cache is populated once at startup and updated synchronously on `set()`.

---

## 3. Data Model

### IndexedDB migration: v3 → v4

`db.js` `open()` `onupgradeneeded` block adds:
```js
if (oldVersion < 4) {
  if (!db.objectStoreNames.contains('settings')) {
    db.createObjectStore('settings', { keyPath: 'key' });
  }
}
```

Existing v3 stores are untouched. Backwards-compatible on first launch (creates empty `settings` store).

### Settings schema (v1)

| Key | Type | Default | Min | Max | Step | Consumer |
|-----|------|---------|-----|-----|------|----------|
| `epgPrefetchConcurrency` | int | 4 | 1 | 10 | 1 | `renderer-epg.js:51` (currently hardcoded `4`) |
| `cacheAgeLimitHours` | int | 24 | 1 | 168 | 1 | `renderer-xtream.js:335` (currently `24 * 60 * 60 * 1000`) |
| `epgHistoricFilterDays` | int | 7 | 1 | 30 | 1 | `db.js` `saveEpg` and `mergeChannelEpg` (currently `7 * 86400`) |

Each stored as `{key: 'epgPrefetchConcurrency', value: 4}` in the `settings` store. Unknown keys in the store are ignored on `load()`.

### `lib/settings.js` API

```js
const SCHEMA = {
  epgPrefetchConcurrency: { type: 'int', min: 1, max: 10, default: 4 },
  cacheAgeLimitHours:     { type: 'int', min: 1, max: 168, default: 24 },
  epgHistoricFilterDays:  { type: 'int', min: 1, max: 30,  default: 7 },
};

const AppSettings = {
  _cache: null,         // { key: value } once loaded; null until load() resolves
  _loadPromise: null,   // memoized load promise
  _listeners: [],       // change subscribers

  // Async, idempotent. Resolves when _cache is populated.
  // On IDB failure: log warning, _cache = {}, resolves anyway.
  load(): Promise<void>,

  // Sync. Returns cached value or defaultValue (or schema default if defaultValue omitted).
  // Throws if called before load() resolved.
  get(key: string, defaultValue?: number): number,

  // Async. Validates against SCHEMA. Writes IDB. Updates _cache. Fires listeners.
  // Throws on validation failure.
  set(key: string, value: number): Promise<void>,

  // Subscribe to changes. Returns unsubscribe function.
  onChange(fn: (key, value) => void): () => void,
};
```

**Validation rules** (applied in `set()`):
- Key must exist in `SCHEMA` (else throw `Error('unknown setting key')`).
- Value must be a finite integer (else throw `TypeError`).
- Value must satisfy `SCHEMA[key].min ≤ value ≤ SCHEMA[key].max` (else throw `RangeError`).

**CommonJS + window export pattern** (matches `lib/epg-prefetch.js` precedent):
```js
if (typeof module !== 'undefined' && module.exports) module.exports = { AppSettings };
if (typeof window !== 'undefined') window.AppSettings = AppSettings;
```

---

## 4. UI

### Application menu (main.js)

Add a new top-level menu before `View`:
```js
{
  label: 'Settings',
  submenu: [
    {
      label: 'Preferences...',
      accelerator: 'CmdOrCtrl+,',
      click: () => { if (mainWindow) mainWindow.webContents.send('open-settings'); }
    }
  ]
}
```

### IPC bridge (preload.js)

Expose to renderer:
```js
contextBridge.exposeInMainWorld('electronAPI', {
  // ... existing
  onOpenSettings: (fn) => ipcRenderer.on('open-settings', () => fn()),
});
```

### Modal markup (index.html)

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

### Form behavior (`renderer-settings.js`)

`openSettingsModal()`:
1. Read each value via `AppSettings.get(key)`. Populate `#set-concurrency`, `#set-cache`, `#set-historic`.
2. Show modal (`style.display = 'flex'`).
3. Bind `btn-close-settings` → hide modal (no save).
4. Bind `btn-reset-settings` → set each input to `SCHEMA[key].default`. Do NOT auto-save; user must click Save.
5. Bind `btn-save-settings` → for each input: parse integer, validate against `SCHEMA[key].min/max`, on success `AppSettings.set(key, value)`. On any validation failure, show inline red border + small error text under the offending input and abort save. On full success, hide modal.

**No auto-save on input change.** Explicit Save button only. Cancel via close button or Esc key (`keydown` listener on the modal: `Escape` → close).

**No reset confirmation.** Reset button just populates defaults into the form; user reviews and clicks Save.

### Script tag order (index.html)

`<script src="lib/settings.js">` MUST load before `<script src="renderer-settings.js">` (settings module must be a global before form code parses).

---

## 5. Consumer Wiring

Replace hardcoded values at point of use with `AppSettings.get(key)`:

| File:Line | Before | After |
|-----------|--------|-------|
| `renderer-epg.js:51` | `concurrency: 4,` | `concurrency: AppSettings.get('epgPrefetchConcurrency', 4),` |
| `renderer-epg.js:52` | `perFetchTimeoutMs: 15000` | unchanged in v1 (not exposed) |
| `renderer-xtream.js:335` | `const cacheAgeLimit = 24 * 60 * 60 * 1000;` | `const cacheAgeLimit = AppSettings.get('cacheAgeLimitHours', 24) * 60 * 60 * 1000;` |
| `db.js saveEpg` (line ~280) | `const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;` | `const cutoff = Math.floor(Date.now() / 1000) - AppSettings.get('epgHistoricFilterDays', 7) * 86400;` |
| `db.js mergeChannelEpg` (line ~370) | same as above | same as above |

**In-flight operations note:** A prefetch sync that has already started will continue with the value it captured at start. New syncs (next manual sync, next app launch) pick up the new value. This matches "read at point of use" semantics and avoids cancelling in-progress network work.

**`db.js` consumer caveat:** `db.js` is currently loaded in the renderer before `lib/settings.js` (script tag order). After this change, `db.js` must NOT call `AppSettings.get()` at module-load time — only inside the methods that need it. Since `saveEpg`/`mergeChannelEpg` are called well after `AppSettings.load()` resolves during sync, this is naturally satisfied.

---

## 6. Error Handling

| Failure | Behavior |
|---------|----------|
| IDB `load()` rejects (corrupt DB, schema mismatch) | `console.warn`, `_cache = {}`, resolve anyway. Consumers fall back to schema defaults. |
| IDB `set()` rejects (quota, transaction error) | `console.error`, throw to caller. Renderer-settings catches, shows inline error, modal stays open, cache not updated. |
| `get()` called before `load()` resolved | Throw `Error('AppSettings not loaded — call load() first')`. Programmer error, never user-facing. |
| User enters non-integer (e.g. "abc") | `parseInt` returns `NaN` → treated as validation failure → inline error. |
| User enters out-of-range | Inline error with min/max hint. Save button does nothing. |
| App closed during `set()` | IDB transaction auto-aborts. Cache reflects last successful set. On next launch, `load()` re-reads the (possibly stale) stored value. |
| Unknown key in stored `settings` row | Ignored on `load()`. No warning logged (forward-compat with new settings added in future versions). |

---

## 7. Testing

### `test/settings.test.js` (new)

Uses `fake-indexeddb/auto` (already installed in Task 1 of EPG prefetch refactor). Pattern matches existing `test/db.test.js` (delete database between tests).

Tests:
1. `load()` populates cache from IDB.
2. `load()` is idempotent (second call returns same promise, no second IDB read).
3. `load()` on empty store resolves with empty cache; `get()` returns schema default.
4. `get()` with explicit defaultValue returns it when key missing.
5. `set()` writes to IDB and updates cache.
6. `set()` rejects on unknown key.
7. `set()` rejects on non-integer.
8. `set()` rejects on value below min.
9. `set()` rejects on value above max.
10. `onChange` listener fires on `set()` with key + new value.
11. `onChange` returns unsubscribe that prevents further callbacks.
12. `get()` before `load()` throws.

### `test/db.test.js` (extend)

Add test: opening with `dbVersion: 4` creates the `settings` store. Optionally test that v3 → v4 migration adds the store (set up v3, close, re-open with v4, verify store exists).

### Manual verification

1. Fresh install: open app → menu → Preferences → all fields show defaults (4, 24, 7).
2. Change concurrency to 8 → Save → restart app → reopen Preferences → field shows 8.
3. Reset to defaults → Save → restart → fields show 4, 24, 7.
4. Enter 999 in concurrency field → click Save → red error appears, modal stays open, no write to IDB.
5. Sync an account → confirm the new prefetch concurrency is used (check console for `concurrency: 8` if changed, or whatever value).
6. Check IndexedDB in DevTools → `settings` object store contains 3 rows with the saved values.

---

## 8. Files Touched

| File | Action | Purpose |
|------|--------|---------|
| `db.js` | modify | v3→v4 migration; new `_idbGetAll(storeName)` helper for settings load; consumer wiring for `epgHistoricFilterDays` |
| `lib/settings.js` | NEW | `AppSettings` module |
| `renderer-settings.js` | NEW | Modal open/close/save/reset logic |
| `renderer.js` | modify | Call `AppSettings.load()` after `IPTVDb.open()` on startup; consumer wiring for `cacheAgeLimitHours` |
| `renderer-epg.js` | modify | Consumer wiring for `epgPrefetchConcurrency` |
| `index.html` | modify | Modal markup, script tags for `lib/settings.js` and `renderer-settings.js` |
| `main.js` | modify | New Settings menu with Preferences item + accelerator |
| `preload.js` | modify | Expose `onOpenSettings` IPC bridge |
| `test/settings.test.js` | NEW | Unit tests for `AppSettings` |
| `test/db.test.js` | modify | Add v3→v4 migration test |
| `package.json` | modify | No new deps; verify `lib/**/*` already in `build.files` (it is) |

**`style.css` consideration:** New modal can reuse existing `.modal-overlay`, `.modal-card`, `.form-group`, `.form-actions-row`, `.btn`, `.btn-primary`, `.btn-secondary` classes. Add `.form-hint` and `.form-error` classes if not present. If absent, add minimal rules (see Section 9).

---

## 9. Style additions (if needed)

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
  color: var(--danger-color, #ff453a);
}
input.invalid {
  border-color: var(--danger-color, #ff453a);
}
```

These follow the existing glassmorphism / cyberpunk style already defined in `style.css`. If `.form-hint` already exists (e.g. for the accounts form), reuse it.

---

## 10. Open Questions

None for v1. All scope decisions resolved during brainstorming.

---

## 11. Self-Review

- **Placeholder scan:** No "TBD" / "TODO" in spec. All sections complete.
- **Internal consistency:** Architecture, data model, UI, and consumer wiring all reference the same three settings with the same keys, types, defaults, and ranges.
- **Scope check:** Single feature, single spec, single plan. No decomposition needed.
- **Ambiguity check:** All values have explicit types, ranges, defaults. Menu accelerator is specified. Migration version is specified. Test counts are specified.
- **Script tag order:** Explicitly called out in Section 4 to avoid the precedent bug (epg-prefetch must load before renderer-epg).
- **db.js load order:** Section 5 explicitly addresses that `AppSettings.get()` must not be called at module-load time.
