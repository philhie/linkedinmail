// @ts-check

/**
 * Service worker — message router + state machine.
 *
 * Message contract:
 *
 *  popup → SW
 *    GET_STATE                     → { ok, state }
 *    NAV {direction:'next'|'prev'} → { ok, state }
 *    MARK_SENT                     → { ok, state }   queues a write, advances row
 *    SKIP                          → { ok, state }
 *    SET_TIER {tier}               → { ok, state }
 *    OPEN_AND_FILL                 → { ok, state }   schedules pendingFill, opens tab; CS does the rest
 *    PING_SHEET                    → { ok, sheetName }
 *    SETTINGS_CHANGED              → { ok }
 *    EXTEND_TARGET_TODAY {amount}  → { ok, state }
 *
 *  CS → SW
 *    GET_PENDING_FILL              → { ok, pendingFill | null }   filtered by sender.tab.id
 *    CLEAR_PENDING_FILL {error?}   → { ok }
 *    MARK_PENDING_STAGE {stage}    → { ok }                        validated transition
 *    CONTENT_READY                 → { ok }                        informational
 *
 *  SW → popup (push)
 *    STATE_UPDATED {state}
 *
 * pendingFill state machine:
 *   await_recruiter  →  await_composer | done
 *   await_composer   →  done
 *   done             →  (terminal, cleared)
 */

import * as sheets from '../lib/sheets.js';
import {
  loadSettings, saveSettings,
  loadRuntime, saveRuntime, withRuntime,
  maybeResetDaily, berlinDeDate, appendLeadCache, getCachedLead,
  activePendingFill, nextExpiryFor,
  migrateTokenStorageOnce
} from '../lib/state.js';
import { hasLinkedinUrl } from '../lib/lead.js';
import { isValidStageTransition } from '../lib/errors.js';
import {
  findTierMatch, appendPendingWrite, drainPendingWrites,
  recordSentInternal, jitteredDelay
} from '../lib/sw_logic.js';
import {
  detectAuthChallengeUrl, resolveAutoModeProfile, evaluateGuards,
  shouldInjectLongPause, longPauseDuration
} from '../lib/auto_mode.js';
import { appendEvent, recentEvents } from '../lib/telemetry.js';

chrome.runtime.onInstalled.addListener(async () => {
  await migrateTokenStorageOnce().catch(() => {});
  // Force defaults to materialize so options page shows real numbers.
  const settings = await loadSettings();
  await saveSettings(settings);
  const runtime = maybeResetDaily(await loadRuntime());
  await saveRuntime(runtime);
  await ensureDailyAlarm();
  await ensureWatchdogAlarms();
  await restoreCycleAlarmIfNeeded();
  drainQueueIfPossible().catch(() => {});
});

chrome.runtime.onStartup?.addListener(async () => {
  await ensureDailyAlarm();
  await ensureWatchdogAlarms();
  await restoreCycleAlarmIfNeeded();
  drainQueueIfPossible().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dailyReset') {
    const runtime = maybeResetDaily(await loadRuntime());
    await saveRuntime(runtime);
    pushStateUpdate().catch(() => {});
    return;
  }
  if (alarm.name === 'autoCycleHeartbeat') {
    await checkStuckPendingFill().catch(() => {});
    return;
  }
  if (alarm.name === 'writeQueueDrain') {
    drainQueueIfPossible().catch(() => {});
    return;
  }
  if (alarm.name === 'autoNextCycle') {
    await onAutoNextCycleFire().catch(() => {});
    return;
  }
});

// ---------------------------------------------------------------------------
// Tab lifecycle listeners (D4 in the plan)
//
// onUpdated   — if our pending-fill tab navigates to an auth-challenge
//               surface (checkpoint / captcha / login), abort the cycle and
//               engage backoff so we don't auto-resume across a verification.
// onRemoved   — if our pending-fill tab is closed, abort with `tab_lost`.
//
// Both handlers no-op fast when the event isn't on the tab we care about, so
// they're safe to leave registered for the manual flow too.
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Don't await — keep the listener hot.
  handleTabUpdated(tabId, info).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(() => {});
});

/**
 * @param {number} tabId
 * @param {chrome.tabs.TabChangeInfo} info
 */
async function handleTabUpdated(tabId, info) {
  if (!info || typeof info.url !== 'string') return;
  const runtime = await loadRuntime();
  const pf = runtime.pendingFill;
  if (!pf || pf.tabId !== tabId) return;
  if (detectAuthChallengeUrl(info.url)) {
    await failPendingFill('auth_challenge', pf.stage || 'unknown');
    pushStateUpdate().catch(() => {});
  }
}

/** @param {number} tabId */
async function handleTabRemoved(tabId) {
  const runtime = await loadRuntime();
  const pf = runtime.pendingFill;
  if (!pf || pf.tabId !== tabId) return;
  await failPendingFill('tab_lost', pf.stage || 'unknown');
  pushStateUpdate().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // keep the channel open for async response
});

