// @ts-check

/**
 * @typedef {Object} Lead
 * @property {number} row              Sheet row number (e.g. 47)
 * @property {string} number           Column A
 * @property {string} tier             Column B (S/A/B)
 * @property {string} score            Column C
 * @property {string} firstName        Column D
 * @property {string} lastName         Column E
 * @property {string} title            Column F
 * @property {string} company          Column G
 * @property {string} domain           Column H
 * @property {string} findingShort     Column I
 * @property {string} findingsCount    Column J
 * @property {string} connectionNote   Column K (300 chars)
 * @property {string} inmail           Column L (full InMail body)
 * @property {string} followUp         Column M (follow-up body)
 * @property {string} linkedinUrl      Column N
 * @property {string} email            Column O
 * @property {string} _separator       Column P (intentionally unused)
 * @property {string} status           Column Q (gesendet/akzeptiert/...)
 * @property {string} statusDate       Column R
 * @property {string} followUpStatus   Column S
 * @property {string} notes            Column T
 */

const COLUMN_INDEX = {
  number: 0,
  tier: 1,
  score: 2,
  firstName: 3,
  lastName: 4,
  title: 5,
  company: 6,
  domain: 7,
  findingShort: 8,
  findingsCount: 9,
  connectionNote: 10,
  inmail: 11,
  followUp: 12,
  linkedinUrl: 13,
  email: 14,
  _separator: 15,
  status: 16,
  statusDate: 17,
  followUpStatus: 18,
  notes: 19
};

/**
 * @param {unknown[]} values  Array of 20 cell values, columns A..T.
 * @param {number} row        Sheet row number (1-based).
 * @returns {Lead}
 */
export function parseRow(values, row) {
  const safe = Array.isArray(values) ? values : [];
  const get = (i) => {
    const v = safe[i];
    if (v === null || v === undefined) return '';
    return String(v);
  };
  /** @type {any} */
  const lead = { row };
  for (const [key, idx] of Object.entries(COLUMN_INDEX)) {
    lead[key] = get(idx);
  }
  return lead;
}

/** @param {Lead} lead */
export function fullName(lead) {
  return `${lead.firstName} ${lead.lastName}`.trim();
}

/** @param {Lead} lead */
export function hasLinkedinUrl(lead) {
  return typeof lead.linkedinUrl === 'string' && /^https?:\/\//.test(lead.linkedinUrl.trim());
}
