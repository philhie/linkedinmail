// @ts-check

/**
 * LinkedIn Recruiter content script.
 *
 * Two-stage flow (one fill spans two content-script lifecycles):
 *
 *   Stage 1 (URL matches /in/...)
 *     - Find "In Recruiter anzeigen" link → click → page navigates to /talent/profile/...
 *     - The CS dies on navigation; the new CS instance picks up stage 2.
 *
 *   Stage 2 (URL matches /talent/profile/...)
 *     - Find Recruiter "Nachricht an X" / "Message X" / "InMail X" button → click
 *     - Wait for composer, fill subject input
 *     - Fill body editor (Quill) with InMail text
 *     - Click "Folgenachricht hinzufügen" / "Add follow-up" → fill follow-up editor
 *     - Send button is NEVER clicked by us. Phil reviews, clicks Send.
 *
 * Tab identity: SW only delivers pendingFill if `sender.tab.id === pendingFill.tabId`.
 * On /in/, we additionally verify `location.href` against `pendingFill.linkedinUrl`
 * as defense in depth.
 *
 * State is held by the service worker in chrome.storage.local.pendingFill.
 * The CS pulls state via GET_PENDING_FILL on every load.
 *
 * IMPORTANT: LinkedIn DOM rotates often. SELECTORS + LOCALE blocks below are
 * the only place to tweak when something stops working.
 */

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------

const SELECTORS = {
  // /in/ → /talent/profile/ navigation. The "In Recruiter anzeigen" anchor.
  // We require the href contain `FLAGSHIP_VIEW_IN_RECRUITER` OR pick by text.
  recruiterLink: 'a[href*="/talent/profile/"][href*="FLAGSHIP_VIEW_IN_RECRUITER"], a[href*="/talent/profile/"]',

  // Recruiter "Nachricht an X" button lives inside the topcard action area.
  recruiterActionsScope: '.topcard-condensed__actions .shared-action-buttons, .topcard-condensed__actions',

  // Quill body editor in the right-rail composer.
  composerBodyEditor: [
    '.profile__right-rail-composer [contenteditable="true"][role="textbox"]',
    '.profile__right-rail-message-composer [contenteditable="true"][role="textbox"]',
    '.messaging-composer .ql-editor[contenteditable="true"]',
    '.ql-editor[contenteditable="true"][role="textbox"]'
  ].join(', '),

  // Subject input (auto-filled with settings.inmailSubject).
  composerSubject: 'input[aria-label*="Betreff" i], input[aria-label*="Subject" i], input[placeholder*="Betreff" i]',

  // Follow-up button (icon button in the composer toolbar).
  addFollowUpButton: [
    'button[aria-label^="Follow-up-Nachricht hinzufügen" i]',
    'button[aria-label^="Add follow-up" i]',
    'button[aria-label*="follow-up" i][aria-label*="hinzufügen" i]',
    'button[aria-label*="Folgenachricht" i]'
  ].join(', '),

  // Follow-up editor (second .ql-editor in the composer).
  followUpEditor: '.messaging-composer .ql-editor[contenteditable="true"]',

  // Walked-up containers we may anchor to from the body editor — used to
  // scope the Send-button query so we never grab "Save as draft" / "Save as
  // template" by mistake. List in order of preference.
  composerScopeCandidates: [
    '.profile__right-rail-message-composer',
    '.profile__right-rail-composer',
    '.messaging-composer',
    '.compose-form'
  ],

  // Confirmation modal (some Recruiter tiers show it on Send).
  confirmModal: '.artdeco-modal[role="dialog"], [role="alertdialog"], [data-test-modal]',

  // Toast / snackbar — observed for send success/failure signals.
  successToast: '.artdeco-toast-item__message, [role="alert"], .notification-message, [data-test-toast]',

  sessionExpiredHint: 'a[href*="/login"], a[href*="/uas/login"], a[href*="checkpoint/lg/login"]'
};

