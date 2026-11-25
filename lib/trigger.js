'use strict';
// "Take snapshot now". On the server this starts the same scheduled task that runs at 00:10, so the
// snapshot is taken exactly as it would be overnight. Elsewhere (a developer's machine, no AD) it writes
// a made-up snapshot for today instead, so the button can be tried.
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
  writeSnapshot(snaps.INCOMING, snap);
  snaps.processIncoming();
  return { mode: 'sample' };
}

module.exports = { takeSnapshotNow, TASK_NAME };
