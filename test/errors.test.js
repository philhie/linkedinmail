import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  friendlyError, humanStage, stageStep, isValidStageTransition
} from '../lib/errors.js';

test('friendlyError handles empty input', () => {
  assert.equal(friendlyError(''), '');
  assert.equal(friendlyError(/** @type {any} */ (null)), '');
  assert.equal(friendlyError(/** @type {any} */ (undefined)), '');
});

test('friendlyError unknown codes pass through', () => {
  assert.equal(friendlyError('totally_unknown_code_xyz'), 'totally_unknown_code_xyz');
});

test('friendlyError parses rate_limited:N', () => {
  assert.equal(
    friendlyError('rate_limited:7'),
    'Rate limited — wait 7s before opening the next profile.'
  );
});

test('friendlyError parses mark_sent_write_failed:row_N', () => {
  const out = friendlyError('mark_sent_write_failed:row_42:fetch_failed');
  assert.match(out, /row 42/);
  assert.match(out, /fix manually/);
});

test('friendlyError parses pending_writes:N', () => {
  const out = friendlyError('pending_writes:3');
  assert.match(out, /3 sheet update/);
});

test('friendlyError content_message_failed prefix', () => {
  const out = friendlyError('content_message_failed:something');
  assert.match(out, /reload the LinkedIn page/i);
});

test('friendlyError parses composer_state_invalid:detail', () => {
  const out = friendlyError('composer_state_invalid:body_short');
  assert.match(out, /body_short/);
  assert.match(out, /aborted/i);
});

test('friendlyError parses cycle_stuck:stage', () => {
  const out = friendlyError('cycle_stuck:await_success');
  assert.match(out, /await_success/);
  assert.match(out, /stuck/i);
});

test('friendlyError parses hourly_cap_throttled:N', () => {
  const out = friendlyError('hourly_cap_throttled:30');
  assert.match(out, /30/);
  assert.match(out, /Hourly cap/i);
});

test('friendlyError parses invalid_stage_transition prefix', () => {
  const out = friendlyError('invalid_stage_transition:await_modal_to_await_recruiter');
  assert.match(out, /Internal state drift/i);
});

test('friendlyError covers all known specific codes', () => {
  // Spot-check both legacy and auto-mode codes.
  const codes = [
    'not_configured',
    'missing_apps_script_url',
    'missing_apps_script_token',
    'forbidden',
    'sheet_not_found:Outreach',
    'daily_target_reached',
    'no_lead',
    'no_linkedin_url',
    'session_expired',
    'recruiter_link_not_found',
    'recruiter_link_no_href',
    'recruiter_link_ambiguous',
    'recruiter_message_button_not_found',
    'composer_body_editor_not_found',
    'add_follow_up_button_not_found',
    'follow_up_editor_not_found',
    'wrong_tab',
    'wrong_url',
    'wrong_profile_stage2',
    'no_response_from_service_worker',
    'offline',
    'fill_drift_detected',
    // Auto-mode
    'send_button_not_found',
    'send_button_ambiguous',
    'send_button_disabled',
    'send_confirmation_failed',
    'send_success_not_detected',
    'account_rate_limited',
    'recipient_unreachable',
    'template_unrendered',
    'auto_paused_by_user',
    'auto_backoff',
    'tab_navigation_failed',
    'tab_lost',
    'auth_challenge',
    'auto_mode_first_run_unconfirmed',
    'canary_pending',
    'canary_signal_missing',
    'no_pending',
    'fill_in_progress',
    'pending_writes_backlog'
  ];
  for (const c of codes) {
    const out = friendlyError(c);
    assert.notEqual(out, c, `code ${c} should map to a friendly string, not pass through`);
    assert.ok(out.length > 0, `code ${c} should produce non-empty output`);
  }
});

