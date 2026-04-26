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
  if (code.startsWith('composer_state_invalid:')) {
    const detail = code.split(':')[1] || 'unknown';
    return `Composer didn't pass pre-send check (${detail}). Send aborted to avoid sending an empty/garbled message.`;
  }
  if (code.startsWith('cycle_stuck:')) {
    const stage = code.split(':')[1] || 'unknown';
    return `Auto-cycle got stuck at "${stage}" past its deadline. Force-cleared. Verify the LinkedIn tab and resume.`;
  }
  if (code.startsWith('hourly_cap_throttled:')) {
    const n = code.split(':')[1] || '?';
    return `Hourly cap reached (${n}/hr). Auto-mode will resume when the rolling window clears.`;
  }
  if (code.startsWith('invalid_stage_transition:')) {
    return 'Internal state drift in cycle pipeline. Cycle aborted; check telemetry log.';
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
    case 'recruiter_link_ambiguous':       return 'Multiple "In Recruiter anzeigen" candidates found. Refusing to click — DOM may have changed.';
    case 'recruiter_message_button_not_found': return 'Recruiter Message/InMail button not found. The DOM may have changed — see content/linkedin.js.';
    case 'composer_body_editor_not_found': return 'Composer body editor not found. LinkedIn may be slow or DOM changed.';
    case 'add_follow_up_button_not_found': return '"Folgenachricht hinzufügen" button not found. The DOM may have changed.';
    case 'follow_up_editor_not_found':     return 'Follow-up editor did not appear after clicking Add follow-up.';
    case 'fill_failed':                    return 'Filling the InMail failed. Check the LinkedIn tab.';
    case 'fill_drift_detected':            return 'Composer text changed between fill and send. Send aborted to avoid sending wrong content.';
    case 'wrong_tab':                      return 'Pending fill belongs to a different tab. Ignored to avoid mis-filling.';
    case 'wrong_url':                      return 'Tab URL does not match the lead Phil opened. Fill skipped to avoid mis-filling.';
    case 'wrong_profile_stage2':           return 'Tab navigated away from the intended profile during fill. Cycle aborted.';
    case 'no_response_from_service_worker':return 'Background worker did not respond. Reload the popup, or reload the extension at chrome://extensions.';
    case 'offline':                        return 'Offline — using cached lead. Sheet updates are paused.';
    case 'non_json_response':              return 'Apps Script did not return JSON. Make sure the deployment is active and "Who has access" is "Anyone".';
    case 'http_500':                       return 'Apps Script returned 500. Check the Apps Script execution log.';
    // ---- Auto-mode error codes ----
    case 'send_button_not_found':          return 'LinkedIn Send button not found. The DOM may have changed or composer is in an unexpected state.';
    case 'send_button_ambiguous':          return 'Multiple Send-like buttons matched in the composer. Refusing to click — DOM may have changed.';
    case 'send_button_disabled':           return 'Send button stayed disabled. Likely empty body or LinkedIn rejecting the form. Check the composer.';
    case 'send_confirmation_failed':       return 'A confirmation modal appeared but the proceed button could not be matched. Send aborted.';
    case 'send_success_not_detected':      return 'Send click registered but no success signal seen in 15s. Check LinkedIn manually before re-marking.';
    case 'account_rate_limited':           return 'LinkedIn rate-limited your account (anti-spam toast detected). Auto-mode paused for the day.';
    case 'recipient_unreachable':          return 'Recipient has paused InMails or is otherwise unreachable. Skipped.';
    case 'template_unrendered':            return 'Lead text contains unrendered template placeholders ({{...}} / ${...}). Skipped.';
    case 'auto_paused_by_user':            return 'Auto-mode paused by user.';
    case 'auto_off':                       return 'Auto-mode is off.';
    case 'auto_backoff':                   return 'Auto-mode paused after consecutive errors. Resume from the popup once the LinkedIn tab is healthy.';
    case 'tab_navigation_failed':          return 'Couldn\'t navigate to the next profile (tab closed or moved). Auto chain stopped.';
    case 'tab_lost':                       return 'LinkedIn tab was closed during the cycle. Auto chain stopped.';
    case 'auth_challenge':                 return 'LinkedIn asked for verification (checkpoint / captcha). Auto-mode paused — resolve in the tab, then resume manually.';
    case 'auto_mode_first_run_unconfirmed':return 'Auto-mode requires a one-time confirmation in the popup before it can be enabled.';
    case 'canary_pending':                 return 'Canary cycle: please click Send manually so we can verify success-detection signals.';
    case 'canary_signal_missing':          return 'Canary cycle did not record an expected success signal. Auto-send held until selectors are reviewed.';
    case 'no_pending':                     return 'No active fill in progress.';
    case 'fill_in_progress':               return 'A fill is already in progress for another row. Cancel it or wait for it to complete.';
    case 'pending_writes_backlog':         return 'Sheet write backlog growing — auto-mode paused until the queue drains.';
    default:                               return code;
  }
}

/**
 * Stage label for the pending-fill banner.
 * @param {string} stage
 */
export function humanStage(stage) {
  switch (stage) {
    case 'await_recruiter':  return 'opening profile…';
    case 'await_composer':   return 'opening composer…';
    case 'await_review':     return 'reviewing…';
    case 'await_send_click': return 'clicking send…';
    case 'await_modal':      return 'confirming send…';
    case 'await_success':    return 'verifying send…';
    case 'await_advance':    return 'advancing…';
    case 'cooldown':         return 'cooling down…';
    case 'error':            return 'error';
    case 'done':             return 'done';
    default:                 return stage || '';
  }
}

/**
 * Linear-pipeline step number (1-9) for the pending-fill banner.
 * Returns 0 for terminal/unknown stages.
 * @param {string} stage
 */
export function stageStep(stage) {
  switch (stage) {
    case 'await_recruiter':  return 1;
    case 'await_composer':   return 2;
    case 'await_review':     return 3;
    case 'await_send_click': return 4;
    case 'await_modal':      return 5;
    case 'await_success':    return 6;
    case 'await_advance':    return 7;
    case 'cooldown':         return 8;
    case 'done':             return 9;
    default:                 return 0;
  }
}

/**
 * Allowed pendingFill stage transitions.
 *
 * Forward pipeline:
 *   await_recruiter   → await_composer
 *   await_composer    → await_review
 *   await_review      → await_send_click
 *   await_send_click  → await_modal
 *   await_modal       → await_success
 *   await_success     → await_advance
 *   await_advance     → cooldown
 *   cooldown          → await_recruiter   (next cycle)
 *
 * Universal escapes:
 *   <any>             → done    (success / cleanup)
 *   <any>             → error   (failure with errorCode)
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidStageTransition(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  // Universal escapes — any stage may transition to terminal states.
  if (to === 'done')  return true;
  if (to === 'error') return true;

  /** @type {Record<string, string[]>} */
  const forward = {
    'await_recruiter':   ['await_composer'],
    'await_composer':    ['await_review'],
    'await_review':      ['await_send_click'],
    'await_send_click':  ['await_modal'],
    'await_modal':       ['await_success'],
    'await_success':     ['await_advance'],
    'await_advance':     ['cooldown'],
    'cooldown':          ['await_recruiter']
  };
  const allowed = forward[from] || [];
  return allowed.includes(to);
}
