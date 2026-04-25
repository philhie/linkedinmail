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

  sessionExpiredHint: 'a[href*="/login"], a[href*="/uas/login"], a[href*="checkpoint/lg/login"]'
};

const LOCALE = {
  // Recruiter Message button text patterns (prefix match — the full text
  // includes the lead's name, e.g. "Nachricht an Marco Willenbrock").
  recruiterMessageButtonPrefixes: ['Nachricht an ', 'Message ', 'InMail ']
};

const TIMINGS = {
  recruiterLinkAppearMs: 12_000,
  composerOpenMs:        10_000,
  editorAppearMs:         8_000,
  followUpAppearMs:       5_000,
  betweenInsertMs:          250
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

/** @param {{linkedinUrl?:string, stage:string}} pending */
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
  await markStage('await_composer');
  // Same-tab nav so we keep the same tabId for stage 2.
  location.href = href;
}

// ----------------------------------------------------------------------------
// Stage 2 — on /talent/profile/ pages: open composer, fill subject + body + follow-up
// ----------------------------------------------------------------------------

/** @param {{subject?:string, inmail:string, followUp:string, row:number, stage:string}} pending */
async function runRecruiterFill(pending) {
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
    insertIntoQuill(followUpEditor, pending.followUp);
  }

  // 6. Done. Phil now reviews subject + body and clicks Send manually.
  await clearPending('');
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