const LOCALE = {
  // Recruiter Message button text patterns (prefix match — the full text
  // includes the lead's name, e.g. "Nachricht an Marco Willenbrock").
  recruiterMessageButtonPrefixes: ['Nachricht an ', 'Message ', 'InMail '],

  // Send-button label set. Matched both by aria-label and by innerText. Each
  // entry is treated as either an exact match or a prefix match (LinkedIn
  // sometimes appends an icon-suffix to text but never to aria-label).
  sendButtonTexts: ['Senden', 'Send', 'InMail senden', 'Send InMail', 'Nachricht senden'],

  // Send-button defensive blacklist — never accept a button matching any of
  // these texts, even if the rest of the heuristic matches. Each token is
  // anchored to whole-word matches to avoid false-positives on e.g. "Senden
  // mit Folgenachricht" (would match `folge`) or coincidental substrings.
  sendButtonBlacklist: /\b(entwurf|draft|vorlage|template|verwerfen|discard|abbrechen|cancel|folgenachricht|follow-?up|hinzufügen|schedule|terminieren|speichern|save)\b/i,

  // Confirmation-modal proceed button (when LinkedIn Lite shows it).
  confirmProceedTexts: ['Senden', 'Send', 'Bestätigen', 'Confirm', 'Continue', 'Weiter', 'Ja, senden', 'Yes, send', 'OK'],

  // Confirmation-modal cancel/dismiss buttons (skip these even if labelled).
  confirmCancelMatch: /abbrechen|cancel|close|nein|^no$|schließen/i,

  // Positive send-success toast patterns. Match → mark sent + advance.
  successToastPositive: [
    /InMail\s+(gesendet|sent)/i,
    /Nachricht\s+(gesendet|sent)/i,
    /Ihre\s+InMail\s+wurde\s+gesendet/i,
    /Message\s+sent/i,
    /^(Gesendet|Sent)$/i
  ],

  // Negative toast patterns — when LinkedIn rate-limits or flags. Hard stop.
  successToastNegative: [
    /\bzu\s+viele\b/i,
    /\btoo\s+many\b/i,
    /\bplease\s+wait\b/i,
    /\btry\s+again\s+later\b/i,
    /\bspam\b/i,
    /\bflagged\b/i,
    /\brestricted\b/i,
    /\beingeschr(ä|a)nkt\b/i,
    /\bgesperrt\b/i,
    /\bblocked\b/i,
    /\bmessage\s+limit\b/i
  ],

  // Recipient-paused-InMail notice text inside the composer. Phrase-level
  // matches only — bare /\bpaused\b/i false-positives on near-composer help
  // text like "Pause notifications". If detected pre-send, skip the lead.
  recipientPausedTexts: [
    /\binmails?\s+pausiert\b/i,
    /\binmails?\s+paused\b/i,
    /\bhas\s+paused\b.*\bmessages?\b/i,
    /\bnachrichten\s+pausiert\b/i,
    /\bwill\s+not\s+receive\b/i,
    /\bwon['’]t\s+receive\b/i,
    /\bnicht\s+erhalten\b.*\binmail\b/i
  ]
};

const TIMINGS = {
  recruiterLinkAppearMs: 12_000,
  composerOpenMs:        10_000,
  editorAppearMs:         8_000,
  followUpAppearMs:       5_000,
  betweenInsertMs:          250,
  // Auto-mode pipeline timings
  reviewWindowMsDefault:   2500,  // override via pending.reviewWindowMs
  sendModalWaitMs:         2000,  // poll for confirm modal up to this long
  successSignalMs:        15_000, // observation window after send click
  canarySignalMs:         60_000, // canary cycle: Phil has up to 60s to click
  postSendDwellMs:           800  // brief grace before exiting the CS
};

// ----------------------------------------------------------------------------
// Top-level wiring — pull-based: on load, ask SW for any pending fill.
// ----------------------------------------------------------------------------

/* global chrome, document, location, window, MutationObserver, setTimeout, console, InputEvent, ClipboardEvent, DataTransfer */

(async function main() {
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY', url: location.href }).catch(() => {});

    if (isLoggedOut()) {
      const pending = await getPending();
      if (pending) await clearPending('session_expired');
      return;
    }

    const pending = await getPending();
    if (!pending) return; // SW says nothing for this tab — done

    if (isRecruiterProfile(location.href)) {
      await runRecruiterFill(pending);
    } else if (isRegularProfile(location.href)) {
      await runJumpToRecruiter(pending);
    }
    // Other LinkedIn URLs: ignore.
  } catch (err) {
    log('main error', err);
    try { await clearPending('main_unhandled:' + safeMsg(err)); } catch (_e) {}
  }
})();

// Keep PING for SW health-checks if it ever wants one.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ----------------------------------------------------------------------------
// Stage 1 — on /in/ pages: click "In Recruiter anzeigen"
// ----------------------------------------------------------------------------

/** @param {{linkedinUrl?:string, stage:string, recruiterProfileId?:string}} pending */
async function runJumpToRecruiter(pending) {
  // Defense in depth: even though SW filters by tabId, also verify URL match.
  if (pending.linkedinUrl &&
      !urlsRefSameProfile(location.href, pending.linkedinUrl)) {
    await clearPending('wrong_url');
    return;
  }

  // Zombie cleanup: if the prior CS instance already advanced stage to
  // await_composer but we're back on /in/ (e.g., navigation was undone),
  // the pending is stale — clear it.
  if (pending.stage === 'await_composer') {
    await clearPending('stage_2_on_in_page');
    return;
  }

  const link = await waitFor(SELECTORS.recruiterLink, TIMINGS.recruiterLinkAppearMs);
  if (!link) {
    await clearPending('recruiter_link_not_found');
    return;
  }
  const href = /** @type {HTMLAnchorElement} */ (link).href;
  if (!href) {
    await clearPending('recruiter_link_no_href');
    return;
  }
  // Capture the recruiter profile ID from the href so stage 2 can verify the
  // navigated URL still matches the intended profile (defense against SPA
  // route changes that could redirect us to a different lead's composer).
  const recruiterProfileId = extractRecruiterProfileId(href);
  if (recruiterProfileId) {
    try {
      await chrome.runtime.sendMessage({
        type: 'SET_PENDING_PROFILE_ID',
        recruiterProfileId
      });
    } catch (_e) { /* SW death — stage 2 will fail safe */ }
  }
  await markStage('await_composer');
  // Same-tab nav so we keep the same tabId for stage 2.
  location.href = href;
}

