// @ts-check
import { friendlyError, humanStage, stageStep } from '../lib/errors.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

let lastState = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireEvents();
  await refresh();
}

function wireEvents() {
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('open-options-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('next-btn').addEventListener('click', () => send({ type: 'NAV', direction: 'next' }));
  $('prev-btn').addEventListener('click', () => send({ type: 'NAV', direction: 'prev' }));
  $('skip-btn').addEventListener('click', () => send({ type: 'SKIP' }));
  $('mark-sent-btn').addEventListener('click', () => send({ type: 'MARK_SENT' }));
  $('extend-btn').addEventListener('click', () =>
    send({ type: 'EXTEND_TARGET_TODAY', amount: 25 }));

  /** @type {HTMLSelectElement} */
  const tierSelect = /** @type {HTMLSelectElement} */ ($('tier-select'));
  tierSelect.addEventListener('change', () =>
    send({ type: 'SET_TIER', tier: tierSelect.value }));

  $('open-fill-btn').addEventListener('click', () => send({ type: 'OPEN_AND_FILL' }));

  // Auto-mode toggle (3 segments). Off → no confirmation. Anything else →
  // first-time confirmation dialog (settings.autoModeAcknowledgedAt gates it).
  document.querySelectorAll('#auto-mode-section .seg').forEach((el) => {
    el.addEventListener('click', () => onAutoModeClick(el.getAttribute('data-mode') || 'off'));
  });
  $('pause-auto-btn').addEventListener('click', () => send({ type: 'PAUSE_AUTO' }));
  $('resume-auto-btn').addEventListener('click', () => send({ type: 'RESUME_AUTO' }));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'STATE_UPDATED') render(msg.state);
  });
}

/** @param {string} mode */
async function onAutoModeClick(mode) {
  if (!lastState) return;
  // No-op if already in this mode.
  if (lastState.autoMode === mode) return;

  // First-time enabling: show the risk-acknowledgment dialog.
  if (mode !== 'off' && !lastState.autoModeAcknowledgedAt) {
    const dialog = /** @type {HTMLDialogElement} */ ($('auto-mode-confirm-dialog'));
    dialog.returnValue = '';
    dialog.showModal();
    await new Promise((resolve) => {
      dialog.addEventListener('close', resolve, { once: true });
    });
    if (dialog.returnValue !== 'ok') return; // user cancelled
  }

  // Toggling Off mid-cycle: confirm via <dialog> so accidental clicks don't
  // silently kill an in-flight chain.
  if (mode === 'off' && lastState.pendingFill && lastState.autoMode !== 'off') {
    const dialog = /** @type {HTMLDialogElement} */ ($('auto-mode-off-dialog'));
    dialog.returnValue = '';
    dialog.showModal();
    await new Promise((resolve) => {
      dialog.addEventListener('close', resolve, { once: true });
    });
    if (dialog.returnValue !== 'ok') return;
  }

  await send({ type: 'SET_AUTO_MODE', mode });
}

