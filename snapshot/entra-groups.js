'use strict';
// Reads the Entra (cloud) groups for a snapshot. Run by Take-Snapshot.ps1, not by hand:
//
//   node entra-groups.js <request.json> <result.json>
//
// request.json: { "config": "C:\\ProgramData\\LicenceReportingApp\\app.env", "groups": [{ "id": "...", "name": "..." }] }
// result.json:  { "groups": [{ name, source: "entra", entraId, found, error, members: [...] }] }
//
// Files rather than the console, so names with accents survive Windows PowerShell 5.1. Members are in the
// same shape as the AD part of the snapshot. Signs in to Microsoft Graph with the app's own certificate.
const fs = require('node:fs');

async function readGroups(groups, graph) {
  const out = [];
  for (const g of groups) {
    const entry = { name: g.name, source: 'entra', entraId: g.id, found: false, error: null, members: [], retry: false };
    try {
      let group;
      try { group = await graph.get(`/groups/${encodeURIComponent(g.id)}?$select=id,displayName`); } catch (err) {
        if (err.status === 404) throw Object.assign(new Error('Group not found in Entra'), { notFound: true });
        throw err;
      }
      entry.found = true;
      entry.name = group.displayName || g.name;
      entry.members = await graph.groupMembers(g.id);
    } catch (err) {
      entry.error = err.message;
      entry.retry = !err.notFound;
    }
    out.push(entry);
  }
  return out;
}

async function main([requestFile, resultFile]) {
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8').replace(/^\uFEFF/, ''));
  if (request.config) process.loadEnvFile(request.config);
  const { client } = require('../lib/graph');
  const groups = await readGroups(request.groups || [], client());
  fs.writeFileSync(`${resultFile}.tmp`, JSON.stringify({ groups }));
  fs.renameSync(`${resultFile}.tmp`, resultFile);
}

module.exports = { readGroups };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    // Take-Snapshot.ps1 records this against every Entra group and tries again
    try { fs.writeFileSync(process.argv[3], JSON.stringify({ error: err.message })); } catch { /* nothing more to do */ }
    process.exit(1);
  });
}