/**
 * Extract the recruiter profile ID from a "/talent/profile/<id>" URL. The
 * trailing path segment after `/profile/` (with any query/fragment stripped)
 * is the stable identifier LinkedIn uses to scope a profile.
 *
 * @param {string} url
 * @returns {string | null}
 */
function extractRecruiterProfileId(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/talent\/profile\/([^/?#]+)/);
  return (m && m[1]) || null;
}

// ----------------------------------------------------------------------------
// Stage 2 — on /talent/profile/ pages: open composer, fill subject + body + follow-up
// ----------------------------------------------------------------------------

/** @param {{subject?:string, inmail:string, followUp:string, row:number, stage:string, recruiterProfileId?:string}} pending */
async function runRecruiterFill(pending) {
  // Defense in depth (M7 from the review): if stage 1 captured a recruiter
  // profile ID, verify the current /talent/profile/ URL still matches it.
  // SPA route changes during stage 1→2 (e.g., user clicked into a sidebar
  // suggestion) could land us on the wrong profile.
  if (pending.recruiterProfileId) {
    const onPageId = extractRecruiterProfileId(location.href);
    if (onPageId && onPageId !== pending.recruiterProfileId) {
      log('auto: stage-2 profile id mismatch', { expected: pending.recruiterProfileId, got: onPageId });
      await clearPending('wrong_profile_stage2');
      return;
    }
  }

  // 1. Find and click the Recruiter Message button (scoped to topcard actions).
  const messageBtn = await waitForRecruiterMessageButton();
  if (!messageBtn) {
    await clearPending('recruiter_message_button_not_found');
    return;
  }
  messageBtn.click();

  // 2. Wait for the body editor to appear in the composer.
  const bodyEditor = await waitFor(SELECTORS.composerBodyEditor, TIMINGS.editorAppearMs);
  if (!bodyEditor) {
    await clearPending('composer_body_editor_not_found');
    return;
  }
  await sleep(300);

  // 3. Fill the subject input (best-effort — never fatal if missing).
  const subject = (pending.subject || '').trim();
  if (subject) {
    const subjectInput = document.querySelector(SELECTORS.composerSubject);
    if (subjectInput) setInputValue(/** @type {HTMLInputElement} */ (subjectInput), subject);
  }

  // 4. Fill the body editor.
  insertIntoQuill(/** @type {HTMLElement} */ (bodyEditor), pending.inmail || '');
  await sleep(TIMINGS.betweenInsertMs);

  // 5. Optionally add follow-up.
  if (pending.followUp && pending.followUp.trim().length > 0) {
    const followBtn = document.querySelector(SELECTORS.addFollowUpButton);
    if (!followBtn) {
      await clearPending('add_follow_up_button_not_found');
      return;
    }
    /** @type {HTMLElement} */ (followBtn).click();

    const followUpEditor = await waitForSecondQlEditor(TIMINGS.followUpAppearMs);
    if (!followUpEditor) {
      await clearPending('follow_up_editor_not_found');
      return;
    }
    await sleep(300);

    // LinkedIn Recruiter recently added a separate subject input for the
    // follow-up message ("Betreff eingeben" — required to send). When a
    // second subject input is present, fill it with the same subject as
    // the main InMail. Follow-ups are continuations in the same thread, so
    // reusing the subject is correct (and matches what a human would type).
    if (subject) {
      const allSubjectInputs = document.querySelectorAll(SELECTORS.composerSubject);
      if (allSubjectInputs.length >= 2) {
        const followUpSubjectInput = /** @type {HTMLInputElement} */ (
          allSubjectInputs[allSubjectInputs.length - 1]
        );
        const cur = followUpSubjectInput.value || '';
        if (!cur.trim()) {
          setInputValue(followUpSubjectInput, subject);
        }
      }
    }

    insertIntoQuill(followUpEditor, pending.followUp);
  }

  // 6. Paste done. Branch on auto-mode:
  //    - off     → manual flow as today (clear pendingFill, Phil clicks Send).
  //    - dry_run → run the new pipeline; log + tell SW; do NOT click.
  //    - on      → run pipeline; CLICK Send; handle modal; verify success.
  //              UNLESS this is a canary cycle (first cycle of session OR
  //              cadence canary), in which case we don't click — we wait for
  //              Phil to click manually so he can verify selectors fired.
  const autoMode = String(pending.autoMode || 'off');
  if (autoMode === 'dry_run' || autoMode === 'on') {
    await runAutoSendPipeline(
      pending,
      /** @type {HTMLElement} */ (bodyEditor),
      /* dryRun */ autoMode === 'dry_run',
      /* canary */ Boolean(pending.canary)
    );
    return;
  }
  await clearPending('');
}

// ----------------------------------------------------------------------------
// Auto-send pipeline (Step 4 — dry-run only; Step 6 unsuppresses the click)
// ----------------------------------------------------------------------------

/**
 * After a successful paste, walk the pendingFill through the auto-mode stages
 * (review → send_click → modal → success → advance).
 *
 * Three pipeline modes:
 *   - dry_run: log "would click" and tell SW; suppress the actual click.
 *   - canary:  do NOT click; wait up to 60s for Phil to click Send manually
 *     and observe the resulting success signal. Phil's manual click DOES
 *     send the message, so we mark sent + clear canaryNeeded but do NOT
 *     chain (Phil verifies, then triggers the next cycle himself).
 *   - live:    click Send, handle confirm modal, verify success, advance.
 *
 * @param {{subject?:string, inmail:string, followUp:string, row:number, stage:string, autoMode?:string, reviewWindowMs?:number, cycleId?:string, canary?:boolean}} pending
 * @param {HTMLElement} bodyEditor
 * @param {boolean} dryRun
 * @param {boolean} [canary]
 */
async function runAutoSendPipeline(pending, bodyEditor, dryRun, canary) {
  const composerScope = findComposerScope(bodyEditor);
  if (!composerScope) {
    log('auto: composer scope not found from body editor');
    await clearPending('composer_body_editor_not_found');
    return;
  }

  // Recipient-paused / blocked check before we waste cycles further down.
  if (composerHasRecipientPaused(composerScope)) {
    log('auto: recipient appears paused — skipping');
    await clearPending('recipient_unreachable');
    return;
  }

  // Stage: await_review — give Quill/React a tick to settle, then re-verify.
  if (!(await tryMarkStage('await_review'))) return;
  const reviewMs = Number(pending.reviewWindowMs) || TIMINGS.reviewWindowMsDefault;
  await sleep(Math.max(0, reviewMs));

  const verify = verifyComposerStateBeforeSend(pending, bodyEditor, composerScope);
  if (!verify.ok) {
    log('auto: pre-send verify failed', verify);
    await clearPending(`${verify.code}:${verify.detail}`);
    return;
  }

  // Stage: await_send_click — locate the Send button.
  if (!(await tryMarkStage('await_send_click'))) return;
  const sendBtn = findSendButton(composerScope);
  if (sendBtn.ambiguous) {
    log('auto: multiple Send-like buttons matched; refusing to click');
    await clearPending('send_button_ambiguous');
    return;
  }
  if (!sendBtn.button) {
    log('auto: no Send button found in composer scope');
    await clearPending('send_button_not_found');
    return;
  }
  if (sendBtn.button.disabled || sendBtn.button.getAttribute('aria-disabled') === 'true') {
    log('auto: Send button is disabled');
    await clearPending('send_button_disabled');
    return;
  }

  if (dryRun) {
    const label = (sendBtn.button.getAttribute('aria-label') ||
                   sendBtn.button.innerText || '').trim();
    log(`[dry-run] would click Send button (label="${label}", row=${pending.row})`);
    // Tell the SW so it can record telemetry. The SW's RECORD_SEND_SUCCESS
    // handler short-circuits on dry_run (no mark-sent, no advance, no chain).
    try {
      await chrome.runtime.sendMessage({
        type: 'RECORD_SEND_SUCCESS',
        row: pending.row,
        cycleId: pending.cycleId,
        signal: 'dry_run',
        classification: 'positive'
      });
    } catch (_e) { /* SW may have died */ }
    await sleep(TIMINGS.postSendDwellMs);
    return;
  }

  // ---------------- Canary path ----------------
  // Don't click. Wait up to 60s for Phil to click Send manually, observe the
  // resulting toast/composer-removal, and report it. The SW handles canary
  // success specially: marks sent (the message DID go out — Phil clicked it),
  // clears canaryNeeded, but does NOT chain.
  if (canary) {
    log(`[canary] not clicking — waiting for Phil to click Send manually (row=${pending.row})`);
    if (!(await tryMarkStage('await_modal'))) return;
    if (!(await tryMarkStage('await_success'))) return;
    const result = await verifySendSuccess(
      { composerScope, sendButton: sendBtn.button },
      TIMINGS.canarySignalMs
    );
    log('[canary] result', result);
    try {
      await chrome.runtime.sendMessage({
        type: 'RECORD_SEND_SUCCESS',
        row: pending.row,
        cycleId: pending.cycleId,
        signal: result.source,
        classification: result.classification,
        text: result.text,
        canary: true
      });
    } catch (_e) { /* SW may have died */ }
    await sleep(TIMINGS.postSendDwellMs);
    return;
  }

  // ---------------- Live click ----------------
  // Click the Send button. We capture the composer scope and button refs
  // BEFORE the click so verifySendSuccess can watch the right targets even
  // after LinkedIn tears down the composer.
  const sendButtonEl = sendBtn.button;
  const label = (sendButtonEl.getAttribute('aria-label') ||
                 sendButtonEl.innerText || '').trim();
  log(`auto: clicking Send button (label="${label}", row=${pending.row})`);
  try {
    sendButtonEl.click();
  } catch (err) {
    log('auto: Send click threw', err);
    await clearPending('send_button_not_found');
    return;
  }

  // Stage: await_modal — short window for any "use 1 credit" confirmation.
  if (!(await tryMarkStage('await_modal'))) return;
  const modalResult = await handleSendConfirmModal(TIMINGS.sendModalWaitMs);
  if (modalResult.shown && !modalResult.confirmed) {
    log('auto: confirmation modal appeared but proceed button could not be matched');
    await clearPending('send_confirmation_failed');
    return;
  }
  if (modalResult.shown) log('auto: confirmation modal appeared and was confirmed');

  // Stage: await_success — observe toast / composer-removed / button-gone.
  if (!(await tryMarkStage('await_success'))) return;
  const result = await verifySendSuccess(
    { composerScope, sendButton: sendButtonEl },
    TIMINGS.successSignalMs
  );
  log('auto: send-success result', result);

  // Tell SW. It interprets classification:
  //   - positive / composer_removed → mark sent + advance + schedule next
  //   - negative → account_rate_limited, hard backoff
  //   - unknown / timeout → send_success_not_detected, hard stop
  try {
    await chrome.runtime.sendMessage({
      type: 'RECORD_SEND_SUCCESS',
      row: pending.row,
      cycleId: pending.cycleId,
      signal: result.source,
      classification: result.classification,
      text: result.text
    });
  } catch (_e) { /* SW may have died — heartbeat will pick up the stuck cycle */ }

  await sleep(TIMINGS.postSendDwellMs);
}

/**
 * Walk up from the body editor to the composer container (the one that holds
 * Send, subject, follow-up button). Multi-strategy because LinkedIn Recruiter
 * uses different containers across product tiers and A/B cohorts.
 *
 * @param {HTMLElement | null} bodyEditor
 * @returns {HTMLElement | null}
 */
function findComposerScope(bodyEditor) {
  if (!bodyEditor) return null;
  for (const sel of SELECTORS.composerScopeCandidates) {
    const found = bodyEditor.closest(sel);
    if (found) return /** @type {HTMLElement} */ (found);
  }
  // Fallback: walk up looking for any element that contains BOTH the body
  // editor and at least one primary button. Bounded ascent so we don't end up
  // returning <body>.
  let node = bodyEditor.parentElement;
  for (let i = 0; node && i < 10; i++, node = node.parentElement) {
    if (node.querySelector('button.artdeco-button--primary')) {
      return /** @type {HTMLElement} */ (node);
    }
  }
  return null;
}

/**
 * Find the Send button within a composer scope. Returns:
 *   { button, ambiguous: false } — exactly one match, ready to click
 *   { button: null, ambiguous: true } — multiple candidates: refuse, never guess
 *   { button: null, ambiguous: false } — no candidates
 *
 * Multi-criteria match: aria-label OR innerText must match LOCALE.sendButtonTexts;
 * defensive blacklist drops Save / Draft / Schedule / Cancel / etc.
 *
 * @param {HTMLElement | null} composerScope
 * @returns {{ button: HTMLButtonElement | null, ambiguous: boolean }}
 */
function findSendButton(composerScope) {
  if (!composerScope) return { button: null, ambiguous: false };

  const candidates = composerScope.querySelectorAll(
    'button[aria-label], button.artdeco-button--primary, button[type="submit"]'
  );

  /** @type {HTMLButtonElement[]} */
  const matches = [];
  /** @type {Set<HTMLButtonElement>} */
  const seen = new Set();

  for (const b of candidates) {
    const btn = /** @type {HTMLButtonElement} */ (b);
    if (seen.has(btn)) continue;
    seen.add(btn);
    if (btn.disabled) continue;
    if (btn.getAttribute('aria-disabled') === 'true') continue;

    const label = (btn.getAttribute('aria-label') || '').trim();
    const text  = (btn.innerText || btn.textContent || '').trim();

    // Defensive blacklist — drop Save-as-draft / Schedule / Cancel / etc.
    if (LOCALE.sendButtonBlacklist.test(label + ' ' + text)) continue;

    // aria-label match: exact OR prefix (aria-labels tend to be specific,
    // so we keep this strict to avoid matching unrelated long-form labels).
    const labelLow = label.toLowerCase();
    const matchesLabel = label && LOCALE.sendButtonTexts.some(t => {
      const tl = t.toLowerCase();
      return labelLow === tl || labelLow.startsWith(tl + ' ');
    });

    // Visible-text match: word-boundary substring. LinkedIn's accessibility
    // pattern wraps a screen-reader description (`.a11y-text`) and a short
    // visible label (`[aria-hidden="true"]`) inside the same button,
    // producing innerText like "Diese Nachricht senden Senden". A plain
    // startsWith never matches because the text begins with the screen-
    // reader prefix. Word-bounded `\bsenden\b` catches "Senden" at the end
    // (and "Nachricht senden" mid-string) reliably.
    const textLow = text.toLowerCase();
    const matchesText = text && LOCALE.sendButtonTexts.some(t => {
      const escaped = t.toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      return new RegExp('\\b' + escaped + '\\b', 'i').test(textLow);
    });

    if (matchesLabel || matchesText) matches.push(btn);
  }

  if (matches.length === 0) return { button: null, ambiguous: false };
  if (matches.length > 1)   return { button: null, ambiguous: true };
  return { button: matches[0], ambiguous: false };
}

/**
 * Verify the composer text matches what we tried to insert. Run right before
 * clicking Send. Length within 80% of expected + first-40-char probe must
 * match. Subject input check is best-effort (some Recruiter surfaces omit
 * subject); body + follow-up are strict when expected.
 *
 * @param {{subject?:string, inmail:string, followUp:string}} pending
 * @param {HTMLElement} bodyEditor
 * @param {HTMLElement} composerScope
 * @returns {{ok: true} | {ok: false, code: 'composer_state_invalid', detail: string}}
 */
function verifyComposerStateBeforeSend(pending, bodyEditor, composerScope) {
  // ---- Subject (best-effort) ----
  const subjectExpected = (pending.subject || '').trim();
  if (subjectExpected) {
    const subjectInput = composerScope.querySelector(SELECTORS.composerSubject) ||
                         document.querySelector(SELECTORS.composerSubject);
    if (subjectInput && /** @type {HTMLInputElement} */ (subjectInput).value !== undefined) {
      const got = String(/** @type {HTMLInputElement} */ (subjectInput).value || '').trim();
      const probe = subjectExpected.slice(0, 20).toLowerCase();
      if (probe && !got.toLowerCase().startsWith(probe)) {
        return { ok: false, code: 'composer_state_invalid', detail: 'subject_mismatch' };
      }
    }
  }

  // ---- Body (strict) ----
  const bodyExpected = (pending.inmail || '').trim();
  if (bodyExpected) {
    const got = (bodyEditor.innerText || bodyEditor.textContent || '').trim();
    const expectedLen = bodyExpected.length;
    if (got.length < Math.floor(expectedLen * 0.8)) {
      return { ok: false, code: 'composer_state_invalid', detail: 'body_short' };
    }
    const probe = (bodyExpected.split('\n')[0] || bodyExpected).slice(0, 40);
    if (probe && !got.includes(probe)) {
      return { ok: false, code: 'composer_state_invalid', detail: 'body_no_probe' };
    }
  }

  // ---- Follow-up (strict if expected) ----
  const fuExpected = (pending.followUp || '').trim();
  if (fuExpected) {
    const editors = composerScope.querySelectorAll('.ql-editor[contenteditable="true"]');
    const followUpEditor = editors.length >= 2
      ? editors[editors.length - 1]
      : null;
    if (!followUpEditor) {
      return { ok: false, code: 'composer_state_invalid', detail: 'followup_missing' };
    }
    const got = (/** @type {HTMLElement} */ (followUpEditor).innerText ||
                 followUpEditor.textContent || '').trim();
    if (got.length < Math.floor(fuExpected.length * 0.8)) {
      return { ok: false, code: 'composer_state_invalid', detail: 'followup_short' };
    }
    // Recruiter requires a follow-up subject when the section is open. If a
    // second subject input is visible and empty, refuse to send — the form
    // is incomplete and LinkedIn will reject it (or worse, send with a
    // missing field that violates our intent).
    const subjectInputs = composerScope.querySelectorAll(SELECTORS.composerSubject);
    if (subjectInputs.length >= 2) {
      const followUpSubject = /** @type {HTMLInputElement} */ (
        subjectInputs[subjectInputs.length - 1]
      );
      const subjectGot = String(followUpSubject.value || '').trim();
      if (!subjectGot) {
        return { ok: false, code: 'composer_state_invalid', detail: 'followup_subject_missing' };
      }
    }
  }

  return { ok: true };
}

/**
 * Watch for an InMail-confirm modal after click-Send. Resolves quickly when
 * no modal appears within `waitMs`.
 *
 *   { shown: false, confirmed: true }  → no modal in window, proceed
 *   { shown: true,  confirmed: true }  → modal shown + proceed clicked
 *   { shown: true,  confirmed: false } → modal shown but proceed not found
 *
 * @param {number} waitMs
 * @returns {Promise<{shown: boolean, confirmed: boolean}>}
 */
async function handleSendConfirmModal(waitMs) {
  const modal = await waitFor(SELECTORS.confirmModal, waitMs);
  if (!modal) return { shown: false, confirmed: true };

  const buttons = modal.querySelectorAll('button');
  for (const b of buttons) {
    const btn = /** @type {HTMLButtonElement} */ (b);
    if (btn.disabled) continue;
    if (btn.getAttribute('aria-disabled') === 'true') continue;
    const label = (btn.getAttribute('aria-label') || '').trim();
    const text  = (btn.innerText || btn.textContent || '').trim();

    // Skip cancel/close.
    if (LOCALE.confirmCancelMatch.test(label + ' ' + text)) continue;

    const matchesProceed = LOCALE.confirmProceedTexts.some(t =>
      label === t || label.startsWith(t) ||
      text === t || text.startsWith(t)
    );
    if (matchesProceed) {
      btn.click();
      return { shown: true, confirmed: true };
    }
  }
  return { shown: true, confirmed: false };
}

/**
 * Watch for one of several success/failure signals after Send is clicked.
 *
 *   - { source: 'toast', classification: 'positive', text }
 *   - { source: 'toast', classification: 'negative', text }   ← HARD STOP for the day
 *   - { source: 'composer_removed', classification: 'composer_removed' }
 *   - { source: 'send_button_gone', classification: 'unknown' }   ← weak signal
 *   - { source: 'timeout', classification: 'timeout' }
 *
 * Decision rule (caller's responsibility, not enforced here):
 *   - positive toast OR composer_removed → mark sent + advance
 *   - negative toast → fail with `account_rate_limited`, engage backoff
 *   - send_button_gone alone → ambiguous, surface `send_success_not_detected`
 *   - timeout → surface `send_success_not_detected`
 *
 * @param {{ composerScope: HTMLElement, sendButton: HTMLElement }} ctx
 * @param {number} timeoutMs
 * @returns {Promise<{source: string, text?: string, classification: string}>}
 */
function verifySendSuccess(ctx, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let toastObserver = null;
    let composerObserver = null;
    let buttonPoll = 0;
    let deadline = 0;

    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      try { if (toastObserver) toastObserver.disconnect(); } catch (_e) {}
      try { if (composerObserver) composerObserver.disconnect(); } catch (_e) {}
      if (buttonPoll) clearInterval(buttonPoll);
      if (deadline) clearTimeout(deadline);
      resolve(val);
    };

    // Toast observer
    toastObserver = new MutationObserver(() => {
      const toasts = document.querySelectorAll(SELECTORS.successToast);
      for (const t of toasts) {
        const text = (t.textContent || '').trim();
        if (!text) continue;
        const cls = classifyToastInline(text);
        if (cls === 'positive') return finish({ source: 'toast', text, classification: 'positive' });
        if (cls === 'negative') return finish({ source: 'toast', text, classification: 'negative' });
      }
    });
    try { toastObserver.observe(document.body, { childList: true, subtree: true, characterData: true }); }
    catch (_e) { /* document.body may not exist briefly during nav */ }

    // Composer-removed observer
    if (ctx.composerScope && ctx.composerScope.parentNode) {
      composerObserver = new MutationObserver(() => {
        if (!document.contains(ctx.composerScope)) {
          finish({ source: 'composer_removed', classification: 'composer_removed' });
        }
      });
      try { composerObserver.observe(ctx.composerScope.parentNode, { childList: true }); }
      catch (_e) {}
    }

    // Send-button-removed polling. We deliberately do NOT treat `disabled`
    // or `aria-disabled` as a signal: LinkedIn disables the Send button the
    // instant it's clicked (to prevent double-submit), well before any toast
    // or composer-removal happens. Polling for `disabled` would short-circuit
    // the race with classification 'unknown' on every successful send.
    //
    // We only fire this signal if the button is *removed from the DOM*, AND
    // we hold for 1.5s after detection to give the toast / composer-removed
    // observers a chance to resolve with a stronger positive signal first.
    buttonPoll = /** @type {any} */ (setInterval(() => {
      const sb = ctx.sendButton;
      if (sb && !document.contains(sb)) {
        clearInterval(buttonPoll); buttonPoll = 0;
        setTimeout(() => finish({ source: 'send_button_gone', classification: 'unknown' }), 1500);
      }
    }, 250));

    deadline = /** @type {any} */ (setTimeout(() => {
      finish({ source: 'timeout', classification: 'timeout' });
    }, timeoutMs));
  });
}

