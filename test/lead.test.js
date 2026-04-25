import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, fullName, hasLinkedinUrl } from '../lib/lead.js';

test('parseRow maps all 20 columns by index', () => {
  const values = [
    '47',                            // A: number
    'S',                             // B: tier
    '95',                            // C: score
    'Hans',                          // D: firstName
    'Müller',                        // E: lastName
    'CTO',                           // F: title
    'Acme GmbH',                     // G: company
    'acme.de',                       // H: domain
    'Found exposed admin panel',     // I: findingShort
    '3',                             // J: findingsCount
    'Hi Hans, ...',                  // K: connectionNote
    'Long InMail body',              // L: inmail
    'Follow-up body',                // M: followUp
    'https://linkedin.com/in/hans',  // N: linkedinUrl
    'hans@acme.de',                  // O: email
    '',                              // P: separator
    '',                              // Q: status
    '',                              // R: statusDate
    '',                              // S: followUpStatus
    'irrelevant note'                // T: notes
  ];
  const lead = parseRow(values, 47);
  assert.equal(lead.row, 47);
  assert.equal(lead.number, '47');
  assert.equal(lead.tier, 'S');
  assert.equal(lead.score, '95');
  assert.equal(lead.firstName, 'Hans');
  assert.equal(lead.lastName, 'Müller');
  assert.equal(lead.title, 'CTO');
  assert.equal(lead.company, 'Acme GmbH');
  assert.equal(lead.domain, 'acme.de');
  assert.equal(lead.findingShort, 'Found exposed admin panel');
  assert.equal(lead.findingsCount, '3');
  assert.equal(lead.connectionNote, 'Hi Hans, ...');
  assert.equal(lead.inmail, 'Long InMail body');
  assert.equal(lead.followUp, 'Follow-up body');
  assert.equal(lead.linkedinUrl, 'https://linkedin.com/in/hans');
  assert.equal(lead.email, 'hans@acme.de');
  assert.equal(lead.status, '');
  assert.equal(lead.statusDate, '');
  assert.equal(lead.notes, 'irrelevant note');
});

test('parseRow handles short / missing arrays', () => {
  const lead = parseRow([], 99);
  assert.equal(lead.row, 99);
  assert.equal(lead.firstName, '');
  assert.equal(lead.notes, '');
});

test('parseRow coerces non-strings to strings', () => {
  const values = ['1', 'A', 80, 'Phil', 'Hie'];
  const lead = parseRow(values, 1);
  assert.equal(lead.score, '80');
  assert.equal(typeof lead.score, 'string');
});

test('parseRow tolerates non-array input', () => {
  const lead = parseRow(/** @type {any} */ (null), 5);
  assert.equal(lead.row, 5);
  assert.equal(lead.firstName, '');
});

test('fullName trims whitespace', () => {
  assert.equal(fullName({ firstName: 'Hans', lastName: 'Müller' }), 'Hans Müller');
  assert.equal(fullName({ firstName: '', lastName: 'Müller' }), 'Müller');
  assert.equal(fullName({ firstName: '', lastName: '' }), '');
});

test('hasLinkedinUrl recognizes valid URLs only', () => {
  assert.equal(hasLinkedinUrl({ linkedinUrl: 'https://linkedin.com/in/x' }), true);
  assert.equal(hasLinkedinUrl({ linkedinUrl: 'http://linkedin.com/in/x' }), true);
  assert.equal(hasLinkedinUrl({ linkedinUrl: '' }), false);
  assert.equal(hasLinkedinUrl({ linkedinUrl: 'not a url' }), false);
  assert.equal(hasLinkedinUrl({ linkedinUrl: undefined }), false);
});
