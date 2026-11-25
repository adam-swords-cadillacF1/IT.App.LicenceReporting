'use strict';
// On a server, settings and secrets live in an env file outside the app folder (see deploy/windows).
// Variables already set in the environment take precedence over the file.
if (process.env.APP_CONFIG) process.loadEnvFile(process.env.APP_CONFIG);

// Snapshot dates, "late" and month ends are worked out in UK local time unless overridden
process.env.TZ = process.env.APP_TZ || 'Europe/London';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const { db, DATA_DIR, logActivity } = require('./lib/db');
const SqliteSessionStore = require('./lib/session-store');
const snaps = require('./lib/snapshots');
const { router: apiRouter } = require('./routes/api');

const PORT = Number(process.env.PORT) || 3003;
const AUTH_MODE = process.env.AUTH_MODE || 'dev';
const PUBLIC_DIR = path.join(__dirname, 'public');
const TLS = Boolean(process.env.TLS_PFX_PATH || (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH));
// Dev sign-in has no password, so it only listens on this machine unless HOST says otherwise
const HOST = process.env.HOST || (AUTH_MODE === 'dev' ? '127.0.0.1' : '0.0.0.0');
const APP_URL = process.env.APP_URL || `http${TLS ? 's' : ''}://localhost:${PORT}`;
const BEHIND_PROXY = Boolean(process.env.TRUST_PROXY);
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : /^https:\/\//.test(APP_URL);
const IMPORT_EVERY_MS = 30 * 1000;

function refuse(message) {
  console.error(`[startup] ${message}`);
  process.exit(1);
}

if (!['dev', 'entra'].includes(AUTH_MODE)) refuse(`AUTH_MODE must be "dev" or "entra", not "${AUTH_MODE}".`);
if (AUTH_MODE === 'dev' && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  refuse('Development sign-in has no password, so it only listens on 127.0.0.1. Use AUTH_MODE=entra on a server.');
}
if (AUTH_MODE === 'entra') {
  const entra = require('./lib/entra');
  if (!entra.configured) refuse('AUTH_MODE=entra needs ENTRA_TENANT_ID, ENTRA_CLIENT_ID and a certificate or client secret.');
  if (!process.env.APP_URL) refuse('AUTH_MODE=entra needs APP_URL, the address users browse to (used for the sign-in redirect).');
  if (!/^https:\/\//.test(APP_URL) && !/^http:\/\/localhost[:/]/.test(APP_URL)) {
    refuse('Entra only redirects to https addresses (or http://localhost). Set APP_URL to https and configure TLS.');
  }
  if (/^https:\/\//.test(APP_URL) && !TLS && !BEHIND_PROXY) {
    refuse('APP_URL is https but nothing provides it: set TLS_PFX_PATH (or TLS_CERT_PATH/TLS_KEY_PATH), or TRUST_PROXY when a reverse proxy handles HTTPS.');
  }
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

const app = express();
app.locals.authMode = AUTH_MODE;
app.locals.appEnv = process.env.APP_ENV || null;
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
  strictTransportSecurity: COOKIE_SECURE,
}));
// Static files come before the session middleware, so they never carry a session cookie (the reverse
// proxy may cache them)
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use(express.json({ limit: '100kb' }));
app.use(session({
  name: 'lr.sid',
  secret: sessionSecret(),
  store: new SqliteSessionStore(db),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 8 * 60 * 60 * 1000 },
}));

// Anything that depends on who is signed in must never be cached by the browser or the proxy
app.use(['/api', '/auth', '/login'], (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// CSRF protection: state-changing requests must be JSON, which browsers won't send cross-site without CORS
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.is('application/json')) return next();
  res.status(415).json({ error: 'Requests must be sent as JSON' });
});

app.use((req, res, next) => { req.user = req.session.user || null; next(); });

// ── Sign-in ──────────────────────────────────────────────────────────────────

if (AUTH_MODE === 'entra') {
  const entraAuth = require('./lib/auth-entra');
  app.use(entraAuth.router);
  app.get('/login', (req, res) => (req.user ? res.redirect('/') : res.sendFile(path.join(PUBLIC_DIR, 'signin.html'))));
  app.post('/auth/logout', (req, res, next) => {
    req.session.destroy(err => (err ? next(err) : res.clearCookie('lr.sid').json({ ok: true, logoutUrl: entraAuth.logoutUrl() })));
  });
} else {
  // Development sign-in: choose a role, no password (only ever listens on this machine)
  const DEV_USERS = {
    admin: { oid: 'dev-admin', name: 'Dev Admin (IT)', email: 'dev.admin@localhost', role: 'admin' },
    viewer: { oid: 'dev-viewer', name: 'Dev Viewer (Finance)', email: 'dev.viewer@localhost', role: 'viewer' },
  };
  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.post('/auth/dev-login', (req, res, next) => {
    const user = DEV_USERS[req.body?.role];
    if (!user) return res.status(400).json({ error: 'Choose a role' });
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = user;
      logActivity(user.email, 'Signed in', 'development sign-in');
      res.json({ ok: true });
    });
  });
  app.post('/auth/logout', (req, res, next) => {
    req.session.destroy(err => (err ? next(err) : res.clearCookie('lr.sid').json({ ok: true })));
  });
}

// ── App ──────────────────────────────────────────────────────────────────────

app.use('/api', (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not signed in' })), apiRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.get('/', (req, res) => (req.user ? res.sendFile(path.join(PUBLIC_DIR, 'index.html')) : res.redirect('/login')));

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong - check the server log' : err.message,
    ...(err.confirmDelete ? { confirmDelete: err.confirmDelete } : {}) });
});

// ── Snapshot import ──────────────────────────────────────────────────────────

snaps.writeGroupsFile();
function importNow() {
  try { snaps.processIncoming(); } catch (err) { console.error(`[snapshot] Import failed: ${err.stack || err.message}`); }
}
importNow();
setInterval(importNow, IMPORT_EVERY_MS).unref();

function tlsOptions() {
  if (process.env.TLS_PFX_PATH) {
    return { pfx: fs.readFileSync(process.env.TLS_PFX_PATH), passphrase: process.env.TLS_PFX_PASSPHRASE };
  }
  return { cert: fs.readFileSync(process.env.TLS_CERT_PATH), key: fs.readFileSync(process.env.TLS_KEY_PATH) };
}

const server = TLS ? https.createServer(tlsOptions(), app) : app;
server.listen(PORT, HOST, () => {
  console.log(`Licence Reporting listening on ${HOST}:${PORT} (${TLS ? 'https' : 'http'}, auth: ${AUTH_MODE}, data: ${DATA_DIR})`);
  console.log(`Browse to ${APP_URL}`);
});