/**
 * In-CS toast classifier — duplicates `lib/sw_logic.js::classifySendToast`
 * because content scripts can't share modules with the SW. Keep the regexes
 * in sync with LOCALE arrays above.
 *
 * @param {string} text
 * @returns {'positive' | 'negative' | 'unknown'}
 */
function classifyToastInline(text) {
  if (typeof text !== 'string') return 'unknown';
  const t = text.trim();
  if (!t) return 'unknown';
  for (const re of LOCALE.successToastNegative) if (re.test(t)) return 'negative';
  for (const re of LOCALE.successToastPositive) if (re.test(t)) return 'positive';
  return 'unknown';
}

/**
 * Detect "this recipient has paused InMails" / "won't receive" notice text
 * within the composer. Returns true if we should skip the lead.
 *
 * @param {HTMLElement} composerScope
 */
function composerHasRecipientPaused(composerScope) {
  if (!composerScope) return false;
  const text = (composerScope.innerText || composerScope.textContent || '').trim();
  if (!text) return false;
  for (const re of LOCALE.recipientPausedTexts) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * `markStage` wrapper that returns boolean for callsites that want to abort
 * on a rejected transition. Logs but does not throw.
 *
 * @param {string} stage
 */
async function tryMarkStage(stage) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'MARK_PENDING_STAGE', stage });
    if (res && res.ok) return true;
    log('markStage rejected', stage, res && res.error);
    await clearPending(`invalid_stage_transition:${stage}`);
    return false;
  } catch (_e) {
    return false;
  }
}

