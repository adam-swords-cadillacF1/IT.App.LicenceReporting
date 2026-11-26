'use strict';
// Reads the Cato ZTNA (remote access) licence holders for a snapshot. Run by Take-Snapshot.ps1, not by hand:
//
//   node cato-users.js <request.json> <result.json>
//
// request.json: { "config": "C:\\ProgramData\\LicenceReportingApp\\app.env", "name": "Cato ZTNA users" }
// result.json:  { "group": { name, source: "cato", found, error, warning, retry, licences: { total, used } | null, members: [...] } }
//
// Files rather than the console, as entra-groups.js does. Members are in the same shape as the AD part of the snapshot.
//
// The same person is counted once across AD, Entra and Cato: a Cato user's Entra object ID (objectId, for users Cato
// imported from Entra) is looked up in Entra through Microsoft Graph, and a user synced from AD is recorded under their
// AD objectGUID, exactly as Entra groups do. Without Graph (development) the Entra object ID is used, and failing that
// the Cato user ID. If Graph is configured but can't be read, the read fails and is retried, rather than recording
// people under different IDs for a day (which would show everyone as leaving and rejoining).
const fs = require('node:fs');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Entra object ID -> AD objectGUID, for every synced user in the tenant (one paged Graph call)
async function adGuidsByEntraId(graph) {
  const { adGuidFromImmutableId } = require('../lib/graph');
  const map = new Map();
  for (const u of await graph.getAll('/users?$select=id,onPremisesImmutableId&$top=999')) {
    const guid = adGuidFromImmutableId(u.onPremisesImmutableId);
    if (u.id && guid) map.set(String(u.id).toLowerCase(), guid);
  }
  return map;
}

function member(u, adGuids) {
  const entraId = GUID_RE.test(String(u.objectId || '')) ? String(u.objectId).toLowerCase() : null;
  const name = String(u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.userPrincipalName || '').trim();
  return {
    id: (entraId && adGuids?.get(entraId)) || entraId || `cato:${u.id}`,
    kind: 'user',
    username: u.userPrincipalName || u.email || '',
    name,
    email: u.email || '',
    title: u.jobTitle || '',
    department: u.department || '',
    enabled: u.userStatus === 'ACTIVE',
  };
}

// cato: lib/cato.js client; graph: lib/graph.js client, or null when Entra isn't configured
async function readCato({ cato, graph = null, name = 'Cato ZTNA users' }) {
  const entry = { name, source: 'cato', found: false, error: null, warning: null, retry: false, licences: null, members: [] };
  try {
    const users = await cato.licensedUsers();
    const adGuids = graph && users.some(u => u.objectId) ? await adGuidsByEntraId(graph) : null;
    entry.members = users.filter(u => u && u.id).map(u => member(u, adGuids));
    entry.found = true;
    try {
      const totals = await cato.ztnaLicences();
      if (totals) entry.licences = { total: totals.total, used: totals.used };
      else entry.warning = 'Cato reported no ZTNA licences';
    } catch (err) {
      // The users are what matters for the report; the totals are extra (and Cato marks that query as beta)
      entry.warning = `Licence totals not read: ${err.message}`;
    }
  } catch (err) {
    entry.error = err.message;
    entry.retry = true;
  }
  return entry;
}

async function main([requestFile, resultFile]) {
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8').replace(/^\uFEFF/, ''));
  if (request.config) process.loadEnvFile(request.config);
  const cato = require('../lib/cato').client();
  const entra = require('../lib/entra');
  const graph = entra.configured ? require('../lib/graph').client() : null;
  const group = await readCato({ cato, graph, name: request.name || undefined });
  fs.writeFileSync(`${resultFile}.tmp`, JSON.stringify({ group }));
  fs.renameSync(`${resultFile}.tmp`, resultFile);
}

module.exports = { readCato, member };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    // Take-Snapshot.ps1 records this against the Cato group and tries again
    try { fs.writeFileSync(process.argv[3], JSON.stringify({ error: err.message })); } catch { /* nothing more to do */ }
    process.exit(1);
  });
}
