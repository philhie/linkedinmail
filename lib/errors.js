// @ts-check

/**
 * Error/status code → human-readable string.
 * Pure function so it can be unit-tested without a DOM.
 *
 * @param {string} code
 * @returns {string}
 */
export function friendlyError(code) {
  if (typeof code !== 'string' || !code) return '';

  if (code.startsWith('rate_limited:')) {
    const waitSec = code.split(':')[1];
    return `Rate limited — wait ${waitSec}s before opening the next profile.`;
  }
  if (code.startsWith('content_message_failed:')) {
    return 'LinkedIn tab did not respond. Reload the LinkedIn page and try again.';
  }
  if (code.startsWith('mark_sent_write_failed:')) {
    const m = code.match(/row_(\d+)/);
    const row = m ? m[1] : '?';
    return `Couldn't write "gesendet" to row ${row}. The lead was advanced but the sheet was not updated — fix manually or click Mark Sent again on that row.`;
  }
  if (code.startsWith('pending_writes:')) {
    const n = code.split(':')[1] || '?';
    return `${n} sheet update(s) pending — will retry automatically. Keep the popup open or reopen it to nudge.`;
  }

  switch (code) {
    case 'not_configured':                 return 'Open Settings and add your Apps Script URL + token.';
    case 'missing_apps_script_url':        return 'Apps Script URL is missing. Open Settings.';
    case 'missing_apps_script_token':      return 'Apps Script token is missing. Open Settings.';
    case 'forbidden':                      return 'The Apps Script rejected the token. Verify it matches Settings.';
    case 'sheet_not_found:Outreach':       return 'No tab named "Outreach" in your sheet. Rename the tab or update Code.gs.';
    case 'daily_target_reached':           return 'Daily target reached. Use "Extend by 25" or come back tomorrow.';
    case 'invalid_row':                    return 'Invalid row number.';
    case 'no_lead':                        return 'No lead loaded yet.';
    case 'no_linkedin_url':                return 'This lead has no LinkedIn URL. Skip or fix the sheet.';
    case 'tab_create_failed':              return 'Could not open a new tab.';
    case 'content_script_unreachable':     return 'LinkedIn page did not load the helper. Make sure you are at linkedin.com/in/... or /talent/profile/... and reload.';
    case 'session_expired':                return 'LinkedIn session expired. Open LinkedIn and log in.';
    case 'recruiter_link_not_found':       return '"In Recruiter anzeigen" link not found on the profile. The lead may not be visible to your Recruiter seat, or LinkedIn DOM changed.';
    case 'recruiter_link_no_href':         return '"In Recruiter anzeigen" link has no href. Page may not be fully loaded — try again.';
    case 'recruiter_message_button_not_found': return 'Recruiter Message/InMail button not found. The DOM may have changed — see content/linkedin.js.';
    case 'composer_body_editor_not_found': return 'Composer body editor not found. LinkedIn may be slow or DOM changed.';
    case 'add_follow_up_button_not_found': return '"Folgenachricht hinzufügen" button not found. The DOM may have changed.';
    case 'follow_up_editor_not_found':     return 'Follow-up editor did not appear after clicking Add follow-up.';
    case 'fill_failed':                    return 'Filling the InMail failed. Check the LinkedIn tab.';
    case 'wrong_tab':                      return 'Pending fill belongs to a different tab. Ignored to avoid mis-filling.';
    case 'wrong_url':                      return 'Tab URL does not match the lead Phil opened. Fill skipped to avoid mis-filling.';
    case 'no_response_from_service_worker':return 'Background worker did not respond. Reload the popup, or reload the extension at chrome://extensions.';
    case 'offline':                        return 'Offline — using cached lead. Sheet updates are paused.';
    case 'non_json_response':              return 'Apps Script did not return JSON. Make sure the deployment is active and "Who has access" is "Anyone".';
    case 'http_500':                       return 'Apps Script returned 500. Check the Apps Script execution log.';
    default:                               return code;
  }
}

/**
 * Stage label for the pending-fill banner.
 * @param {string} stage
 */
export function humanStage(stage) {
  switch (stage) {
    case 'await_recruiter': return 'opening profile…';
    case 'await_composer':  return 'opening composer…';
    case 'done':            return 'done';
    default:                return stage || '';
  }
}

/**
 * Allowed pendingFill stage transitions.
 *
 *   await_recruiter  →  await_composer | done
 *   await_composer   →  done
 *   done             →  (terminal)
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidStageTransition(from, to) {
  if (to === 'done') return true; // any → done is valid (clear)
  if (from === 'await_recruiter' && to === 'await_composer') return true;
  return false;
}