test('humanStage covers all stages', () => {
  assert.match(humanStage('await_recruiter'), /opening profile/);
  assert.match(humanStage('await_composer'), /opening composer/);
  assert.match(humanStage('await_review'), /reviewing/);
  assert.match(humanStage('await_send_click'), /clicking send/);
  assert.match(humanStage('await_modal'), /confirming send/);
  assert.match(humanStage('await_success'), /verifying send/);
  assert.match(humanStage('await_advance'), /advancing/);
  assert.match(humanStage('cooldown'), /cooling down/);
  assert.equal(humanStage('done'), 'done');
  assert.equal(humanStage('error'), 'error');
  assert.equal(humanStage(''), '');
  assert.equal(humanStage('weird_unknown_stage'), 'weird_unknown_stage');
});

test('stageStep maps each pipeline stage to a numbered step', () => {
  assert.equal(stageStep('await_recruiter'), 1);
  assert.equal(stageStep('await_composer'), 2);
  assert.equal(stageStep('await_review'), 3);
  assert.equal(stageStep('await_send_click'), 4);
  assert.equal(stageStep('await_modal'), 5);
  assert.equal(stageStep('await_success'), 6);
  assert.equal(stageStep('await_advance'), 7);
  assert.equal(stageStep('cooldown'), 8);
  assert.equal(stageStep('done'), 9);
  assert.equal(stageStep('error'), 0);
  assert.equal(stageStep('garbage'), 0);
});

test('isValidStageTransition: forward pipeline allowed', () => {
  assert.equal(isValidStageTransition('await_recruiter', 'await_composer'), true);
  assert.equal(isValidStageTransition('await_composer', 'await_review'), true);
  assert.equal(isValidStageTransition('await_review', 'await_send_click'), true);
  assert.equal(isValidStageTransition('await_send_click', 'await_modal'), true);
  assert.equal(isValidStageTransition('await_modal', 'await_success'), true);
  assert.equal(isValidStageTransition('await_success', 'await_advance'), true);
  assert.equal(isValidStageTransition('await_advance', 'cooldown'), true);
  assert.equal(isValidStageTransition('cooldown', 'await_recruiter'), true);
});

test('isValidStageTransition: any → done is allowed (legacy escape)', () => {
  assert.equal(isValidStageTransition('await_recruiter', 'done'), true);
  assert.equal(isValidStageTransition('await_composer', 'done'), true);
  assert.equal(isValidStageTransition('await_review', 'done'), true);
  assert.equal(isValidStageTransition('await_send_click', 'done'), true);
  assert.equal(isValidStageTransition('await_modal', 'done'), true);
  assert.equal(isValidStageTransition('await_success', 'done'), true);
  assert.equal(isValidStageTransition('await_advance', 'done'), true);
  assert.equal(isValidStageTransition('cooldown', 'done'), true);
});

test('isValidStageTransition: any → error is allowed', () => {
  assert.equal(isValidStageTransition('await_recruiter', 'error'), true);
  assert.equal(isValidStageTransition('await_modal', 'error'), true);
  assert.equal(isValidStageTransition('cooldown', 'error'), true);
});

test('isValidStageTransition: backward / skip moves blocked', () => {
  assert.equal(isValidStageTransition('await_composer', 'await_recruiter'), false);
  assert.equal(isValidStageTransition('await_review', 'await_composer'), false);
  assert.equal(isValidStageTransition('await_send_click', 'await_review'), false);
  // Skipping stages (e.g. straight to await_advance) is not allowed.
  assert.equal(isValidStageTransition('await_recruiter', 'await_send_click'), false);
  assert.equal(isValidStageTransition('await_composer', 'await_advance'), false);
  // From terminal: cannot transition back into pipeline.
  assert.equal(isValidStageTransition('done', 'await_recruiter'), false);
  assert.equal(isValidStageTransition('done', 'await_composer'), false);
  assert.equal(isValidStageTransition('error', 'await_recruiter'), false);
});

test('isValidStageTransition: invalid input returns false', () => {
  assert.equal(isValidStageTransition(/** @type {any} */ (null), 'await_composer'), false);
  assert.equal(isValidStageTransition('await_recruiter', /** @type {any} */ (null)), false);
  assert.equal(isValidStageTransition('garbage', 'await_composer'), false);
});
