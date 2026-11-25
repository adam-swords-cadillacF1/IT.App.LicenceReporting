'use strict';
// Entra (cloud) groups: the Graph client against a fake Graph, and how Entra groups are stored and reported
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'Europe/London';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'licrep-entra-'));
delete process.env.ENTRA_TENANT_ID;

const { client, adGuidFromImmutableId } = require('../lib/graph');
const { readGroups } = require('../snapshot/entra-groups');
const snaps = require('../lib/snapshots');
const reports = require('../lib/reports');

// A fake Graph: routes map a URL (path + query, without the v1.0 prefix) to a list of responses, used in turn
function fakeGraph(routes) {
  const calls = [];
  const fetchImpl = async url => {
    const key = url.replace('https://graph.microsoft.com/v1.0', '');
    calls.push(key);
    const list = routes[key];
    if (!list) return new Response(JSON.stringify({ error: { code: 'Request_ResourceNotFound', message: 'nope' } }), { status: 404 });
    const r = list.length > 1 ? list.shift() : list[0];
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status || 200, headers: r.headers || {} });
  };
  return { graph: client({ fetchImpl, getToken: async () => 'token', sleep: async () => {} }), calls };
}

const GID = '11111111-2222-3333-4444-555555555555';
const MEMBERS = `/groups/${GID}/transitiveMembers?$select=id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled,onPremisesImmutableId&$top=999`;

test('a synced user\'s onPremisesImmutableId turns back into their AD objectGUID', () => {
  // .NET writes the first three parts of a GUID little-endian
  const guid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const bytes = Buffer.from('e004253f894fd3119a0c0305e82c3301', 'hex');
  assert.equal(adGuidFromImmutableId(bytes.toString('base64')), guid);
  assert.equal(adGuidFromImmutableId('not-a-guid'), null);
  assert.equal(adGuidFromImmutableId(null), null);
});

