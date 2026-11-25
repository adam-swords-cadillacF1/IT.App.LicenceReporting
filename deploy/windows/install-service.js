'use strict';
// Registers the app as a Windows Service (runs at boot, no login needed) using node-windows.
// Run on the server by server/Install-App.ps1, not by hand.
const path = require('node:path');
const { Service } = require('node-windows');

const APP_DIR = path.resolve(__dirname, '..', '..');
// Install-App.ps1 sets these
const NAME = process.env.SERVICE_NAME || 'LicenceReportingApp';

const svc = new Service({
  name: NAME,
  description: `Licence Reporting (Node.js/Express app, port ${process.env.SERVICE_PORT || 3003})`,
  script: path.join(APP_DIR, 'server.js'),
  workingDirectory: APP_DIR,
  // Settings and secrets are read from this file by server.js, not stored in the service definition
  env: [{ name: 'APP_CONFIG', value: process.env.APP_CONFIG || 'C:\\ProgramData\\LicenceReportingApp\\app.env' }],
  // Restart with growing back-off if the app crashes
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

svc.on('install', () => { console.log('Service installed - starting it now...'); svc.start(); });
svc.on('alreadyinstalled', () => console.log('Service is already installed.'));
svc.on('start', () => console.log('Service started.'));
svc.on('error', err => { console.error('Service error:', err); process.exitCode = 1; });

svc.install();