async function waitForRecruiterMessageButton() {
  const deadline = Date.now() + TIMINGS.composerOpenMs;
  while (Date.now() < deadline) {
    const scope = document.querySelector(SELECTORS.recruiterActionsScope);
    if (scope) {
      const buttons = scope.querySelectorAll('button');
      for (const b of buttons) {
        const el = /** @type {HTMLElement} */ (b);
        const t = (el.innerText || '').trim();
        if (!t) continue;
        // Distinguish the InMail button from save/dropdown buttons by class.
        if (!el.classList.contains('artdeco-button--circle')) continue;
        if (!el.classList.contains('artdeco-button--muted')) continue;
        for (const prefix of LOCALE.recruiterMessageButtonPrefixes) {
          if (t.startsWith(prefix)) return el;
        }
      }
    }
    await sleep(250);
  }
  return null;
}

/** @param {number} timeoutMs */
async function waitForSecondQlEditor(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const editors = document.querySelectorAll(
      '.messaging-composer .ql-editor[contenteditable="true"], .profile__right-rail-composer .ql-editor[contenteditable="true"]'
    );
    if (editors.length >= 2) {
      // Follow-up appears AFTER body in DOM order.
      return /** @type {HTMLElement} */ (editors[editors.length - 1]);
    }
    await sleep(200);
  }
  return null;
}

