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
        const rows = await globalThis.IPTVDb._idbGetAll('settings');
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
    await globalThis.IPTVDb._idbPut('settings', { key, value });
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
  module.exports = { AppSettings, SCHEMA };
}
if (typeof window !== 'undefined') {
  window.AppSettings = AppSettings;
  window.AppSettingsSchema = SCHEMA;
}