/**
 * @param {any} msg
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleMessage(msg, sender) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'bad_message' };
  switch (msg.type) {
    case 'GET_STATE':           return { ok: true, state: await buildStateAndDrain() };
    case 'NAV':                 return await onNav(msg.direction === 'prev' ? 'prev' : 'next');
    case 'MARK_SENT':           return await onMarkSent();
    case 'SKIP':                return await onNav('next');
    case 'SET_TIER':            return await onSetTier(msg.tier);
    case 'PING_SHEET':          return await onPing();
    case 'SETTINGS_CHANGED':    return { ok: true };
    case 'EXTEND_TARGET_TODAY': return await onExtendTarget(msg.amount || 25);
    case 'OPEN_AND_FILL':       return await onOpenAndFill();
    case 'CONTENT_READY':       return { ok: true };
    case 'GET_PENDING_FILL':    return await onGetPendingFill(sender);
    case 'CLEAR_PENDING_FILL':  return await onClearPendingFill(msg.error || '');
    case 'MARK_PENDING_STAGE':  return await onMarkPendingStage(msg.stage || '');
    case 'SET_PENDING_PROFILE_ID': return await onSetPendingProfileId(msg.recruiterProfileId, sender);
    case 'RECORD_SEND_SUCCESS': return await onRecordSendSuccess(msg, sender);
    case 'RECORD_TELEMETRY':    return await onRecordTelemetry(msg.event);
    case 'SET_AUTO_MODE':       return await onSetAutoMode(msg.mode);
    case 'PAUSE_AUTO':          return await onPauseAuto();
    case 'RESUME_AUTO':         return await onResumeAuto();
    default:                    return { ok: false, error: 'unknown_type:' + msg.type };
  }
}

async function buildState() {
  const settings = await loadSettings();
  // Read-only: buildState used to write back currentRow / dailyCount / etc.
  // here, but that races with concurrent withRuntime writes from auto-mode
  // handlers and can clobber a freshly-incremented dailyCount. The daily
  // reset is owned by the `dailyReset` alarm and the handlers that mutate
  // (onNav, onMarkSent, onOpenAndFill) — buildState just reflects state.
  let runtime = maybeResetDaily(await loadRuntime());
  // Clamp display value if currentRow is below the configured start. This
  // doesn't persist; the next mutation (onNav/onMarkSent) will write fresh.
  const displayRow = (!runtime.currentRow || runtime.currentRow < settings.startRow)
    ? settings.startRow
    : runtime.currentRow;

  let lead = null;
  let offline = false;
  try {
    lead = await getLeadCached(settings, runtime, displayRow);
  } catch (err) {
    offline = true;
    lead = getCachedLead(runtime.leadCache, displayRow) || null;
    runtime = { ...runtime, lastError: String(err && err.message || err) };
  }

  const effectiveTarget = settings.dailyTarget + (runtime.todaysTargetOverride || 0);
  const pendingFill = activePendingFill(runtime.pendingFill);
  const pendingWrites = runtime.pendingWrites || [];
  // Slim settings projection — never expose appsScriptToken to the popup
  // process memory. Popup only needs a handful of fields for rendering.
  const popupSettings = {
    autoModeAcknowledgedAt: settings.autoModeAcknowledgedAt || 0,
    inmailSubject: settings.inmailSubject || '',
    canaryEveryN: settings.canaryEveryN
  };
  return {
    settings: popupSettings,
    lead,
    offline,
    currentRow: displayRow,
    dailyCount: runtime.dailyCount,
    effectiveTarget,
    dailyTarget: settings.dailyTarget,
    todaysTargetOverride: runtime.todaysTargetOverride,
    targetReached: runtime.dailyCount >= effectiveTarget,
    tierFilter: settings.tierFilter,
    lastError: runtime.lastError || (offline ? 'offline' : ''),
    settingsConfigured: Boolean(settings.appsScriptUrl && settings.appsScriptToken),
    pendingFill: pendingFill ? {
      row: pendingFill.row,
      stage: pendingFill.stage,
      cycleId: pendingFill.cycleId,
      cooldownDeadline: pendingFill.cooldownDeadline,
      canary: Boolean(pendingFill.canary)
    } : null,
    pendingWritesCount: pendingWrites.length,
    // Auto-mode state for popup rendering
    autoMode: settings.autoMode || 'off',
    autoPaused: Boolean(runtime.autoPaused),
    autoBackoffPausedAt: runtime.autoBackoffPausedAt || 0,
    consecutiveErrors: runtime.consecutiveErrors || 0,
    lastErrorCode: runtime.lastErrorCode || '',
    canaryNeeded: Boolean(runtime.canaryNeeded),
    sendsSinceCanary: runtime.sendsSinceCanary || 0,
    recentEvents: recentEvents(runtime.eventLog, 5),
    autoModeAcknowledgedAt: settings.autoModeAcknowledgedAt || 0
  };
}

/**
 * Build state, opportunistically draining the write queue first.
 * Used by GET_STATE so opening the popup nudges any stuck writes.
 */
async function buildStateAndDrain() {
  // Don't await drain — we don't want to slow down GET_STATE.
  drainQueueIfPossible().catch(() => {});
  return buildState();
}

/**
 * Read a lead, preferring fresh fetch but caching results.
 * @param {Awaited<ReturnType<typeof loadSettings>>} settings
 * @param {Awaited<ReturnType<typeof loadRuntime>>} runtime
 * @param {number} row
 */
async function getLeadCached(settings, runtime, row) {
  if (!settings.appsScriptUrl || !settings.appsScriptToken) {
    throw new Error('not_configured');
  }
  const lead = await sheets.readRow(settings, row);
  const nextCache = appendLeadCache(runtime.leadCache, [lead]);
  await saveRuntime({ leadCache: nextCache, lastError: '' });
  return lead;
}

/** @param {'next'|'prev'} direction */
async function onNav(direction) {
  const settings = await loadSettings();
  const runtime = maybeResetDaily(await loadRuntime());
  let row = runtime.currentRow + (direction === 'next' ? 1 : -1);
  if (row < settings.startRow) row = settings.startRow;
  const target = await findTierMatch(settings, runtime.leadCache, row, direction, sheets);
  await saveRuntime({ currentRow: target.row, leadCache: target.cache });
  return { ok: true, state: await buildState() };
}

async function onMarkSent() {
  const settings = await loadSettings();
  const date = berlinDeDate();
  const now = Date.now();

  // Atomic: re-check the daily cap inside the same mutex that does the
  // increment, so concurrent paths (auto-mode RECORD_SEND_SUCCESS, another
  // manual click) can't both pass a stale cap check and double-increment.
  let result = /** @type {{ok: boolean, error?: string}} */ ({ ok: false, error: 'daily_target_reached' });
  await withRuntime((rt) => {
    const r = maybeResetDaily(rt);
    const target = Number(settings.dailyTarget || 0) + Number(r.todaysTargetOverride || 0);
    if ((r.dailyCount || 0) >= target) {
      result = { ok: false, error: 'daily_target_reached' };
      return null;
    }
    result = { ok: true };
    return recordSentInternal(r, r.currentRow, date, now, 'manual');
  });
  if (!result.ok) return result;

  await onNav('next');
  const state = await buildState();

  // Kick off a drain. Fire-and-forget; if it doesn't finish before SW dies,
  // the next drain trigger (popup open, SW restart) will retry.
  drainQueueIfPossible().catch(() => {});

  return { ok: true, state };
}

