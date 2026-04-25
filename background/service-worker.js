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
  loadRuntime, saveRuntime,
  maybeResetDaily, berlinDeDate, appendLeadCache, getCachedLead,
  activePendingFill, PENDING_FILL_TTL_MS,
  migrateTokenStorageOnce
} from '../lib/state.js';
import { hasLinkedinUrl } from '../lib/lead.js';
import { isValidStageTransition } from '../lib/errors.js';
import {
  findTierMatch, appendPendingWrite, drainPendingWrites
} from '../lib/sw_logic.js';

chrome.runtime.onInstalled.addListener(async () => {
  await migrateTokenStorageOnce().catch(() => {});
  // Force defaults to materialize so options page shows real numbers.
  const settings = await loadSettings();
  await saveSettings(settings);
  const runtime = maybeResetDaily(await loadRuntime());
  await saveRuntime(runtime);
  await ensureDailyAlarm();
  drainQueueIfPossible().catch(() => {});
});

chrome.runtime.onStartup?.addListener(async () => {
  await ensureDailyAlarm();
  drainQueueIfPossible().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dailyReset') {
    const runtime = maybeResetDaily(await loadRuntime());
    await saveRuntime(runtime);
    pushStateUpdate().catch(() => {});
  }
});

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
    default:                    return { ok: false, error: 'unknown_type:' + msg.type };
  }
}

async function buildState() {
  const settings = await loadSettings();
  let runtime = maybeResetDaily(await loadRuntime());
  if (!runtime.currentRow || runtime.currentRow < settings.startRow) {
    runtime = { ...runtime, currentRow: settings.startRow };
  }
  await saveRuntime({
    currentRow: runtime.currentRow,
    dailyCount: runtime.dailyCount,
    dailySentRows: runtime.dailySentRows,
    lastResetDate: runtime.lastResetDate,
    todaysTargetOverride: runtime.todaysTargetOverride
  });

  let lead = null;
  let offline = false;
  try {
    lead = await getLeadCached(settings, runtime, runtime.currentRow);
  } catch (err) {
    offline = true;
    lead = getCachedLead(runtime.leadCache, runtime.currentRow) || null;
    runtime = { ...runtime, lastError: String(err && err.message || err) };
  }

  const effectiveTarget = settings.dailyTarget + (runtime.todaysTargetOverride || 0);
  const pendingFill = activePendingFill(runtime.pendingFill);
  const pendingWrites = runtime.pendingWrites || [];
  return {
    settings,
    lead,
    offline,
    currentRow: runtime.currentRow,
    dailyCount: runtime.dailyCount,
    effectiveTarget,
    dailyTarget: settings.dailyTarget,
    todaysTargetOverride: runtime.todaysTargetOverride,
    targetReached: runtime.dailyCount >= effectiveTarget,
    tierFilter: settings.tierFilter,
    lastError: runtime.lastError || (offline ? 'offline' : ''),
    settingsConfigured: Boolean(settings.appsScriptUrl && settings.appsScriptToken),
    pendingFill: pendingFill ? { row: pendingFill.row, stage: pendingFill.stage } : null,
    pendingWritesCount: pendingWrites.length
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
  const runtime = maybeResetDaily(await loadRuntime());
  const effectiveTarget = settings.dailyTarget + (runtime.todaysTargetOverride || 0);
  if (runtime.dailyCount >= effectiveTarget) {
    return { ok: false, error: 'daily_target_reached' };
  }
  const row = runtime.currentRow;
  const date = berlinDeDate();

  // Optimistic UI: queue the write, increment count, advance row, return state.
  const pendingWrites = appendPendingWrite(runtime.pendingWrites || [], row, 'gesendet', date);
  const dailySentRows = [...runtime.dailySentRows, row];
  await saveRuntime({
    pendingWrites,
    dailyCount: runtime.dailyCount + 1,
    dailySentRows,
    lastResetDate: runtime.lastResetDate,
    lastError: ''
  });
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
  const runtime = maybeResetDaily(await loadRuntime());
  const effectiveTarget = settings.dailyTarget + (runtime.todaysTargetOverride || 0);
  if (runtime.dailyCount >= effectiveTarget) {
    return { ok: false, error: 'daily_target_reached' };
  }

  const state = await buildState();
  const lead = state.lead;
  if (!lead) return { ok: false, error: 'no_lead' };
  if (!hasLinkedinUrl(lead)) return { ok: false, error: 'no_linkedin_url' };

  // Rate limit (configurable, defaults to 10s).
  const lastOpenedAt = runtime.lastOpenedAt || 0;
  const elapsed = Date.now() - lastOpenedAt;
  const minMs = Math.max(0, Number(settings.minIntervalSeconds || 0) * 1000);
  if (elapsed < minMs) {
    const waitSec = Math.ceil((minMs - elapsed) / 1000);
    return { ok: false, error: `rate_limited:${waitSec}` };
  }

  // Open the tab FIRST so we can capture its tabId in pendingFill — this is
  // the key safety check: pendingFill is only ever delivered to the tab Phil
  // opened, never to an unrelated /talent/profile/ tab.
  const now = Date.now();
  const tab = await chrome.tabs.create({ url: lead.linkedinUrl, active: true });
  if (typeof tab.id !== 'number') {
    return { ok: false, error: 'tab_create_failed' };
  }

  const pendingFill = {
    row: lead.row,
    subject: settings.inmailSubject || 'kurze frage',
    inmail: lead.inmail || '',
    followUp: lead.followUp || '',
    stage: 'await_recruiter',
    startedAt: now,
    expiresAt: now + PENDING_FILL_TTL_MS,
    tabId: tab.id,
    linkedinUrl: lead.linkedinUrl
  };
  await saveRuntime({ pendingFill, lastOpenedAt: now, lastError: '' });

  return { ok: true, state: await buildState() };
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
  /** @type {Record<string, unknown>} */
  const patch = { pendingFill: null };
  if (errorCode) {
    patch.lastError = errorCode;
  } else {
    // Success path — clear any stale lastError so the popup banner clears too.
    patch.lastError = '';
  }
  await saveRuntime(patch);
  pushStateUpdate().catch(() => {});
  return { ok: true };
}

/** @param {string} stage */
async function onMarkPendingStage(stage) {
  const runtime = await loadRuntime();
  const active = activePendingFill(runtime.pendingFill);
  if (!active) return { ok: false, error: 'no_pending' };
  if (!isValidStageTransition(active.stage, stage)) {
    return { ok: false, error: `invalid_stage_transition:${active.stage}_to_${stage}` };
  }
  await saveRuntime({ pendingFill: { ...active, stage } });
  return { ok: true };
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
  try {
    await chrome.runtime.sendMessage({ type: 'STATE_UPDATED', state });
  } catch (_e) {
    // Popup may be closed; that's fine.
  }
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

function nextLocalMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
