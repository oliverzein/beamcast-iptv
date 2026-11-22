/**
 * Settings modal — open/close/save/reset logic.
 * Reads/writes via window.AppSettings. No direct IDB access.
 */

const INPUT_ID_MAP = {
  epgPrefetchConcurrency: 'set-concurrency',
  cacheAgeLimitHours: 'set-cache',
  epgHistoricFilterDays: 'set-historic',
  downloadDir: 'set-download-dir',
  downloadFolderStructure: 'set-download-structure',
  downloadDefaultPreset: 'set-download-preset',
  downloadDefaultResolution: 'set-download-resolution',
  downloadClickAction: 'set-download-click-action',
  downloadDuplicateAction: 'set-download-duplicate',
  downloadHwAccel: 'set-download-hwaccel',
};

// Schema derivation — the single source of truth is window.AppSettingsSchema
// (exported from lib/settings.js). We just attach the input element ID for the form.
function inputIdForKey(key) {
  return INPUT_ID_MAP[key];
}

const FORM_SCHEMA = Object.fromEntries(
  Object.entries(window.AppSettingsSchema).map(([key, meta]) => [
    key,
    { ...meta, el: inputIdForKey(key) }
  ])
);

const modal = () => document.getElementById('settings-modal');
let cachedDefaultDownloadDir = '';

function normalizeDirPath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed;
}

async function resolveDefaultDownloadDir() {
  if (typeof window === 'undefined' || !window.electronAPI?.getDefaultDownloadDir) {
    return cachedDefaultDownloadDir;
  }
  try {
    const dir = await window.electronAPI.getDefaultDownloadDir();
    if (typeof dir === 'string' && dir.trim()) {
      cachedDefaultDownloadDir = dir.trim();
    }
  } catch (err) {
    console.warn('[Settings] getDefaultDownloadDir failed:', err && err.message);
  }
  return cachedDefaultDownloadDir;
}

function populateDownloadDirField(input, savedDir, defaultDir) {
  if (!input) return;
  if (defaultDir) input.placeholder = defaultDir;
  input.value = savedDir ? savedDir : (defaultDir || '');
}

function removeDynamicOptions(select) {
  for (const opt of Array.from(select.options)) {
    if (opt.dataset.dynamic === 'true') opt.remove();
  }
}

function hasSelectOption(select, value) {
  return Array.from(select.options).some((opt) => opt.value === value);
}

function appendDynamicOption(select, value, label) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  opt.dataset.dynamic = 'true';
  select.appendChild(opt);
}

async function populateHwAccelOptions(select, savedValue) {
  if (!select) return;
  removeDynamicOptions(select);

  let devices = [];
  if (typeof window !== 'undefined' && window.electronAPI?.listVaapiDevices) {
    try {
      const result = await window.electronAPI.listVaapiDevices();
      if (Array.isArray(result)) devices = result;
    } catch (err) {
      console.warn('[Settings] listVaapiDevices failed:', err && err.message);
    }
  }

  for (const dev of devices) {
    if (!dev || typeof dev.path !== 'string' || !dev.path) continue;
    if (!hasSelectOption(select, dev.path)) {
      appendDynamicOption(select, dev.path, dev.label || dev.path);
    }
  }

  if (savedValue && !hasSelectOption(select, savedValue)) {
    appendDynamicOption(select, savedValue, `${savedValue} (nicht verbunden)`);
  }

  select.value = savedValue || 'auto';
}

async function openSettingsModal() {
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

  const savedDir = AppSettings.get('downloadDir', FORM_SCHEMA.downloadDir?.default ?? '');
  const savedHwAccel = AppSettings.get('downloadHwAccel', FORM_SCHEMA.downloadHwAccel?.default ?? 'auto');
  const dirInput = document.getElementById(FORM_SCHEMA.downloadDir?.el);
  const hwSelect = document.getElementById(FORM_SCHEMA.downloadHwAccel?.el);

  const [defaultDir] = await Promise.all([
    resolveDefaultDownloadDir(),
    populateHwAccelOptions(hwSelect, savedHwAccel),
  ]);
  populateDownloadDirField(dirInput, savedDir, defaultDir);

  const m = modal();
  if (m) m.style.display = 'flex';
}