// ----------------------------------------------------------------------------
// Quill insertion — multiple strategies, most reliable first.
// ----------------------------------------------------------------------------

/**
 * Insert plain text into a Quill (or other React/contenteditable) editor.
 * Snapshots pre-state to detect false-positive successes on retries.
 *
 * @param {HTMLElement} editor
 * @param {string} text
 */
function insertIntoQuill(editor, text) {
  if (!editor) return;
  editor.focus();
  const before = (editor.innerText || editor.textContent || '');
  const probe = (text.split('\n')[0] || text).slice(0, 40);

  // Strategy 1: synthetic paste. Quill's matcher cleanly handles paste events.
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    }));
    const after = (editor.innerText || editor.textContent || '');
    if (after !== before && after.includes(probe)) return;
  } catch (_e) {
    // fall through
  }

  // Strategy 2: manual DOM build — replace contents with one <p> per line.
  try {
    while (editor.firstChild) editor.removeChild(editor.firstChild);
    const lines = text.split('\n');
    for (const line of lines) {
      const p = document.createElement('p');
      if (line.length === 0) {
        p.appendChild(document.createElement('br'));
      } else {
        p.textContent = line;
      }
      editor.appendChild(p);
    }
    editor.classList.remove('ql-blank');
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    const after = (editor.innerText || editor.textContent || '');
    if (after.includes(probe)) return;
  } catch (_e) {
    // fall through
  }

  // Strategy 3: execCommand insertText — last resort.
  try {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } catch (_e) {
    // give up
  }
}

