/**
 * Kengo InMail Helper — Apps Script proxy (standalone variant)
 *
 * SETUP (one-time):
 *  1. Go to script.new in a browser (creates a new Apps Script project).
 *  2. Replace the default Code.gs content with this entire file.
 *  3. Set SHEET_ID below to your Google Sheet's ID (the long string from the
 *     sheet URL between /d/ and /edit).
 *  4. Replace SECRET_TOKEN with a random string. Same value goes into the
 *     extension's Settings page later. Treat it like a password.
 *  5. (Optional) If your tab is not named "Outreach", change SHEET_NAME.
 *  6. Save (Cmd-S / Ctrl-S).
 *  7. Click Deploy → New deployment.
 *  8. Gear icon → Web app.
 *  9. Description: "Kengo InMail proxy".
 *     Execute as: "Me (your-email@gmail.com)".
 *     Who has access: "Anyone".  ← required so the extension can hit it.
 *     (The SECRET_TOKEN gates actual access — public access without the token
 *     gets a `forbidden` response.)
 * 10. Deploy → Authorize (your script reading your sheet — trust it).
 * 11. Copy the Web app URL: https://script.google.com/macros/s/AKfy.../exec
 * 12. Paste URL + SECRET_TOKEN into the extension's Settings page.
 *
 * To update later: Deploy → Manage deployments → pencil ✏️ → Version: New
 * version → Deploy. URL stays the same.
 */

const SHEET_ID = 'REPLACE_WITH_YOUR_SHEET_ID';
const SECRET_TOKEN = 'REPLACE_ME_WITH_A_RANDOM_STRING';
const SHEET_NAME = 'Outreach';
const COLUMN_RANGE = 'A:T'; // Columns A through T = 20 columns total

function openSheet_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function doGet(e) {
  try {
    if (!validateToken(e)) return forbidden();
    const action = (e.parameter.action || '').toLowerCase();
    if (action === 'ping') return ok({ ok: true, sheetName: SHEET_NAME });
    if (action === 'read') return ok(readRow_(parseInt(e.parameter.row, 10)));
    if (action === 'range') {
      return ok(readRange_(
        parseInt(e.parameter.start, 10),
        parseInt(e.parameter.end, 10)
      ));
    }
    return ok({ ok: false, error: 'unknown_action: ' + action });
  } catch (err) {
    return ok({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    let body = {};
    try { body = JSON.parse(e.postData && e.postData.contents || '{}'); }
    catch (_err) { body = {}; }
    // Token may come via query (preferred — survives no-cors) or body.
    const token = (e.parameter && e.parameter.token) || body.token;
    if (token !== SECRET_TOKEN) return forbidden();
    const action = (body.action || '').toLowerCase();
    if (action === 'write') {
      return ok(writeStatus_(
        parseInt(body.row, 10),
        String(body.status || ''),
        String(body.date || '')
      ));
    }
    return ok({ ok: false, error: 'unknown_action: ' + action });
  } catch (err) {
    return ok({ ok: false, error: String(err && err.message || err) });
  }
}

function validateToken(e) {
  return e && e.parameter && e.parameter.token === SECRET_TOKEN;
}

function readRow_(row) {
  if (!Number.isFinite(row) || row < 1) {
    return { ok: false, error: 'invalid_row' };
  }
  const sheet = openSheet_().getSheetByName(SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found:' + SHEET_NAME };
  const values = sheet.getRange('A' + row + ':T' + row).getValues();
  return { ok: true, values: values[0] || [] };
}

function readRange_(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
    return { ok: false, error: 'invalid_range' };
  }
  const sheet = openSheet_().getSheetByName(SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found:' + SHEET_NAME };
  const rows = sheet.getRange('A' + start + ':T' + end).getValues();
  return { ok: true, start: start, end: end, rows: rows };
}

function writeStatus_(row, status, date) {
  if (!Number.isFinite(row) || row < 1) {
    return { ok: false, error: 'invalid_row' };
  }
  const sheet = openSheet_().getSheetByName(SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found:' + SHEET_NAME };
  sheet.getRange('Q' + row + ':R' + row).setValues([[status, date]]);
  return { ok: true, row: row };
}

function ok(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function forbidden() {
  return ok({ ok: false, error: 'forbidden' });
}
