'use strict';
// The app's own secret, and encryption for secrets kept in the database (such as the Cato API key).
//
// The secret is SESSION_SECRET from app.env (Install-App.ps1 generates it), or, where that isn't set (development), a
// random value kept in DATA_DIR/session-secret. Each kind of stored secret gets its own key, derived from it with
// HKDF, and is encrypted with AES-256-GCM. On the server app.env sits outside the data folder, so the database or a
// backup of the data folder alone can't be decrypted. Changing SESSION_SECRET means entering stored secrets again.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./db');

function masterSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (err) {
      if (err.code !== 'EEXIST') throw err;   // another process made it first
    }
  }
  return fs.readFileSync(file, 'utf8').trim();
}

const keyFor = purpose => Buffer.from(crypto.hkdfSync('sha256', masterSecret(), 'licence-reporting', `stored-secret:${purpose}`, 32));

// Returns "v1:<base64 of iv, tag and ciphertext>". `purpose` also authenticates the value, so a value saved for one
// purpose can't be read as another.
function encrypt(text, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

// Throws if the value was changed, saved for another purpose, or encrypted under a different SESSION_SECRET
function decrypt(value, purpose) {
  const m = /^v1:([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!m) throw new Error('Not an encrypted value');
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length < 29) throw new Error('Not an encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

module.exports = { masterSecret, encrypt, decrypt };