/** @param {string} tier */
async function onSetTier(tier) {
  const allowed = ['All', 'S', 'A', 'B'];
  const next = allowed.includes(tier) ? tier : 'All';
  await saveSettings({ tierFilter: next });
  // Re-resolve current row so we land on a matching lead.
  const settings = await loadSettings();
  const runtime = await loadRuntime();
  const target = await findTierMatch(settings, runtime.leadCache, runtime.currentRow, 'next', sheets);
  await saveRuntime({ currentRow: target.row, leadCache: target.cache });
  return { ok: true, state: await buildState() };
}

async function onPing() {
  try {
    const settings = await loadSettings();
    const res = await sheets.ping(settings);
    return { ok: true, sheetName: res.sheetName };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** @param {number} amount */
async function onExtendTarget(amount) {
  const runtime = await loadRuntime();
  await saveRuntime({ todaysTargetOverride: (runtime.todaysTargetOverride || 0) + amount });
  return { ok: true, state: await buildState() };
}

async function onOpenAndFill() {
  const settings = await loadSettings();

  // Atomic precheck: run cap + rate-limit checks under the mutex so a second
  // concurrent OPEN_AND_FILL can't pass the same check before we record the
  // open time. We don't open the tab inside the mutex (chrome.tabs.create is
  // long-running and would block other writes) — instead we reserve the
  // `lastOpenedAt` slot here, then open the tab outside the mutex, then write
  // pendingFill in a second mutex pass that includes the tabId.
  let precheck = /** @type {{ok: boolean, error?: string}} */ ({ ok: false, error: 'precheck_failed' });
  await withRuntime((rt) => {
    const r = maybeResetDaily(rt);
    const target = Number(settings.dailyTarget || 0) + Number(r.todaysTargetOverride || 0);
    if ((r.dailyCount || 0) >= target) {
      precheck = { ok: false, error: 'daily_target_reached' };
      return null;
    }
    const elapsed = Date.now() - (r.lastOpenedAt || 0);
    const minMs = Math.max(0, Number(settings.minIntervalSeconds || 0) * 1000);
    if (elapsed < minMs) {
      const waitSec = Math.ceil((minMs - elapsed) / 1000);
      precheck = { ok: false, error: `rate_limited:${waitSec}` };
      return null;
    }
    precheck = { ok: true };
    // Reserve the lastOpenedAt slot before we open the tab so concurrent
    // callers see this attempt's timestamp and rate-limit themselves.
    return { lastOpenedAt: Date.now() };
  });
  if (!precheck.ok) return precheck;

  // Lead resolution can use buildState (read-only after maybeResetDaily).
  const state = await buildState();
  const lead = state.lead;
  if (!lead) return { ok: false, error: 'no_lead' };
  if (!hasLinkedinUrl(lead)) return { ok: false, error: 'no_linkedin_url' };

  // Open the tab — captures tabId for the pendingFill identity check.
  const tab = await chrome.tabs.create({ url: lead.linkedinUrl, active: true });
  if (typeof tab.id !== 'number') {
    return { ok: false, error: 'tab_create_failed' };
  }

  // Embed the auto-mode posture into the pendingFill snapshot so the CS can
  // run the right pipeline without a second round-trip.
  const runtimeForCanary = await loadRuntime();
  const isCanary = shouldRunAsCanary(settings, runtimeForCanary);
  const now = Date.now();
  const cycleId = crypto.randomUUID();
  const pendingFill = {
    row: lead.row,
    subject: settings.inmailSubject || 'kurze frage',
    inmail: lead.inmail || '',
    followUp: lead.followUp || '',
    stage: 'await_recruiter',
    startedAt: now,
    stageEnteredAt: now,
    expiresAt: nextExpiryFor('await_recruiter', now, { settings }),
    tabId: tab.id,
    linkedinUrl: lead.linkedinUrl,
    cycleId,
    autoMode: settings.autoMode || 'off',
    reviewWindowMs: Number(settings.reviewWindowMs) || 2500,
    canary: isCanary
  };
  await saveRuntime({ pendingFill, lastError: '' });

  return { ok: true, state: await buildState() };
}

/**
 * Should this 'on' cycle run as a canary (no auto-click; Phil clicks Send
 * manually so we can verify success-detection signals)? True when:
 *   - autoMode === 'on' AND safetyMode is on AND
 *   - either canaryNeeded is true (first cycle of session) OR
 *     sendsSinceCanary >= canaryEveryN (cadence re-canary)
 *
 * @param {Awaited<ReturnType<typeof loadSettings>>} settings
 * @param {Awaited<ReturnType<typeof loadRuntime>>} runtime
 */
function shouldRunAsCanary(settings, runtime) {
  if (settings.autoMode !== 'on') return false;
  if (settings.safetyMode === false) return false;
  if (runtime.canaryNeeded) return true;
  const every = Math.max(1, Number(settings.canaryEveryN || 25));
  return (Number(runtime.sendsSinceCanary) || 0) >= every;
}

/** @param {chrome.runtime.MessageSender} sender */
async function onGetPendingFill(sender) {
  const runtime = await loadRuntime();
  const active = activePendingFill(runtime.pendingFill);
  if (runtime.pendingFill && !active) {
    // Was set, but expired — clear it.
    await saveRuntime({ pendingFill: null });
  }
  if (!active) return { ok: true, pendingFill: null };

  // Tab identity check: only the tab we opened may pick this up.
  const senderTabId = sender && sender.tab && sender.tab.id;
  if (typeof active.tabId === 'number' &&
      typeof senderTabId === 'number' &&
      active.tabId !== senderTabId) {
    return { ok: true, pendingFill: null };
  }

  return { ok: true, pendingFill: active };
}

/** @param {string} errorCode */
async function onClearPendingFill(errorCode) {
  if (errorCode) {
    // Errors flow through failPendingFill so consecutiveErrors increments
    // and the backoff threshold (D11) actually engages. Without this, every
    // CS-side failure (send_button_not_found, composer_state_invalid, etc.)
    // would silently reset the cycle without ever tripping auto-pause.
    let stage = 'unknown';
    const rt = await loadRuntime();
    if (rt.pendingFill) stage = rt.pendingFill.stage || 'unknown';
    await failPendingFill(errorCode, stage);
    return { ok: true };
  }
  // Success path — clear pendingFill + lastError. ALSO reset the consecutive
  // error streak (a clean clear from the CS means this cycle worked).
  await withRuntime(() => ({
    pendingFill: null,
    lastError: '',
    consecutiveErrors: 0,
    lastErrorCode: ''
  }));
  pushStateUpdate().catch(() => {});
  return { ok: true };
}

/**
 * Stamp the recruiter profile ID into the active pendingFill. Called by the
 * CS at the end of stage 1 once it's resolved the "In Recruiter anzeigen"
 * href, so stage 2 can verify the navigated URL matches the intended profile.
 * Idempotent — only writes if the active pendingFill belongs to the sender's
 * tab and currently lacks a profileId.
 *
 * @param {string} recruiterProfileId
 * @param {chrome.runtime.MessageSender} sender
 */
async function onSetPendingProfileId(recruiterProfileId, sender) {
  if (typeof recruiterProfileId !== 'string' || !recruiterProfileId) {
    return { ok: false, error: 'bad_message' };
  }
  const senderTabId = sender && sender.tab && sender.tab.id;
  await withRuntime((rt) => {
    const active = activePendingFill(rt.pendingFill);
    if (!active) return null;
    if (typeof active.tabId === 'number' &&
        typeof senderTabId === 'number' &&
        active.tabId !== senderTabId) {
      return null; // wrong tab
    }
    if (active.recruiterProfileId === recruiterProfileId) return null; // no-op
    return { pendingFill: { ...active, recruiterProfileId } };
  });
  return { ok: true };
}

/** @param {string} stage */
async function onMarkPendingStage(stage) {
  const settings = await loadSettings();
  let result = /** @type {{ok: boolean, error?: string}} */ ({ ok: false, error: 'no_pending' });

  await withRuntime((runtime) => {
    const active = activePendingFill(runtime.pendingFill);
    if (!active) {
      result = { ok: false, error: 'no_pending' };
      return null;
    }
    if (!isValidStageTransition(active.stage, stage)) {
      result = { ok: false, error: `invalid_stage_transition:${active.stage}_to_${stage}` };
      return null;
    }
    const now = Date.now();
    const reviewMs = Number(active.reviewWindowMs) ||
                     Number(settings.reviewWindowMs) || 2500;
    let newExpiry = nextExpiryFor(stage, now, { settings, reviewMs });
    // Canary cycles spend their await_success stage waiting for the user to
    // click Send manually. The default 20s TTL is faster than a human can
    // notice the cue and click — extend to 90s (longer than the CS's 60s
    // verifySendSuccess timeout, so the CS gets to fail with a real signal
    // instead of being yanked by the watchdog).
    if (active.canary && stage === 'await_success') {
      newExpiry = now + 90_000;
    }
    result = { ok: true };
    return {
      pendingFill: { ...active, stage, expiresAt: newExpiry, stageEnteredAt: now }
    };
  });

  // Push so the popup status pill + toolbar badge update in real time as the
  // CS walks the pipeline. Without this the badge stays at "ON" through the
  // whole cycle and the canary "WAIT" cue never appears.
  if (result.ok) pushStateUpdate().catch(() => {});

  return result;
}

/**
 * Drain the pending writes queue. Idempotent — safe to call repeatedly.
 * Concurrent calls are de-duped by the in-flight promise reference.
 */
let _drainInFlight = /** @type {Promise<void> | null} */ (null);
function drainQueueIfPossible() {
  if (_drainInFlight) return _drainInFlight;
  _drainInFlight = (async () => {
    try {
      const settings = await loadSettings();
      const runtime = await loadRuntime();
      const writes = runtime.pendingWrites || [];
      if (writes.length === 0) return;

      const result = await drainPendingWrites(settings, writes, sheets);

      /** @type {Record<string, unknown>} */
      const patch = { pendingWrites: result.remaining };
      if (result.remaining.length > 0) {
        // Surface count so popup shows "N writes pending".
        patch.lastError = `pending_writes:${result.remaining.length}`;
      } else if (result.completed.length > 0) {
        // All drained successfully — clear any pending_writes lastError.
        const cur = await loadRuntime();
        if (cur.lastError && cur.lastError.startsWith('pending_writes:')) {
          patch.lastError = '';
        }
      }
      await saveRuntime(patch);
      if (result.completed.length > 0 || result.remaining.length !== writes.length) {
        pushStateUpdate().catch(() => {});
      }
    } finally {
      _drainInFlight = null;
    }
  })();
  return _drainInFlight;
}

async function pushStateUpdate() {
  const state = await buildState();
  // Update the toolbar badge so the user knows auto-mode status when the
  // popup is closed (D12). Best-effort — never throw.
  updateBadge(state).catch(() => {});
  try {
    await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', state });
  } catch (_e) {
    // Popup may be closed; that's fine.
  }
}

/**
 * Toolbar badge mirrors auto-mode posture so Phil sees state at a glance.
 * ASCII-only to render uniformly across macOS / Windows / Linux:
 *   blank         — auto off
 *   "DRY" amber   — dry-run
 *   "WAIT" amber  — canary cycle, waiting for user to click Send manually
 *   "PAU" amber   — paused (user) or backoff (errors)
 *   "ERR" red     — last cycle errored
 *   "N" teal      — auto on, N = today's confirmed sends
 *   "ON" teal     — auto on, no sends yet
 */
async function updateBadge(state) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  const mode = state.autoMode || 'off';
  if (mode === 'off') {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (state.autoPaused || state.autoBackoffPausedAt) {
    await chrome.action.setBadgeText({ text: 'PAU' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ffb347' });
    return;
  }
  if (state.lastErrorCode) {
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ff6b6b' });
    return;
  }
  // Canary cycle in the manual-click window — make it visually loud so the
  // user notices even when the popup is closed.
  const pf = state.pendingFill;
  if (pf && pf.canary && (
        pf.stage === 'await_send_click' ||
        pf.stage === 'await_modal' ||
        pf.stage === 'await_success')) {
    await chrome.action.setBadgeText({ text: 'WAIT' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ffb347' });
    return;
  }
  if (mode === 'dry_run') {
    await chrome.action.setBadgeText({ text: 'DRY' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ffb347' });
    return;
  }
  // Live mode: show today's confirmed-sent count.
  const n = Number(state.dailyCount) || 0;
  await chrome.action.setBadgeText({ text: n > 0 ? String(n) : 'ON' });
  await chrome.action.setBadgeBackgroundColor({ color: '#00D4AA' });
}

async function ensureDailyAlarm() {
  const existing = await chrome.alarms.get('dailyReset');
  if (!existing) {
    chrome.alarms.create('dailyReset', {
      when: nextLocalMidnight(),
      periodInMinutes: 24 * 60
    });
  }
}

/**
 * Two periodic alarms supporting the auto-mode pipeline:
 *
 *   autoCycleHeartbeat — every 60s, force-clears any pendingFill whose
 *                        stage TTL has expired (`cycle_stuck:<stage>`).
 *   writeQueueDrain    — every 5min, retries the pendingWrites queue so a
 *                        sheet write that failed earlier doesn't sit until
 *                        the user opens the popup again.
 *
 * Both alarms are idempotent — only one of each is ever created. They're
 * registered on install + startup.
 */
async function ensureWatchdogAlarms() {
  const heartbeat = await chrome.alarms.get('autoCycleHeartbeat');
  if (!heartbeat) {
    chrome.alarms.create('autoCycleHeartbeat', { periodInMinutes: 1 });
  }
  const drain = await chrome.alarms.get('writeQueueDrain');
  if (!drain) {
    chrome.alarms.create('writeQueueDrain', { periodInMinutes: 5 });
  }
}

/**
 * Watchdog: if a pendingFill is set but past its expiry, the cycle is stuck
 * (CS crashed, tab navigated, popup never re-opened). Force-clear it and
 * surface `cycle_stuck:<stage>` so Phil knows what got abandoned.
 */
async function checkStuckPendingFill() {
  const runtime = await loadRuntime();
  const pf = runtime.pendingFill;
  if (!pf) return;
  const active = activePendingFill(pf);
  if (active) return; // not expired
  const stage = pf.stage || 'unknown';
  await failPendingFill(`cycle_stuck:${stage}`, stage);
  pushStateUpdate().catch(() => {});
}

/**
 * Centralized "fail the cycle" helper. Clears pendingFill, increments the
 * consecutive-error counter, appends a telemetry event, and engages
 * `autoBackoffPausedAt` when either:
 *   - the error code is one of the always-pause set (auth_challenge, tab_lost,
 *     account_rate_limited) — these are systemic, never auto-resume
 *   - or the consecutive-error counter has hit the user's threshold
 *
 * The counter resets to 0 on a successful send (see `recordSentInternal`).
 *
 * @param {string} errorCode
 * @param {string} atStage
 */
async function failPendingFill(errorCode, atStage) {
  const settings = await loadSettings();
  const threshold = Math.max(1, Number(settings.errorBackoffThreshold || 2));
  const now = Date.now();
  const alwaysPause = new Set(['auth_challenge', 'tab_lost', 'account_rate_limited']);

  await withRuntime((runtime) => {
    // H5: guard against double-fire from two listeners (e.g., onRemoved AND
    // onUpdated firing for the same auth-challenge close). If pendingFill is
    // already null AND the previous failure was the same code, treat as a
    // duplicate and skip — prevents a single logical failure from
    // double-incrementing consecutiveErrors and tripping backoff prematurely.
    if (!runtime.pendingFill && runtime.lastErrorCode === errorCode) {
      return null;
    }

    const consecutiveErrors = (Number(runtime.consecutiveErrors) || 0) + 1;
    /** @type {Partial<typeof runtime>} */
    const patch = {
      pendingFill: null,
      lastError: errorCode,
      consecutiveErrors,
      lastErrorCode: errorCode,
      eventLog: appendEvent(runtime.eventLog, {
        ts: now,
        cycleId: runtime.pendingFill && runtime.pendingFill.cycleId,
        row: runtime.pendingFill && runtime.pendingFill.row,
        stage: atStage,
        action: 'cycle_failed',
        outcome: 'fail',
        errorCode
      })
    };

    if (alwaysPause.has(errorCode) || consecutiveErrors >= threshold) {
      patch.autoBackoffPausedAt = now;
    }

    return patch;
  });
}

function nextLocalMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Auto-mode message handlers (Step 5)
//
// The chained cycle relies on the SW to:
//   1. Receive RECORD_SEND_SUCCESS from the CS once a send is verified
//   2. Mark sent (shared `recordSentInternal`) and advance currentRow
//   3. Schedule the next-cycle alarm if mode is 'on'
//   4. When the alarm fires, navigate the existing tab to the next lead
//
// Step 5 wires all of the above. Step 6 unsuppresses the actual click in
// content/linkedin.js; until then the live-mode entry to this code path is
// inaccessible (the CS only emits RECORD_SEND_SUCCESS for dry_run, where
// we just record telemetry and stop).
// ---------------------------------------------------------------------------

/**
 * @param {{row: number, signal?: string, classification?: string, text?: string, cycleId?: string}} msg
 * @param {chrome.runtime.MessageSender} sender
 */
async function onRecordSendSuccess(msg, sender) {
  if (!msg || typeof msg.row !== 'number') return { ok: false, error: 'bad_message' };

  const runtime = await loadRuntime();
  const pf = activePendingFill(runtime.pendingFill);
  if (!pf) return { ok: false, error: 'no_pending' };
  if (pf.row !== msg.row) return { ok: false, error: 'row_mismatch' };
  if (msg.cycleId && pf.cycleId && pf.cycleId !== msg.cycleId) {
    return { ok: false, error: 'cycle_mismatch' };
  }
  const senderTabId = sender && sender.tab && sender.tab.id;
  if (typeof pf.tabId === 'number' &&
      typeof senderTabId === 'number' &&
      senderTabId !== pf.tabId) {
    return { ok: false, error: 'wrong_tab' };
  }

  const classification = String(msg.classification || 'unknown');
  const signal = String(msg.signal || 'unknown');

  // Dry-run: log telemetry and clear. No mark-sent, no advance, no chain.
  // Bypasses classification checks — the dry-run path may report any signal
  // and we treat it as informational only.
  if (pf.autoMode === 'dry_run' || signal === 'dry_run') {
    await withRuntime((rt) => ({
      pendingFill: null,
      lastError: '',
      eventLog: appendEvent(rt.eventLog, {
        ts: Date.now(),
        cycleId: pf.cycleId, row: pf.row, stage: 'await_advance',
        action: 'dry_run_success', outcome: 'ok', signal
      })
    }));
    pushStateUpdate().catch(() => {});
    return { ok: true, dryRun: true };
  }

  // Canary: Phil clicked Send manually. The message DID go out, so we mark
  // sent (treat the row as confirmed sent), but we do NOT chain — Phil
  // verifies the popup updated correctly and re-arms by clicking Open + Fill
  // himself for the next cycle. Negative classification still hard-stops.
  // Unknown/timeout means Phil didn't click in 60s → canary_signal_missing.
  const isCanary = pf.canary === true || msg.canary === true;
  if (isCanary) {
    if (classification === 'negative') {
      await failPendingFill('account_rate_limited', pf.stage || 'await_success');
      pushStateUpdate().catch(() => {});
      return { ok: false, error: 'account_rate_limited' };
    }
    if (classification === 'unknown' || classification === 'timeout') {
      await failPendingFill('canary_signal_missing', pf.stage || 'await_success');
      pushStateUpdate().catch(() => {});
      return { ok: false, error: 'canary_signal_missing' };
    }
    // Positive or composer_removed → canary OK. Mark sent (the row's been
    // sent for real), clear canaryNeeded + sendsSinceCanary, but DON'T chain.
    const settings = await loadSettings();
    const date = berlinDeDate();
    const now = Date.now();
    let canaryResult = /** @type {{ok: boolean, error?: string}} */ ({ ok: false, error: 'race_lost' });
    await withRuntime((rt) => {
      const r = maybeResetDaily(rt);
      const cur = r.pendingFill;
      if (!cur || cur.row !== pf.row || (msg.cycleId && cur.cycleId !== msg.cycleId)) {
        canaryResult = { ok: false, error: 'cycle_replaced' };
        return null;
      }
      const target = Number(settings.dailyTarget || 0) + Number(r.todaysTargetOverride || 0);
      if ((r.dailyCount || 0) >= target) {
        canaryResult = { ok: false, error: 'daily_target_reached' };
        return null;
      }
      const patch = recordSentInternal(r, pf.row, date, now, 'auto');
      patch.pendingFill = null;
      patch.canaryNeeded = false;
      patch.sendsSinceCanary = 0;
      patch.eventLog = appendEvent(r.eventLog, {
        ts: now,
        cycleId: pf.cycleId, row: pf.row, stage: 'await_advance',
        action: 'canary_completed', outcome: 'ok', signal,
        detail: classification
      });
      patch.lastAutoCycle = {
        row: pf.row, cycleId: pf.cycleId || '',
        signal: 'canary:' + signal, finishedAt: now
      };
      canaryResult = { ok: true };
      return patch;
    });
    if (canaryResult.ok) {
      await onNav('next');
      drainQueueIfPossible().catch(() => {});
    }
    pushStateUpdate().catch(() => {});
    return { ok: canaryResult.ok, canary: true, error: canaryResult.error };
  }

  // Negative classification: LinkedIn rate-limited or flagged. Hard stop.
  if (classification === 'negative') {
    await failPendingFill('account_rate_limited', pf.stage || 'await_success');
    pushStateUpdate().catch(() => {});
    return { ok: false, error: 'account_rate_limited' };
  }

  // Ambiguous: send_button_gone alone, or timeout. Surface and stop —
  // refusing to mark sent on a weak signal avoids double-sending later.
  if (classification === 'unknown' || classification === 'timeout') {
    await failPendingFill('send_success_not_detected', pf.stage || 'await_success');
    pushStateUpdate().catch(() => {});
    return { ok: false, error: 'send_success_not_detected' };
  }

  // Live success path: positive toast or composer_removed. Re-validate
  // identity and the daily cap atomically — between the validation up top
  // and now, another path (manual MARK_SENT, a duplicate RECORD_SEND_SUCCESS)
  // could have hit the cap or invalidated this cycle.
  const settings = await loadSettings();
  const date = berlinDeDate();
  const now = Date.now();
  let liveResult = /** @type {{ok: boolean, error?: string}} */ ({ ok: false, error: 'race_lost' });
  await withRuntime((rt) => {
    const r = maybeResetDaily(rt);
    // Re-check identity inside the mutex.
    const cur = r.pendingFill;
    if (!cur || cur.row !== pf.row || (msg.cycleId && cur.cycleId && cur.cycleId !== msg.cycleId)) {
      liveResult = { ok: false, error: 'cycle_replaced' };
      return null;
    }
    // Re-check the daily cap.
    const target = Number(settings.dailyTarget || 0) + Number(r.todaysTargetOverride || 0);
    if ((r.dailyCount || 0) >= target) {
      liveResult = { ok: false, error: 'daily_target_reached' };
      return null;
    }
    const patch = recordSentInternal(r, pf.row, date, now, 'auto');
    patch.eventLog = appendEvent(r.eventLog, {
      ts: now,
      cycleId: pf.cycleId, row: pf.row, stage: 'await_success',
      action: 'send_succeeded', outcome: 'ok', signal,
      detail: classification
    });
    patch.lastAutoCycle = {
      row: pf.row, cycleId: pf.cycleId || '',
      signal, finishedAt: now
    };
    liveResult = { ok: true };
    return patch;
  });
  if (!liveResult.ok) {
    pushStateUpdate().catch(() => {});
    return liveResult;
  }

  // Advance currentRow to the next eligible lead, then schedule next cycle
  // if auto-mode is still 'on' and guards pass.
  await onNav('next');
  drainQueueIfPossible().catch(() => {});
  await scheduleNextAutoCycle(pf.tabId, pf.cycleId);
  pushStateUpdate().catch(() => {});

  return { ok: true };
}

/**
 * Compute a jittered cooldown, transition pendingFill into 'cooldown' stage,
 * and arm the chrome.alarms entry. No-op when:
 *   - auto-mode isn't 'on'
 *   - autoPaused / autoBackoffPausedAt
 *   - daily target reached
 *   - guards reject (quiet hours, hourly cap, write backlog)
 *
 * Soft-throttle reasons (quiet hours / hourly cap) reschedule the alarm to
 * fire when the throttle clears. Hard reasons clear pendingFill.
 *
 * @param {number} tabId — the still-open Recruiter tab to reuse for the next lead
 */
/**
 * @param {number} tabId
 * @param {string} [guardCycleId] — cycleId we expect pendingFill to still own.
 *   If pendingFill has changed (different cycleId, or null), we don't write
 *   a stale cooldown over a fresh cycle.
 */
async function scheduleNextAutoCycle(tabId, guardCycleId) {
  const settings = await loadSettings();
  const profile = resolveAutoModeProfile(settings);
  if (!profile.enabled || profile.dryRun) {
    // Live-mode chaining only in 'on' mode. Clear pendingFill if it's still ours.
    await withRuntime((rt) => {
      if (!rt.pendingFill) return null;
      if (guardCycleId && rt.pendingFill.cycleId !== guardCycleId) return null;
      return { pendingFill: null };
    });
    return;
  }

  const runtime = await loadRuntime();
  const guards = evaluateGuards({
    runtime, settings, now: Date.now(), profile,
    pendingWritesCount: (runtime.pendingWrites || []).length,
    pendingWritesOldestQueuedAt:
      Array.isArray(runtime.pendingWrites) && runtime.pendingWrites.length > 0
        ? runtime.pendingWrites[0].queuedAt
        : undefined
  });
  if (!guards.proceed) {
    const reason = String(guards.reason || 'auto_paused_by_user');
    if (reason === 'quiet_hours' || reason.startsWith('hourly_cap_throttled')) {
      // Soft throttle — keep pendingFill in cooldown, reschedule alarm.
      const retry = Math.max(60_000, Number(guards.retryAfterMs) || 60_000);
      await armCooldownAlarm(tabId, Date.now() + retry, settings, guardCycleId);
      return;
    }
    // Hard reason — clear cycle, surface.
    await failPendingFill(reason, 'await_advance');
    return;
  }

  // Compute jittered delay, plus optional long-pause injection. The long
  // pause is ADDITIVE — when it fires, the cycle waits the jittered base PLUS
  // the long pause. This matches the plan's "extra 3-7min pause" intent and
  // breaks up sustained bursts more aggressively than max-of-the-two would.
  const baseDelay = jitteredDelay(profile.baseMs, profile.jitterPct);
  let delay = baseDelay;
  if (shouldInjectLongPause(Math.random, settings)) {
    delay += longPauseDuration(Math.random, settings);
  }
  // Chrome enforces 30s minimum on packed extensions for `when` alarms.
  delay = Math.max(30_000, delay);

  await armCooldownAlarm(tabId, Date.now() + delay, settings, guardCycleId);
}

/**
 * Transition pendingFill into `cooldown` stage and schedule the alarm.
 *
 * Stage transition validation: cooldown is only legal from `await_advance`
 * (per the state machine). We first move pendingFill from its current stage
 * (likely `await_success` after `recordSentInternal`) to `await_advance`,
 * then to `cooldown` — both writes go through `isValidStageTransition`.
 *
 * If a `guardCycleId` is provided, all writes are conditioned on the current
 * pendingFill still owning that cycleId. Prevents stale cooldown writes from
 * resurrecting a pendingFill that another listener has already cleared.
 *
 * @param {number} tabId
 * @param {number} fireAt epoch ms
 * @param {Awaited<ReturnType<typeof loadSettings>>} settings
 * @param {string} [guardCycleId]
 */
async function armCooldownAlarm(tabId, fireAt, settings, guardCycleId) {
  let armed = false;
  await withRuntime((rt) => {
    const now = Date.now();
    const cooldownMs = Math.max(0, fireAt - now);
    const newExpiry = nextExpiryFor('cooldown', now, { settings, cooldownMs });
    const cur = rt.pendingFill;
    if (!cur) return null;
    if (guardCycleId && cur.cycleId !== guardCycleId) return null;
    // Two paths into cooldown:
    //   1. cooldown → cooldown (soft-throttle reschedule) — no-op transition;
    //      we just reset the expiry and the alarm.
    //   2. await_success → cooldown — invalid directly. We synthesize the
    //      intermediate await_advance step. Validate BOTH halves:
    //      from → await_advance, AND await_advance → cooldown.
    //   Any other source stage is unexpected; refuse.
    if (cur.stage !== 'cooldown') {
      const validToAdvance = isValidStageTransition(cur.stage, 'await_advance');
      const validToCooldown = isValidStageTransition('await_advance', 'cooldown');
      if (!validToAdvance || !validToCooldown) return null;
    }
    armed = true;
    return {
      pendingFill: {
        ...cur,
        stage: 'cooldown',
        tabId,
        cooldownDeadline: fireAt,
        stageEnteredAt: now,
        expiresAt: newExpiry
      }
    };
  });
  if (!armed) return;
  try {
    await chrome.alarms.clear('autoNextCycle');
    chrome.alarms.create('autoNextCycle', { when: fireAt });
  } catch (_e) { /* ignore — alarm best-effort */ }
}

/**
 * Alarm handler for the next-cycle trigger. Re-checks guards, then navigates
 * the existing tab to the next lead and writes a fresh pendingFill.
 */
async function onAutoNextCycleFire() {
  const settings = await loadSettings();
  let runtime = maybeResetDaily(await loadRuntime());
  if (!runtime.pendingFill || runtime.pendingFill.stage !== 'cooldown') return;
  const cooldownPf = runtime.pendingFill;

  const profile = resolveAutoModeProfile(settings);
  const guards = evaluateGuards({
    runtime, settings, now: Date.now(), profile,
    pendingWritesCount: (runtime.pendingWrites || []).length,
    pendingWritesOldestQueuedAt:
      Array.isArray(runtime.pendingWrites) && runtime.pendingWrites.length > 0
        ? runtime.pendingWrites[0].queuedAt
        : undefined
  });
  if (!guards.proceed) {
    const reason = String(guards.reason || 'auto_paused_by_user');
    if (reason === 'quiet_hours' || reason.startsWith('hourly_cap_throttled')) {
      const retry = Math.max(60_000, Number(guards.retryAfterMs) || 60_000);
      await armCooldownAlarm(cooldownPf.tabId, Date.now() + retry, settings);
      return;
    }
    await failPendingFill(reason, 'cooldown');
    pushStateUpdate().catch(() => {});
    return;
  }

  // Tab still alive?
  let tab = null;
  try { tab = await chrome.tabs.get(cooldownPf.tabId); } catch (_e) { tab = null; }
  if (!tab) {
    await failPendingFill('tab_navigation_failed', 'cooldown');
    pushStateUpdate().catch(() => {});
    return;
  }

  // Resolve next lead from runtime.currentRow (already advanced when send was recorded).
  const state = await buildState();
  const lead = state.lead;
  if (!lead) {
    await failPendingFill('no_lead', 'cooldown');
    pushStateUpdate().catch(() => {});
    return;
  }
  if (!hasLinkedinUrl(lead)) {
    // Skip leads with no URL — advance again, retry shortly.
    await onNav('next');
    await armCooldownAlarm(cooldownPf.tabId, Date.now() + 30_000, settings);
    return;
  }

  // Build a fresh pendingFill for the same tab + new row.
  const isCanary = shouldRunAsCanary(settings, runtime);
  const now = Date.now();
  const cycleId = crypto.randomUUID();
  const newPending = {
    row: lead.row,
    subject: settings.inmailSubject || 'kurze frage',
    inmail: lead.inmail || '',
    followUp: lead.followUp || '',
    stage: 'await_recruiter',
    startedAt: now,
    stageEnteredAt: now,
    expiresAt: nextExpiryFor('await_recruiter', now, { settings }),
    tabId: cooldownPf.tabId,
    linkedinUrl: lead.linkedinUrl,
    cycleId,
    autoMode: settings.autoMode || 'off',
    reviewWindowMs: Number(settings.reviewWindowMs) || 2500,
    canary: isCanary
  };

  // Navigate the existing tab in place. While `chrome.tabs.update` is in
  // flight, the tab can be closed (onRemoved → failPendingFill clears
  // pendingFill). We must guard the final write to avoid resurrecting a
  // dead cycle.
  try {
    await chrome.tabs.update(cooldownPf.tabId, { url: lead.linkedinUrl });
  } catch (_e) {
    await failPendingFill('tab_navigation_failed', 'cooldown');
    pushStateUpdate().catch(() => {});
    return;
  }

  let wrote = false;
  await withRuntime((rt) => {
    const cur = rt.pendingFill;
    // Only write if pendingFill is STILL the cooldown we read at function entry.
    if (!cur || cur.cycleId !== cooldownPf.cycleId || cur.stage !== 'cooldown') {
      return null;
    }
    wrote = true;
    return { pendingFill: newPending, lastOpenedAt: now };
  });
  if (!wrote) {
    // Another listener (onRemoved, user pause, set autoMode off) cleared
    // the cycle while we were navigating. Don't resurrect.
    return;
  }
  pushStateUpdate().catch(() => {});
}

/**
 * On SW startup, if the previous run left pendingFill in `cooldown` with a
 * future deadline, re-create the alarm so the chain resumes. If the deadline
 * is already past, fire immediately.
 */
async function restoreCycleAlarmIfNeeded() {
  const runtime = await loadRuntime();
  const pf = runtime.pendingFill;
  if (!pf || pf.stage !== 'cooldown' || !pf.cooldownDeadline) return;
  const existing = await chrome.alarms.get('autoNextCycle');
  if (existing) return;
  const when = Math.max(Date.now() + 5_000, Number(pf.cooldownDeadline));
  try { chrome.alarms.create('autoNextCycle', { when }); } catch (_e) {}
}

/** @param {any} event */
async function onRecordTelemetry(event) {
  await withRuntime((rt) => ({
    eventLog: appendEvent(rt.eventLog, event)
  }));
  return { ok: true };
}

/** @param {string} mode */
async function onSetAutoMode(mode) {
  const allowed = new Set(['off', 'dry_run', 'on']);
  const next = allowed.has(mode) ? mode : 'off';
  /** @type {Partial<typeof import('../lib/state.js').SETTINGS_DEFAULTS>} */
  const settingsPatch = { autoMode: next };
  // First-time enabling stamps an acknowledgment so the popup's first-run
  // dialog doesn't fire again.
  const prev = await loadSettings();
  if (next !== 'off' && !prev.autoModeAcknowledgedAt) {
    settingsPatch.autoModeAcknowledgedAt = Date.now();
  }
  await saveSettings(settingsPatch);

  // Re-enabling clears any stale backoff and resets the consecutive-error
  // streak. Disabling cancels the next-cycle alarm AND clears any
  // pendingFill that's stuck in cooldown (so the popup doesn't keep showing
  // "step 8/9 — cooling down…" until the watchdog catches it).
  if (next === 'off') {
    try { await chrome.alarms.clear('autoNextCycle'); } catch (_e) {}
    await withRuntime((rt) => {
      if (rt.pendingFill && rt.pendingFill.stage === 'cooldown') {
        return { pendingFill: null };
      }
      return null;
    });
  } else {
    await saveRuntime({
      autoBackoffPausedAt: 0,
      consecutiveErrors: 0,
      lastErrorCode: '',
      canaryNeeded: true,
      sendsSinceCanary: 0
    });
  }
  return { ok: true, state: await buildState() };
}

async function onPauseAuto() {
  // Pause is a panic-stop. Setting autoPaused isn't enough on its own — a CS
  // already mid-pipeline will continue executing through subsequent stages
  // (including the live Send click) because `tryMarkStage` on transitions
  // doesn't read the autoPaused flag.
  //
  // Clearing pendingFill here makes the next `tryMarkStage` call from the
  // CS fail with `no_pending`, which the CS handles by aborting. This
  // doesn't help if pause hits in the tiny window between Send click and
  // success-detection (the click already went out), but it stops cycles
  // that haven't reached the click yet.
  await withRuntime((rt) => {
    /** @type {Partial<typeof rt>} */
    const patch = { autoPaused: true };
    if (rt.pendingFill) patch.pendingFill = null;
    return patch;
  });
  try { await chrome.alarms.clear('autoNextCycle'); } catch (_e) {}
  return { ok: true, state: await buildState() };
}

async function onResumeAuto() {
  await saveRuntime({
    autoPaused: false,
    autoBackoffPausedAt: 0,
    consecutiveErrors: 0,
    lastErrorCode: '',
    // H6: also clear the rendered banner text so the popup doesn't keep
    // showing the stale error that triggered the pause.
    lastError: ''
  });
  return { ok: true, state: await buildState() };
}
