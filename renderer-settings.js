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
