'use strict';
const fs = require('node:fs');
const { ConfidentialClientApplication } = require('@azure/msal-node');

// One Entra app registration serves both sign-in (delegated) and Graph email/calendar (application).
// A certificate is preferred; a client secret is used only when no certificate is configured.
const TENANT_ID = process.env.ENTRA_TENANT_ID;
const CLIENT_ID = process.env.ENTRA_CLIENT_ID;

function credential() {
  if (process.env.ENTRA_CERT_KEY_PATH && process.env.ENTRA_CERT_THUMBPRINT) {
    return { clientCertificate: {
      thumbprintSha256: process.env.ENTRA_CERT_THUMBPRINT,
      privateKey: fs.readFileSync(process.env.ENTRA_CERT_KEY_PATH, 'utf8'),
    } };
  }
  if (process.env.ENTRA_CLIENT_SECRET) return { clientSecret: process.env.ENTRA_CLIENT_SECRET };
  return null;
}

const cred = credential();
const configured = Boolean(TENANT_ID && CLIENT_ID && cred);
const authority = `https://login.microsoftonline.com/${TENANT_ID}`;

const msal = configured ? new ConfidentialClientApplication({ auth: { clientId: CLIENT_ID, authority, ...cred } }) : null;

module.exports = { configured, msal, TENANT_ID, CLIENT_ID, authority };