/**
 * Set a regular text input's value via the native setter (so React/Closure
 * pick up the change), then dispatch input + change events.
 * @param {HTMLInputElement} input
 * @param {string} value
 */
function setInputValue(input, value) {
  const proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** @param {string} url */
function isRecruiterProfile(url) {
  return /linkedin\.com\/talent\/profile\//.test(url);
}

/** @param {string} url */
function isRegularProfile(url) {
  return /linkedin\.com\/in\//.test(url);
}

/**
 * Two URLs refer to the same person if both end with the same /in/ slug.
 * Defense-in-depth check against URL drift while pendingFill is active.
 * @param {string} a
 * @param {string} b
 */
function urlsRefSameProfile(a, b) {
  const slugA = (a.match(/\/in\/([^/?#]+)/) || [])[1];
  const slugB = (b.match(/\/in\/([^/?#]+)/) || [])[1];
  if (!slugA || !slugB) return true; // can't tell → don't block
  return slugA === slugB;
}

function isLoggedOut() {
  return Boolean(document.querySelector(SELECTORS.sessionExpiredHint));
}

async function getPending() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_PENDING_FILL' });
    if (res && res.ok && res.pendingFill) return res.pendingFill;
  } catch (_e) {
    // ignore
  }
  return null;
}

/** @param {string} errorCode */
async function clearPending(errorCode) {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_FILL', error: errorCode || '' });
  } catch (_e) {
    // ignore
  }
}

/** @param {string} stage */
async function markStage(stage) {
  try {
    await chrome.runtime.sendMessage({ type: 'MARK_PENDING_STAGE', stage });
  } catch (_e) {
    // ignore
  }
}

/**
 * Wait for the first element matching `selector` to appear, or null on timeout.
 * @param {string} selector
 * @param {number} timeoutMs
 */
function waitFor(selector, timeoutMs) {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {unknown} err */
function safeMsg(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** @param {...unknown} args */
function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[Kengo InMail]', ...args);
}
