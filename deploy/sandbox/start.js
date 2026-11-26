'use strict';
// Starts the app in the local sandbox container (deploy/sandbox/run.sh).
//
// Development sign-in has no password, so server.js only listens on 127.0.0.1. Inside a container that address
// can't be published, so this forwards port 3080 to it; run.sh publishes 3080 on the Mac's own 127.0.0.1 only, so
// the sandbox is still reachable from this Mac alone.
//
// On a fresh data volume it first writes 90 days of made-up snapshots ending yesterday, so the dashboard has history
// and "Take snapshot now" works for today. With SANDBOX_DEMO_CATO=1 (run.sh --demo-cato) that history includes a
// made-up Cato group, to preview the Cato page's month-to-month figures.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const APP_PORT = Number(process.env.PORT) || 3003;
const PUBLIC_PORT = Number(process.env.SANDBOX_PORT) || 3080;

if (!fs.existsSync(path.join(DATA_DIR, 'licences.db'))) {
  const { generate, writeSnapshot } = require('../../scripts/sample-data');
  const { monitoredGroups, INCOMING, addDays, localYmd, setCatoMonitored } = require('../../lib/snapshots');
  if (process.env.SANDBOX_DEMO_CATO === '1') setCatoMonitored(true);
  const days = generate({ groups: monitoredGroups(), endDate: addDays(localYmd(), -1), days: 90 });
  for (const s of days) writeSnapshot(INCOMING, s);
  console.log(`[sandbox] Wrote ${days.length} made-up snapshots (fictional people) to start with.`);
}

net.createServer(client => {
  const app = net.connect(APP_PORT, '127.0.0.1');
  client.pipe(app).pipe(client);
  const close = () => { client.destroy(); app.destroy(); };
  client.on('error', close);
  app.on('error', close);
}).listen(PUBLIC_PORT, '0.0.0.0', () => console.log(`[sandbox] Forwarding port ${PUBLIC_PORT} to the app on 127.0.0.1:${APP_PORT}`));

require('../../server.js');