function closeSettingsModal() {
  const m = modal();
  if (m) m.style.display = 'none';
}

function getErrorContainer(input) {
  if (!input) return null;
  return (typeof input.closest === 'function' && input.closest('.form-group')) || input.parentElement;
}

function setError(input, message) {
  if (!input) return;
  input.classList.add('invalid');
  const container = getErrorContainer(input);
  if (!container) return;
  let err = container.querySelector('.form-error');
  if (!err) {
    err = document.createElement('small');
    err.className = 'form-error';
    container.appendChild(err);
  }
  err.textContent = message;
}

function clearError(input) {
  if (!input) return;
  input.classList.remove('invalid');
  const container = getErrorContainer(input);
  const err = container ? container.querySelector('.form-error') : null;
  if (err) err.textContent = '';
}

function validateIntValue(meta, raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(raw).trim()) {
    return { ok: false, error: `Must be an integer between ${meta.min} and ${meta.max}` };
  }
  if (parsed < meta.min || parsed > meta.max) {
    return { ok: false, error: `Must be between ${meta.min} and ${meta.max}` };
  }
  return { ok: true, value: parsed };
}

function validateSettingValue(key, meta, raw, defaultDir) {
  if (meta.type === 'int') return validateIntValue(meta, raw);

  if (meta.type === 'enum') {
    const val = String(raw ?? '');
    if (!Array.isArray(meta.values) || !meta.values.includes(val)) {
      return { ok: false, error: 'Invalid selection' };
    }
    return { ok: true, value: val };
  }

  if (meta.type === 'string') {
    if (key === 'downloadDir') {
      const trimmed = String(raw ?? '').trim();
      if (!trimmed || (defaultDir && normalizeDirPath(trimmed) === normalizeDirPath(defaultDir))) {
        return { ok: true, value: '' };
      }
      return { ok: true, value: trimmed };
    }
    const val = String(raw ?? '');
    if (meta.pattern && !meta.pattern.test(val)) {
      return { ok: false, error: 'Invalid format' };
    }
    return { ok: true, value: val };
  }

  return { ok: false, error: 'Unsupported setting type' };
}

async function saveSettings() {
  const defaultDir = cachedDefaultDownloadDir || (await resolveDefaultDownloadDir());
  let allOk = true;

  for (const [key, meta] of Object.entries(FORM_SCHEMA)) {
    const input = document.getElementById(meta.el);
    clearError(input);
    const raw = input ? input.value : '';
    const check = validateSettingValue(key, meta, raw, defaultDir);
    if (!check.ok) {
      setError(input, check.error);
      allOk = false;
      continue;
    }
    try {
      await AppSettings.set(key, check.value);
    } catch (err) {
      setError(input, (err && err.message) || 'Save failed');
      allOk = false;
    }
  }

  if (allOk) closeSettingsModal();
}

function resetSettings() {
  for (const [key, meta] of Object.entries(FORM_SCHEMA)) {
    const input = document.getElementById(meta.el);
    if (input) {
      if (key === 'downloadDir') {
        if (cachedDefaultDownloadDir) input.placeholder = cachedDefaultDownloadDir;
        input.value = cachedDefaultDownloadDir || '';
      } else {
        input.value = meta.default;
      }
    }
    clearError(input);
  }
}

async function handleBrowseDownloadDir() {
  const input = document.getElementById(FORM_SCHEMA.downloadDir?.el || 'set-download-dir');
  if (!input || !window.electronAPI?.selectDownloadDir) return;
  try {
    const selected = await window.electronAPI.selectDownloadDir(input.value.trim());
    if (typeof selected === 'string' && selected.trim()) {
      input.value = selected;
      clearError(input);
    }
  } catch (err) {
    console.error('[Settings] selectDownloadDir failed:', err && err.message);
  }
}

// Wire up handlers once DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-close-settings')?.addEventListener('click', closeSettingsModal);
  document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);
  document.getElementById('btn-reset-settings')?.addEventListener('click', resetSettings);
  document.getElementById('btn-browse-download-dir')?.addEventListener('click', handleBrowseDownloadDir);

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
