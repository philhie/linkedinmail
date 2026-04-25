// @ts-check
import { loadSettings, saveSettings, SETTINGS_DEFAULTS } from '../lib/state.js';
import { friendlyError } from '../lib/errors.js';

const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const settings = await loadSettings();
  $('sheet-id').value = settings.sheetId || '';
  $('apps-script-url').value = settings.appsScriptUrl || '';
  $('apps-script-token').value = settings.appsScriptToken || '';
  $('inmail-subject').value = settings.inmailSubject ?? SETTINGS_DEFAULTS.inmailSubject;
  $('daily-target').value = String(settings.dailyTarget ?? SETTINGS_DEFAULTS.dailyTarget);
  $('start-row').value = String(settings.startRow ?? SETTINGS_DEFAULTS.startRow);
  $('min-interval').value = String(settings.minIntervalSeconds ?? SETTINGS_DEFAULTS.minIntervalSeconds);

  document.getElementById('settings-form')?.addEventListener('submit', onSave);
  document.getElementById('test-btn')?.addEventListener('click', onTest);
}

function readForm() {
  return {
    sheetId: $('sheet-id').value.trim(),
    appsScriptUrl: $('apps-script-url').value.trim(),
    appsScriptToken: $('apps-script-token').value.trim(),
    inmailSubject: ($('inmail-subject').value || SETTINGS_DEFAULTS.inmailSubject).slice(0, 200),
    dailyTarget: clampInt($('daily-target').value, 1, 1000, SETTINGS_DEFAULTS.dailyTarget),
    startRow: clampInt($('start-row').value, 2, 100000, SETTINGS_DEFAULTS.startRow),
    minIntervalSeconds: clampInt($('min-interval').value, 0, 600, SETTINGS_DEFAULTS.minIntervalSeconds)
  };
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** @param {SubmitEvent} e */
async function onSave(e) {
  e.preventDefault();
  const settings = readForm();
  await saveSettings(settings);
  await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
  showResult('save-result', 'ok', '✓ Saved.');
}

async function onTest() {
  // Save first so the SW reads the latest values.
  const settings = readForm();
  await saveSettings(settings);
  showResult('test-result', 'busy', 'Pinging Apps Script…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'PING_SHEET' });
    if (res && res.ok) {
      showResult('test-result', 'ok', `✓ Connected to "${res.sheetName}".`);
    } else {
      showResult('test-result', 'bad', `✗ ${friendlyError((res && res.error) || 'unknown')}`);
    }
  } catch (err) {
    showResult('test-result', 'bad', `✗ ${String(err && err.message || err)}`);
  }
}

function showResult(id, kind, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
  el.className = `test-result ${kind}`;
  el.textContent = text;
}

