/**
 * AppSettings — global user settings with IDB persistence.
 *
 * Pure data layer. No DOM, no Electron. Holds an in-memory cache populated
 * once on app startup via load(); consumers use sync get() at point of use.
 *
 * Dual export: CommonJS for tests, window global for renderer.
 */

const ABSOLUTE_PATH_RE = /^(?:\/|\\\\[^\\/]|[a-zA-Z]:[\\/])/;

function isValidDownloadDir(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.includes('\0')) return false;
  return ABSOLUTE_PATH_RE.test(trimmed);
}

const SCHEMA = {
  epgPrefetchConcurrency:    { type: 'int', min: 1, max: 10, default: 4 },
  cacheAgeLimitHours:        { type: 'int', min: 1, max: 168, default: 24 },
  epgHistoricFilterDays:     { type: 'int', min: 1, max: 30,  default: 7 },
  downloadDir:               { type: 'string', absolutePath: true, default: '' },
  downloadFolderStructure:   { type: 'enum', values: ['structured', 'flat'], default: 'structured' },
  downloadDefaultPreset:     { type: 'enum', values: ['hevc', 'h264', 'remux', 'original'], default: 'hevc' },
  downloadDefaultResolution: { type: 'enum', values: ['original', '1080p', '720p'], default: '1080p' },
  downloadClickAction:       { type: 'enum', values: ['dialog', 'instant'], default: 'dialog' },
  downloadDuplicateAction:   { type: 'enum', values: ['ask', 'skip', 'rename', 'overwrite'], default: 'ask' },
  downloadHwAccel:           { type: 'string', pattern: /^(auto|cpu|\/dev\/dri\/renderD\d+)$/, default: 'auto' },
};

function validateInt(key, entry, value) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`setting ${key} must be an integer, got ${typeof value}: ${value}`);
  }
  if (value < entry.min || value > entry.max) {
    throw new RangeError(`setting ${key} out of range [${entry.min}, ${entry.max}]: ${value}`);
  }
  return value;
}

function validateString(key, entry, value) {
  if (typeof value !== 'string') {
    throw new TypeError(`setting ${key} must be a string, got ${typeof value}: ${value}`);
  }
  if (entry.type === 'enum' && !entry.values.includes(value)) {
    throw new RangeError(`setting ${key} must be one of [${entry.values.join(', ')}]: ${value}`);
  }
  if (entry.absolutePath) {
    const trimmed = value.trim();
    if (!isValidDownloadDir(trimmed)) {
      throw new RangeError(`setting ${key} must be empty or an absolute path: ${value}`);
    }
    return trimmed;
  }
  if (entry.type === 'string' && entry.pattern && !entry.pattern.test(value)) {
    throw new RangeError(`setting ${key} does not match pattern ${entry.pattern}: ${value}`);
  }
  return value;
}

function validate(key, value) {
  const entry = SCHEMA[key];
  if (!entry) throw new Error(`unknown setting key: ${key}`);
  if (entry.type === 'int') return validateInt(key, entry, value);
  if (entry.type === 'enum' || entry.type === 'string') return validateString(key, entry, value);
  throw new Error(`unsupported setting type: ${entry.type}`);
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
    const normalized = validate(key, value);
    if (this._cache === null) {
      throw new Error('AppSettings not loaded — call load() first');
    }
    await globalThis.IPTVDb._idbPut('settings', { key, value: normalized });
    this._cache[key] = normalized;
    for (const fn of this._listeners.slice()) {
      try { fn(key, normalized); } catch (_) { /* swallow */ }
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
