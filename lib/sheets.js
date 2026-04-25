// @ts-check
import { parseRow } from './lead.js';

/**
 * Apps Script Web App proxy client.
 *
 * The proxy is deployed by the user (see apps-script/Code.gs).
 * All requests carry a shared `token` query param that the proxy validates.
 */

const RETRY_DELAYS_MS = [500, 2000];

/** @typedef {{appsScriptUrl?: string, appsScriptToken?: string}} SheetsSettings */

/** @param {SheetsSettings} settings */
function requireSettings(settings) {
  if (!settings.appsScriptUrl) throw new Error('missing_apps_script_url');
  if (!settings.appsScriptToken) throw new Error('missing_apps_script_token');
}

/**
 * @param {SheetsSettings} settings
 * @param {URLSearchParams} params
 */
function buildGetUrl(settings, params) {
  params.set('token', /** @type {string} */ (settings.appsScriptToken));
  const sep = (settings.appsScriptUrl || '').includes('?') ? '&' : '?';
  return `${settings.appsScriptUrl}${sep}${params.toString()}`;
}

async function fetchJsonWithRetry(url, init) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500) throw new Error(`http_${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); }
      catch (_e) { throw new Error('non_json_response'); }
    } catch (err) {
      lastErr = err;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch_failed');
}

/**
 * @param {SheetsSettings} settings
 * @param {number} row
 */
export async function readRow(settings, row) {
  requireSettings(settings);
  const url = buildGetUrl(settings, new URLSearchParams({ action: 'read', row: String(row) }));
  const json = await fetchJsonWithRetry(url);
  if (!json.ok) throw new Error(json.error || 'read_failed');
  return parseRow(json.values || [], row);
}

/**
 * @param {SheetsSettings} settings
 * @param {number} start
 * @param {number} end
 */
export async function readRange(settings, start, end) {
  requireSettings(settings);
  const url = buildGetUrl(settings, new URLSearchParams({
    action: 'range',
    start: String(start),
    end: String(end)
  }));
  const json = await fetchJsonWithRetry(url);
  if (!json.ok) throw new Error(json.error || 'range_failed');
  const rows = Array.isArray(json.rows) ? json.rows : [];
  return rows.map((values, i) => parseRow(values, start + i));
}

/**
 * @param {SheetsSettings} settings
 * @param {number} row
 * @param {string} status
 * @param {string} date
 */
export async function writeStatus(settings, row, status, date) {
  requireSettings(settings);
  // Use POST. Send token via both query and body for robustness.
  const url = buildGetUrl(settings, new URLSearchParams({ action: 'write' }));
  const json = await fetchJsonWithRetry(url, {
    method: 'POST',
    body: JSON.stringify({
      action: 'write',
      row,
      status,
      date,
      token: settings.appsScriptToken
    })
    // Apps Script /exec requires no Content-Type header — adding one triggers
    // a CORS preflight that Apps Script does not handle. Send raw text body.
  });
  if (!json.ok) throw new Error(json.error || 'write_failed');
  return json;
}

/** @param {SheetsSettings} settings */
export async function ping(settings) {
  requireSettings(settings);
  const url = buildGetUrl(settings, new URLSearchParams({ action: 'ping' }));
  const json = await fetchJsonWithRetry(url);
  if (!json.ok) throw new Error(json.error || 'ping_failed');
  return json;
}
