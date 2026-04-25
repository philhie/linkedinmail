// @ts-check
import { friendlyError, humanStage } from '../lib/errors.js';

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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'STATE_UPDATED') render(msg.state);
  });
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

  // Pending fill banner (Phase 2 multi-stage)
  const pendingBanner = $('pending-banner');
  if (state.pendingFill) {
    pendingBanner.hidden = false;
    $('pending-row').textContent = String(state.pendingFill.row);
    $('pending-stage').textContent = humanStage(state.pendingFill.stage);
  } else {
    pendingBanner.hidden = true;
  }

  // Tier dropdown
  /** @type {HTMLSelectElement} */
  const tierSelect = /** @type {HTMLSelectElement} */ ($('tier-select'));
  if (tierSelect.value !== state.tierFilter) tierSelect.value = state.tierFilter;

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
    $('open-fill-btn').setAttribute('title', 'Open the LinkedIn profile and pre-fill the InMail composer. You always click Send manually.');
  }
}
