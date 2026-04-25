import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  friendlyError, humanStage, isValidStageTransition
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

test('friendlyError covers all known specific codes', () => {
  // Spot-check a handful of known codes to ensure they don't regress.
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
    'recruiter_message_button_not_found',
    'composer_body_editor_not_found',
    'add_follow_up_button_not_found',
    'follow_up_editor_not_found',
    'wrong_tab',
    'wrong_url',
    'no_response_from_service_worker',
    'offline'
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
  assert.equal(humanStage('done'), 'done');
  assert.equal(humanStage(''), '');
  assert.equal(humanStage('weird_unknown_stage'), 'weird_unknown_stage');
});

test('isValidStageTransition allows correct moves', () => {
  assert.equal(isValidStageTransition('await_recruiter', 'await_composer'), true);
  assert.equal(isValidStageTransition('await_recruiter', 'done'), true);
  assert.equal(isValidStageTransition('await_composer', 'done'), true);
});

test('isValidStageTransition blocks invalid moves', () => {
  assert.equal(isValidStageTransition('await_composer', 'await_recruiter'), false);
  assert.equal(isValidStageTransition('done', 'await_recruiter'), false);
  assert.equal(isValidStageTransition('done', 'await_composer'), false);
  assert.equal(isValidStageTransition('garbage', 'await_composer'), false);
});