/** @param {object} message */
async function send(message) {
  setBusy(true);
  try {
    const res = await chrome.runtime.sendMessage(message);
    if (res && res.ok && res.state) render(res.state);
    else if (res && res.ok) { /* no state to render — likely a notification-style ack */ }
    else if (res && !res.ok) showError(res.error || 'unknown_error');
    else if (!res) showError('no_response_from_service_worker');
  } catch (err) {
    showError(String(err && err.message || err));
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  await send({ type: 'GET_STATE' });
}

function setBusy(busy) {
  document.body.style.opacity = busy ? '0.6' : '1';
  document.body.style.pointerEvents = busy ? 'none' : 'auto';
}

/** @param {string} message */
function showError(message) {
  const banner = $('error-banner');
  $('error-message').textContent = friendlyError(message);
  banner.hidden = false;
}

function hideError() {
  $('error-banner').hidden = true;
}

function render(state) {
  lastState = state;
  hideError();

  // Connection / setup banner
  const dot = $('conn-dot');
  if (!state.settingsConfigured) {
    dot.className = 'conn-dot warn';
    $('needs-setup').hidden = false;
  } else if (state.offline) {
    dot.className = 'conn-dot bad';
    $('needs-setup').hidden = true;
  } else {
    dot.className = 'conn-dot ok';
    $('needs-setup').hidden = true;
  }

  // Error from last fetch
  if (state.lastError) showError(state.lastError);

  // Target banner
  const targetBanner = $('target-banner');
  if (state.targetReached) {
    targetBanner.hidden = false;
    $('banner-count').textContent = `${state.dailyCount}/${state.effectiveTarget}`;
  } else {
    targetBanner.hidden = true;
  }

  // Pending fill banner — now shows step N/9 from the pipeline.
  const pendingBanner = $('pending-banner');
  const canaryBanner = $('canary-banner');
  if (state.pendingFill) {
    pendingBanner.hidden = false;
    $('pending-row').textContent = String(state.pendingFill.row);
    const step = stageStep(state.pendingFill.stage);
    const stepLabel = step > 0 ? `step ${step}/9 — ` : '';
    $('pending-stage').textContent = stepLabel + humanStage(state.pendingFill.stage);
    // Canary banner is mutually-exclusive with the regular pending banner.
    canaryBanner.hidden = !state.pendingFill.canary;
  } else {
    pendingBanner.hidden = true;
    canaryBanner.hidden = true;
  }

  // Tier dropdown
  /** @type {HTMLSelectElement} */
  const tierSelect = /** @type {HTMLSelectElement} */ ($('tier-select'));
  if (tierSelect.value !== state.tierFilter) tierSelect.value = state.tierFilter;

  // Auto-mode section
  renderAutoMode(state);

  // Lead card
  const lead = state.lead;
  if (lead) {
    $('lead-card').hidden = false;
    $('lead-name').textContent = `${lead.firstName} ${lead.lastName}`.trim() || '(no name)';
    $('lead-title').textContent = lead.title || '';
    $('lead-company').textContent = lead.company || '';
    $('lead-domain').textContent = lead.domain || '';
    $('lead-score').textContent = lead.score ? `score ${lead.score}` : '';
    $('lead-finding').textContent = lead.findingShort || '';

    const pill = $('lead-tier');
    pill.className = 'tier-pill';
    if (lead.tier) {
      pill.classList.add(`tier-${lead.tier}`);
      pill.textContent = lead.tier;
    } else {
      pill.textContent = '—';
    }

    // InMail
    const inmailBody = $('inmail-body');
    if (lead.inmail) {
      $('inmail-section').hidden = false;
      inmailBody.textContent = lead.inmail;
    } else {
      $('inmail-section').hidden = true;
    }

    // Follow-up
    if (lead.followUp) {
      $('followup-section').hidden = false;
      $('followup-body').textContent = lead.followUp;
    } else {
      $('followup-section').hidden = true;
    }
  } else {
    $('lead-card').hidden = true;
    $('inmail-section').hidden = true;
    $('followup-section').hidden = true;
  }

  // Footer
  $('progress-text').textContent =
    `${state.dailyCount}/${state.effectiveTarget} today`;
  $('row-text').textContent = `row ${state.currentRow}`;

  // Buttons enabled/disabled
  const noLead = !lead;
  const noUrl = !lead || !lead.linkedinUrl;
  $('prev-btn').toggleAttribute('disabled', noLead);
  $('next-btn').toggleAttribute('disabled', noLead);
  $('skip-btn').toggleAttribute('disabled', noLead);
  $('mark-sent-btn').toggleAttribute('disabled', noLead || state.targetReached);
  $('open-fill-btn').toggleAttribute('disabled', noLead || noUrl || state.targetReached);
  if (noUrl && lead) {
    $('open-fill-btn').setAttribute('title', 'This lead has no LinkedIn URL.');
  } else if (state.targetReached) {
    $('open-fill-btn').setAttribute('title', 'Daily target reached.');
  } else {
    $('open-fill-btn').setAttribute('title', 'Open the LinkedIn profile and pre-fill the InMail composer.');
  }
}

/** @param {any} state */
function renderAutoMode(state) {
  const mode = String(state.autoMode || 'off');
  const isLive = mode === 'on';
  const isArmed = mode !== 'off';

  // Highlight the active segment.
  document.querySelectorAll('#auto-mode-section .seg').forEach((el) => {
    const m = el.getAttribute('data-mode');
    el.classList.toggle('active', m === mode);
    el.classList.toggle('live', m === 'on' && mode === 'on');
  });

  // Status row: step pill + pause/resume buttons
  const status = $('auto-mode-status');
  const stepEl = $('auto-mode-step');
  const pauseBtn = $('pause-auto-btn');
  const resumeBtn = $('resume-auto-btn');

  if (!isArmed) {
    status.hidden = true;
  } else {
    status.hidden = false;
    let text = mode === 'dry_run' ? 'Dry-run armed' : 'Auto-mode armed';
    if (state.autoPaused) text = 'Paused';
    else if (state.autoBackoffPausedAt) text = 'Auto-backoff (errors)';
    else if (state.pendingFill) {
      const step = stageStep(state.pendingFill.stage);
      const label = humanStage(state.pendingFill.stage);
      text = step > 0 ? `step ${step}/9 — ${label}` : label || text;
    }
    stepEl.textContent = text;
    stepEl.className = 'step-pill';
    if (state.autoPaused || state.autoBackoffPausedAt) stepEl.classList.add('paused');
    else if (isLive) stepEl.classList.add('live');

    // Pause when armed + not paused; Resume when paused or backoff.
    const showPause  = isArmed && !state.autoPaused && !state.autoBackoffPausedAt;
    const showResume = state.autoPaused || state.autoBackoffPausedAt > 0;
    pauseBtn.hidden  = !showPause;
    resumeBtn.hidden = !showResume;
  }

  // Recent sends
  const recent = $('recent-sends');
  const list = $('recent-sends-list');
  const events = Array.isArray(state.recentEvents) ? state.recentEvents : [];
  if (events.length === 0) {
    recent.hidden = true;
  } else {
    recent.hidden = false;
    list.innerHTML = '';
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const li = document.createElement('li');
      const when = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const row = (typeof e.row === 'number') ? `row ${e.row}` : '—';
      const action = e.action || '?';
      const errStr = e.errorCode ? ` · ${e.errorCode}` : '';
      const sigStr = e.signal ? ` · ${e.signal}` : '';
      li.textContent = `${when} · ${row} · ${action}${sigStr}${errStr}`;
      li.className = `evt evt-${e.outcome || 'ok'}`;
      list.appendChild(li);
    }
  }
}