test('members: pages followed, users and contacts kept, devices dropped, synced users matched to AD', async () => {
  const synced = Buffer.from('e004253f894fd3119a0c0305e82c3301', 'hex').toString('base64');
  const { graph } = fakeGraph({
    [MEMBERS]: [{ body: { value: [
      { '@odata.type': '#microsoft.graph.user', id: 'cloud-1', displayName: 'Cloud Only', mail: 'c@x', userPrincipalName: 'c@x',
        jobTitle: 'Analyst', department: 'Finance', accountEnabled: true },
      { '@odata.type': '#microsoft.graph.device', id: 'dev-1', displayName: 'LAPTOP-1' },
    ], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2' } }],
    '/page2': [{ body: { value: [
      { '@odata.type': '#microsoft.graph.user', id: 'cloud-2', displayName: 'Hybrid Person', userPrincipalName: 'h@x',
        accountEnabled: false, onPremisesImmutableId: synced },
      { '@odata.type': '#microsoft.graph.orgContact', id: 'oc-1', displayName: 'Agency', mail: 'a@agency' },
    ] } }],
  });
  const members = await graph.groupMembers(GID);
  assert.deepEqual(members.map(m => [m.id, m.kind, m.name, m.enabled]), [
    ['cloud-1', 'user', 'Cloud Only', true],
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'user', 'Hybrid Person', false],
    ['oc-1', 'contact', 'Agency', null],
  ]);
  assert.equal(members[0].title, 'Analyst');
  assert.equal(members[0].department, 'Finance');
});

test('Graph throttling is waited out; a refusal explains the permissions needed', async () => {
  const { graph, calls } = fakeGraph({
    '/groups/x': [{ status: 429, headers: { 'retry-after': '1' } }, { status: 503 }, { body: { id: 'x' } }],
    '/groups/y': [{ status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } }],
  });
  assert.deepEqual(await graph.get('/groups/x'), { id: 'x' });
  assert.equal(calls.filter(c => c === '/groups/x').length, 3);
  await assert.rejects(graph.get('/groups/y'), /GroupMember\.Read\.All and User\.Read\.All/);
});

test('finding a group by name needs exactly one match; an object ID is looked up directly', async () => {
  const q = name => `/groups?$filter=displayName eq '${name}'&$select=id,displayName,onPremisesSyncEnabled`;
  const { graph } = fakeGraph({
    [q('One')]: [{ body: { value: [{ id: GID, displayName: 'One' }] } }],
    [q('None')]: [{ body: { value: [] } }],
    [q('Twice')]: [{ body: { value: [{ id: 'a' }, { id: 'b' }] } }],
    [q("O''Brien")]: [{ body: { value: [{ id: GID, displayName: "O'Brien" }] } }],
    [`/groups/${GID}?$select=id,displayName,onPremisesSyncEnabled`]: [{ body: { id: GID, displayName: 'By ID' } }],
  });
  assert.equal((await graph.findGroup('One')).id, GID);
  assert.equal((await graph.findGroup("O'Brien")).displayName, "O'Brien");
  assert.equal((await graph.findGroup(GID)).displayName, 'By ID');
  await assert.rejects(graph.findGroup('None'), /No Entra group called "None"/);
  await assert.rejects(graph.findGroup('Twice'), /2 Entra groups are called "Twice"\. Use the object ID/);
  await assert.rejects(graph.findGroup('99999999-2222-3333-4444-555555555555'), /No Entra group with object ID/);
});

test('entra-groups.js: a deleted group is not retried, a Graph fault is', async () => {
  const { graph } = fakeGraph({
    [`/groups/${GID}?$select=id,displayName`]: [{ body: { id: GID, displayName: 'Renamed in Entra' } }],
    [MEMBERS]: [{ status: 500 }],
  });
  const [gone, broken] = await readGroups([{ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Gone' }, { id: GID, name: 'Old name' }], graph);
  assert.deepEqual([gone.found, gone.error, gone.retry], [false, 'Group not found in Entra', false]);
  assert.equal(broken.found, true);
  assert.equal(broken.name, 'Renamed in Entra');
  assert.equal(broken.retry, true);
  assert.match(broken.error, /Microsoft Graph/);
});

const person = (id, extra = {}) => ({ id, kind: 'user', username: `${id}@x`, name: `Person ${id}`, email: `${id}@x`,
  title: 'T', department: 'D', enabled: true, ...extra });

test('Entra groups are listed after AD groups and written for the snapshot task', () => {
  const saved = snaps.setMonitoredEntraGroups([{ id: GID, name: 'Licence - Copilot' }]);
  assert.deepEqual(saved.map(g => [g.name, g.source, g.entraId]), [['Licence - Copilot', 'entra', GID]]);
  assert.equal(snaps.monitoredGroups().at(-1).name, 'Licence - Copilot');
  const file = JSON.parse(fs.readFileSync(snaps.GROUPS_FILE, 'utf8'));
  assert.deepEqual(file.entraGroups, [{ id: GID, name: 'Licence - Copilot' }]);
  assert.equal(file.groups.length, 13);
  assert.equal(file.node, process.execPath);
  assert.throws(() => snaps.setMonitoredEntraGroups([{ id: '22222222-2222-3333-4444-555555555555', name: 'DL-M365-Visio' }]), /same name as an AD group/);
  assert.throws(() => snaps.setMonitoredGroups(['Licence - Copilot']), /is an Entra group/);
});

test('snapshots with Entra groups: renames keep history, and someone in AD and Entra groups is one person', () => {
  const snap = (date, entraName) => ({ version: 1, date, takenAt: new Date(`${date}T00:10:00`).toISOString(), groups: [
    { name: 'DL-M365-Visio', found: true, error: null, members: [person('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), person('ad-only')] },
    { name: entraName, source: 'entra', entraId: GID.toUpperCase(), found: true, error: null,
      members: [person('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), person('cloud-1')] },
  ] });
  snaps.importSnapshot(snap('2026-11-01', 'Licence - Copilot'));
  snaps.importSnapshot(snap('2026-11-02', 'Licence - M365 Copilot'));
  const groups = snaps.snapshotGroups(snaps.snapshotByDate('2026-11-02').id);
  assert.deepEqual(groups.map(g => [g.name, g.source, g.count]), [['DL-M365-Visio', 'ad', 2], ['Licence - M365 Copilot', 'entra', 2]]);
  // The renamed group is the same group: both days are under the new name
  const series = snaps.dashboard({ today: '2026-11-02' }).groups.find(g => g.name === 'Licence - M365 Copilot').series;
  assert.deepEqual(series.map(p => p.date), ['2026-11-01', '2026-11-02']);
  assert.equal(snaps.dashboard({ today: '2026-11-02' }).people, 3);
  assert.throws(() => snaps.normaliseSnapshot({ version: 1, date: '2026-11-03', takenAt: '2026-11-03T00:10:00Z',
    groups: [{ name: 'X', source: 'entra', found: true }] }), /no Entra object ID/);
});

test('the month-end summary says which groups come from Entra', () => {
  const unzipSheet = buf => require('node:zlib').inflateRawSync(buf.subarray(buf.indexOf('xl/worksheets/sheet1.xml') + 24,
    buf.indexOf('PK', buf.indexOf('xl/worksheets/sheet1.xml')))).toString();
  const sheet = unzipSheet(reports.monthEndWorkbook(snaps.monthEnd('2026-11', '2026-11-25'), 'Test'));
  assert.ok(sheet.includes('>Source<'));
  assert.ok(sheet.includes('>Entra ID<'));
  assert.ok(sheet.includes('>AD<'));
});
