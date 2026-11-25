'use strict';
const express = require('express');
const { CryptoProvider } = require('@azure/msal-node');
const entra = require('./entra');
const { logActivity } = require('./db');

// Entra ID sign-in: authorization code flow with PKCE. Access comes only from the app roles in the ID
// token, assigned to people or groups on the enterprise app in Entra:
//   Admin  - IT: everything, plus the group list, snapshot history and "Take snapshot now"
//   Viewer - e.g. Finance: dashboard and reports, read-only
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const REDIRECT_URI = `${APP_URL}/auth/callback`;
const SCOPES = ['openid', 'profile', 'email'];

const crypto = new CryptoProvider();
const router = express.Router();

function roleFrom(claims) {
  const roles = claims.roles || [];
  if (roles.includes('Admin')) return 'admin';
  if (roles.includes('Viewer')) return 'viewer';
  return null;
}

const page = (res, status, message) => res.status(status).type('html').send(`<!doctype html><html lang="en-GB" data-theme="dark">
<head><meta charset="utf-8"><title>Sign in - Licence Reporting</title><link rel="stylesheet" href="/style.css"></head>
<body><div class="login-wrap"><div class="card login-card"><h2>Sign-in problem</h2><p>${message}</p>
<div class="actions" style="margin-top:14px"><a class="btn primary" href="/auth/signin">Try again</a></div></div></div></body></html>`);

function warnIfNotHttps(req) {
  if (req.session.cookie.secure && !req.secure) {
    console.warn(`[auth] Request from ${req.socket.remoteAddress} is not seen as HTTPS (X-Forwarded-Proto: ` +
      `${req.get('x-forwarded-proto') || 'missing'}, TRUST_PROXY: ${process.env.TRUST_PROXY || 'unset'}), ` +
      'so the session cookie is not sent and sign-in cannot complete');
  }
}

router.get('/auth/signin', async (req, res, next) => {
  warnIfNotHttps(req);
  try {
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const state = crypto.createNewGuid();
    req.session.pendingAuth = { state, verifier };
    const url = await entra.msal.getAuthCodeUrl({
      scopes: SCOPES, redirectUri: REDIRECT_URI, state, codeChallenge: challenge, codeChallengeMethod: 'S256',
      prompt: 'select_account',
    });
    req.session.save(err => (err ? next(err) : res.redirect(url)));
  } catch (err) { next(err); }
});

router.get('/auth/callback', async (req, res, next) => {
  const pending = req.session.pendingAuth;
  delete req.session.pendingAuth;
  if (req.query.error) {
    console.warn(`[auth] Entra returned ${req.query.error}: ${req.query.error_description}`);
    return page(res, 401, 'Microsoft sign-in did not complete.');
  }
  if (!pending || !req.query.state || req.query.state !== pending.state) {
    warnIfNotHttps(req);
    return page(res, 400, 'Your sign-in session expired. Please try again.');
  }
  try {
    const result = await entra.msal.acquireTokenByCode({
      code: String(req.query.code || ''), scopes: SCOPES, redirectUri: REDIRECT_URI, codeVerifier: pending.verifier,
    });
    const claims = result.idTokenClaims;
    if (claims.tid !== entra.TENANT_ID || !claims.oid) return page(res, 403, 'That account is not from this organisation.');
    const role = roleFrom(claims);
    const email = String(claims.preferred_username || claims.email || '').toLowerCase();
    if (!role) {
      console.warn(`[auth] ${email} signed in without an app role`);
      return page(res, 403, 'You have not been given access to Licence Reporting. Ask IT to add you.');
    }
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = { oid: claims.oid, name: claims.name || email, email, role };
      logActivity(email, 'Signed in', role === 'admin' ? 'Admin' : 'Viewer');
      console.log(`[auth] ${email} (oid ${claims.oid}) signed in as ${role}`);
      res.redirect('/');
    });
  } catch (err) {
    console.error(`[auth] Token exchange failed: ${err.message}`);
    page(res, 401, 'Microsoft sign-in failed. Please try again.');
  }
});

const logoutUrl = () => `${entra.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(`${APP_URL}/login`)}`;

module.exports = { router, logoutUrl, roleFrom };
