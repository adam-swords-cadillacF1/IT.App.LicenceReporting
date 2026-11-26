'use strict';
// The Cato account ID and API key as entered in Admin › Settings. They live in the database's settings table: the
// account ID as it is, the API key encrypted (lib/secrets.js). The key is never sent back to the browser, logged or
// written to the activity log. lib/cato.js uses these, or app.env's CATO_* settings when nothing is saved here.
const { db, getSetting, setSetting, nowIso } = require('./db');
const secrets = require('./secrets');

const PURPOSE = 'cato-api-key';
const KEYS = ['cato_account_id', 'cato_api_key', 'cato_updated_by', 'cato_updated_at'];
const ACCOUNT_RE = /^[A-Za-z0-9-]{1,40}$/;
// API keys are long random strings: printable ASCII, no spaces
const API_KEY_RE = /^[\x21-\x7e]{16,512}$/;
const KEY_UNREADABLE = "The saved Cato API key can't be decrypted (the app's SESSION_SECRET has probably changed). Enter it again in Admin › Settings.";

const bad = message => Object.assign(new Error(message), { status: 400 });

// { saved, accountId, apiKey, keySaved, keyError, updatedBy, updatedAt }. apiKey is the decrypted key: only for
// lib/cato.js, never for a response.
function stored() {
  const accountId = getSetting('cato_account_id') || '';
  const blob = getSetting('cato_api_key');
  let apiKey = '';
  let keyError = null;
  if (blob) {
    try { apiKey = secrets.decrypt(blob, PURPOSE); } catch { keyError = KEY_UNREADABLE; }
  }
  return { saved: Boolean(accountId || blob), accountId, apiKey, keySaved: Boolean(blob), keyError,
    updatedBy: getSetting('cato_updated_by'), updatedAt: getSetting('cato_updated_at') };
}

// input: { accountId, apiKey }. A blank or missing apiKey keeps the saved one. Returns what changed, for the
// activity log (never the key itself).
function save(input, who) {
  const accountId = String(input?.accountId ?? '').trim();
  const apiKey = String(input?.apiKey ?? '').trim();
  if (!ACCOUNT_RE.test(accountId)) throw bad('Enter the Cato account ID (letters, digits and dashes, as shown in the Cato Management Application)');
  // Says what's wrong with the key without repeating any of it
  if (apiKey && !API_KEY_RE.test(apiKey)) throw bad('That doesn\'t look like a Cato API key: it should be one long string with no spaces (16 to 512 characters). Paste it again.');
  const before = stored();
  if (!apiKey && !before.keySaved) throw bad('Enter the Cato API key');
  const changes = [];
  if (accountId !== before.accountId) changes.push(`account ID ${before.accountId ? `${before.accountId} → ` : ''}${accountId}`);
  if (apiKey) changes.push(before.keySaved ? 'API key replaced' : 'API key added');
  if (!changes.length) return changes;
  setSetting('cato_account_id', accountId);
  if (apiKey) setSetting('cato_api_key', secrets.encrypt(apiKey, PURPOSE));
  setSetting('cato_updated_by', who);
  setSetting('cato_updated_at', nowIso());
  return changes;
}

// Removes the account ID and key from the app (app.env's settings apply again, if it has any)
function clear() {
  const had = stored().saved;
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  for (const key of KEYS) del.run(key);
  return had;
}

module.exports = { stored, save, clear, KEY_UNREADABLE };
