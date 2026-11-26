'use strict';
// "Take snapshot now". On the server this starts the same scheduled task that runs at 00:10, so the
// snapshot is taken exactly as it would be overnight. Elsewhere (a developer's machine, no AD) it writes
// a made-up snapshot for today instead, so the button can be tried. If Cato is set up (app.env) and switched on, the
// Cato group in that snapshot is read from the real Cato API, so Cato can be tried end to end before deploying.
const { execFile } = require('node:child_process');
const snaps = require('./snapshots');

const TASK_NAME = process.env.SNAPSHOT_TASK || 'LicenceReporting snapshot';

function runTask() {
  return new Promise((resolve, reject) => {
    execFile('schtasks.exe', ['/Run', '/TN', TASK_NAME], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Could not start the "${TASK_NAME}" scheduled task: ${(stderr || err.message).trim()}`));
      resolve();
    });
  });
}

async function takeSnapshotNow(who) {
  if (process.platform === 'win32') {
    snaps.writeRequest(who);
    await runTask();
    return { mode: 'task', task: TASK_NAME };
  }
  const { generate, writeSnapshot } = require('../scripts/sample-data');
  const today = snaps.localYmd();
  const [snap] = generate({ groups: snaps.monitoredGroups(), endDate: today, days: 1 });
  snap.takenAt = new Date().toISOString();
  snap.requestedBy = who;
  const cato = await liveCato(snap);
  writeSnapshot(snaps.INCOMING, snap);
  snaps.processIncoming();
  return { mode: 'sample', cato };
}

// Swaps the made-up Cato group for a real read of Cato, as snapshot/cato-users.js does on the server.
// Returns 'live', 'sample' (Cato on but not configured here) or null (Cato off).
async function liveCato(snap) {
  const i = snap.groups.findIndex(g => g.source === 'cato');
  if (i < 0) return null;
  const cato = require('./cato');
  if (!cato.isConfigured()) return 'sample';
  const entra = require('./entra');
  const { readCato } = require('../snapshot/cato-users');
  snap.groups[i] = await readCato({ cato: cato.client(), graph: entra.configured ? require('./graph').client() : null, name: snap.groups[i].name });
  return 'live';
}

module.exports = { takeSnapshotNow, TASK_NAME };
