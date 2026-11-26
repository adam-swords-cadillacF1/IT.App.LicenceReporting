'use strict';
// Cato ZTNA licences: the API client against a fake Cato, the snapshot reader, and how the Cato group is stored and reported
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'Europe/London';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'licrep-cato-'));
delete process.env.ENTRA_TENANT_ID;

const cato = require('../lib/cato');
const { readCato, member } = require('../snapshot/cato-users');
const snaps = require('../lib/snapshots');
const reports = require('../lib/reports');

const ENV = { CATO_API_KEY: 'test-key-123', CATO_ACCOUNT_ID: '4242' };
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

// A fake Cato: answers each request with the next reply from `replies` (a function gets the parsed request)
function fakeCato(replies) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const request = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, request });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    return typeof next === 'function' ? next(request) : next;
  };
  return { api: cato.client({ fetchImpl, env: ENV, sleep: async () => {} }), calls };
}

const user = (n, extra = {}) => ({ id: `u${n}`, displayName: `Person ${n}`, email: `p${n}@example.invalid`, userPrincipalName: `p${n}@example.invalid`,
  userStatus: 'ACTIVE', hasRemoteAccessEligibility: true, department: 'Aero', jobTitle: 'Engineer', objectId: null, ...extra });
const page = (items, total) => reply({ data: { user: { userList: { items, pageInfo: { total } } } } });
const licensing = info => reply({ data: { licensing: { licensingInfo: info } } });

test('settings: both the key and the account are needed', () => {
  assert.equal(cato.isConfigured({}), false);
  assert.equal(cato.isConfigured({ CATO_API_KEY: 'k' }), false);
  assert.equal(cato.isConfigured(ENV), true);
  assert.equal(cato.settings(ENV).url, cato.DEFAULT_URL);
  assert.throws(() => cato.client({ env: {} }), /account ID and API key in Admin › Settings/);
});

test('licensed users: pages are followed and only users eligible for licensed remote access are kept', async () => {
  const { api, calls } = fakeCato([
    req => page([user(1), user(2, { hasRemoteAccessEligibility: false })], 3),
    req => page([user(3, { userStatus: 'LOCKED' })], 3),
  ]);
  const users = await api.licensedUsers();
  assert.deepEqual(users.map(u => u.id), ['u1', 'u3']);
  assert.deepEqual(calls.map(c => c.request.variables.input.paging), [{ from: 0, limit: 100 }, { from: 2, limit: 100 }]);
  assert.equal(calls[0].url, cato.DEFAULT_URL);
  assert.equal(calls[0].headers['x-api-key'], 'test-key-123');
  assert.equal(calls[0].request.variables.accountId, '4242');
  assert.match(calls[0].request.query, /userList\(input: \$input\)/);
});

test('throttling and server faults are waited out; refusals and GraphQL errors are explained without the key', async () => {
  const { api, calls } = fakeCato([reply({}, 429, { 'retry-after': '1' }), reply({ errors: [{ message: 'rate limit exceeded' }] }), reply({}, 503), page([user(1)], 1)]);
  assert.equal((await api.licensedUsers()).length, 1);
  assert.equal(calls.length, 4);

  const refused = fakeCato([reply({ errors: [{ message: 'unauthorized' }] }, 401)]).api;
  await assert.rejects(refused.licensedUsers(), err => /refused the API key/.test(err.message) && !err.message.includes('test-key-123'));
  const denied = fakeCato([reply({ errors: [{ message: 'permission denied (Code104)' }], data: { user: null } })]).api;
  await assert.rejects(denied.licensedUsers(), /permission denied.*check the API key's permissions/);
  const empty = fakeCato([reply({ data: { user: { userList: null } } })]).api;
  await assert.rejects(empty.licensedUsers(), /user list was missing/);
});

test('licence totals: the account-wide ZTNA allocation, or the active licences added up', async () => {
  const lic = (total, status = 'ACTIVE') => ({ sku: 'CATO_ZTNA_USERS', status, total, expirationDate: '2027-06-30T00:00:00Z' });
  let { api } = fakeCato([licensing({ globalLicenseAllocations: { ztnaUsers: { total: 500, allocated: 412, available: 88 } }, ztnaUsers: [lic(500)] })]);
  assert.deepEqual(await api.ztnaLicences(), { total: 500, used: 412, available: 88, licences: [lic(500)] });
  ({ api } = fakeCato([licensing({ globalLicenseAllocations: { ztnaUsers: null }, ztnaUsers: [lic(300), lic(200), lic(50, 'DISABLED')] })]));
  assert.deepEqual(await api.ztnaLicences().then(t => [t.total, t.used]), [500, null]);
  ({ api } = fakeCato([licensing({ globalLicenseAllocations: { ztnaUsers: null }, ztnaUsers: [] })]));
  assert.equal(await api.ztnaLicences(), null);
});

test('reader: members in the snapshot shape, matched to AD or Entra where Cato knows the Entra user', async () => {
  const synced = Buffer.from('e004253f894fd3119a0c0305e82c3301', 'hex').toString('base64');
  const fakeApi = { licensedUsers: async () => [
    user(1, { objectId: 'AAAAAAAA-1111-2222-3333-444444444444' }),   // synced from AD
    user(2, { objectId: 'bbbbbbbb-1111-2222-3333-444444444444', userStatus: 'DISABLED' }),   // cloud-only
    user(3, { displayName: '', firstName: 'Jo', lastName: 'Bloggs' }),   // no Entra link
  ], ztnaLicences: async () => ({ total: 500, used: 412, available: 88, licences: [] }) };
  const graphCalls = [];
  const graph = { getAll: async url => { graphCalls.push(url); return [
    { id: 'aaaaaaaa-1111-2222-3333-444444444444', onPremisesImmutableId: synced },
    { id: 'bbbbbbbb-1111-2222-3333-444444444444', onPremisesImmutableId: null },
  ]; } };
  const entry = await readCato({ cato: fakeApi, graph });
  assert.deepEqual([entry.found, entry.error, entry.retry, entry.source, entry.name], [true, null, false, 'cato', 'Cato ZTNA users']);
  assert.deepEqual(entry.licences, { total: 500, used: 412 });
  assert.deepEqual(entry.members.map(m => [m.id, m.name, m.enabled]), [
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'Person 1', true],
    ['bbbbbbbb-1111-2222-3333-444444444444', 'Person 2', false],
    ['cato:u3', 'Jo Bloggs', true],
  ]);
  assert.equal(graphCalls.length, 1);
  // Without Graph (development), the Entra object ID is used as it is
  assert.equal(member(user(1, { objectId: 'AAAAAAAA-1111-2222-3333-444444444444' }), null).id, 'aaaaaaaa-1111-2222-3333-444444444444');
});

test('reader: a Cato or Graph failure is retried; failing licence totals are only a warning', async () => {
  const down = await readCato({ cato: { licensedUsers: async () => { throw new Error('Cato API: HTTP 502'); } } });
  assert.deepEqual([down.found, down.retry], [false, true]);
  assert.match(down.error, /HTTP 502/);
  const noGraph = await readCato({ cato: { licensedUsers: async () => [user(1, { objectId: 'aaaaaaaa-1111-2222-3333-444444444444' })] },
    graph: { getAll: async () => { throw new Error('Microsoft Graph refused access'); } } });
  assert.deepEqual([noGraph.found, noGraph.retry, noGraph.members.length], [false, true, 0]);
  const beta = await readCato({ cato: { licensedUsers: async () => [user(1)], ztnaLicences: async () => { throw new Error('permission denied'); } } });
  assert.deepEqual([beta.found, beta.error, beta.licences, beta.members.length], [true, null, null, 1]);
  assert.match(beta.warning, /Licence totals not read: permission denied/);
});

const person = (id, extra = {}) => ({ id, kind: 'user', username: `${id}@x`, name: `Person ${id}`, email: `${id}@x`,
  title: 'T', department: 'D', enabled: true, ...extra });
const snap = (date, catoGroup) => ({ version: 1, date, takenAt: new Date(`${date}T00:10:00`).toISOString(), groups: [
  { name: 'DL-M365-Visio', found: true, error: null, members: [person('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), person('ad-only')] },
  catoGroup,
] });
const catoEntry = (members, licences = { total: 500, used: 412 }, extra = {}) =>
  ({ name: 'Cato ZTNA users', source: 'cato', found: true, error: null, warning: null, licences, members, ...extra });

test('switching Cato on adds it after the AD and Entra groups and writes it for the snapshot task', () => {
  snaps.writeGroupsFile();
  assert.equal(JSON.parse(fs.readFileSync(snaps.GROUPS_FILE, 'utf8')).cato, null, 'off until switched on');
  const g = snaps.setCatoMonitored(true);
  assert.equal(g.name, 'Cato ZTNA users');
  assert.equal(snaps.monitoredGroups().at(-1).source, 'cato');
  assert.deepEqual(JSON.parse(fs.readFileSync(snaps.GROUPS_FILE, 'utf8')).cato, { name: 'Cato ZTNA users' });
  assert.throws(() => snaps.setMonitoredGroups(['DL-M365-Visio', 'Cato ZTNA users']), /Cato licence list/);
  snaps.setCatoMonitored(false);
  assert.equal(JSON.parse(fs.readFileSync(snaps.GROUPS_FILE, 'utf8')).cato, null);
  assert.equal(snaps.catoGroup().id, g.id, 'switching off keeps the group and its history');
  snaps.setCatoMonitored(true);
});

test('snapshots with the Cato group: licence totals stored, someone in AD and Cato is one person', () => {
  snaps.importSnapshot(snap('2026-11-01', catoEntry([person('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), person('cato:u9', { enabled: false })])));
  snaps.importSnapshot(snap('2026-11-02', catoEntry([person('3f2504e0-4f89-11d3-9a0c-0305e82c3301')], null)));
  const day1 = snaps.snapshotGroups(snaps.snapshotByDate('2026-11-01').id).find(g => g.source === 'cato');
  assert.deepEqual([day1.count, day1.disabled, day1.licenceTotal, day1.licenceUsed], [2, 1, 500, 412]);
  const day2 = snaps.snapshotGroups(snaps.snapshotByDate('2026-11-02').id).find(g => g.source === 'cato');
  assert.deepEqual([day2.licenceTotal, day2.licenceUsed], [null, null], 'a day without totals has none, not zero');
  const dash = snaps.dashboard({ today: '2026-11-02' });
  assert.equal(dash.people, 2, 'the person in an AD group and in Cato is counted once');
  assert.deepEqual(snaps.compare(snaps.snapshotByDate('2026-11-01').id, snaps.snapshotByDate('2026-11-02').id)
    .find(c => c.name === 'Cato ZTNA users').removed.map(m => m.objectId), ['cato:u9']);
  assert.equal(snaps.snapshotGroups(snaps.snapshotByDate('2026-11-01').id).find(g => g.name === 'DL-M365-Visio').licenceTotal, null);
});

test('bad Cato data in a snapshot file is rejected', () => {
  const bad = licences => () => snaps.normaliseSnapshot(snap('2026-11-03', catoEntry([], licences)));
  assert.throws(bad({ total: -1 }), /bad licence count/);
  assert.throws(bad({ total: 1.5 }), /bad licence count/);
  assert.throws(bad({ total: '500' }), /bad licence count/);
  assert.doesNotThrow(bad({ total: 500 }));
  assert.throws(() => snaps.normaliseSnapshot(snap('2026-11-03', catoEntry([], null, { source: 'okta' }))), /unknown source okta/);
});

test('a Cato read that failed makes the snapshot partial, and a later complete one replaces it', () => {
  const failed = catoEntry([], null, { found: false, error: 'Cato API: HTTP 502' });
  assert.equal(snaps.importSnapshot(snap('2026-11-04', failed)).status, 'partial');
  assert.equal(snaps.importSnapshot(snap('2026-11-04', catoEntry([person('x')]))).outcome, 'replaced');
});

test('Excel: the summary has licence columns when a group has totals, and the Cato sheet says what it lists', () => {
  const files = {};
  const buf = reports.monthEndWorkbook(snaps.monthEnd('2026-11', '2026-11-25'), 'Test');
  // Read every sheet back out of the zip
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18), nameLen = buf.readUInt16LE(p + 26), extra = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    files[name] = zlib.inflateRawSync(buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size)).toString('utf8');
    p += 30 + nameLen + extra + size;
  }
  const summary = files['xl/worksheets/sheet1.xml'];
  assert.ok(summary.includes('>Licences purchased<'));
  assert.ok(summary.includes('>Licences allocated (vendor)<'));
  assert.ok(summary.includes('>Cato<'));
  const catoSheet = Object.values(files).find(x => x.includes('Lists the Cato users eligible for licensed remote access'));
  assert.ok(catoSheet, 'the Cato group has its own sheet');
});

// ── Settings entered in the app (Admin › Settings) ──

const secrets = require('../lib/secrets');
const catoSettings = require('../lib/cato-settings');
const { getSetting } = require('../lib/db');
const KEY = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';

test('stored secrets: encrypted, tied to their purpose, and unreadable under a different SESSION_SECRET', () => {
  const blob = secrets.encrypt(KEY, 'cato-api-key');
  assert.match(blob, /^v1:/);
  assert.ok(!blob.includes(KEY));
  assert.notEqual(secrets.encrypt(KEY, 'cato-api-key'), blob, 'a fresh IV every time');
  assert.equal(secrets.decrypt(blob, 'cato-api-key'), KEY);
  assert.throws(() => secrets.decrypt(blob, 'something-else'));
  assert.throws(() => secrets.decrypt(`${blob.slice(0, -4)}AAAA`, 'cato-api-key'));
  assert.throws(() => secrets.decrypt('plain text', 'cato-api-key'), /Not an encrypted value/);
  const before = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a-different-secret';
  try { assert.throws(() => secrets.decrypt(blob, 'cato-api-key')); } finally {
    if (before === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = before;
  }
});

test('Cato settings: checked, the key kept encrypted and never repeated in errors, a blank key keeps the saved one', () => {
  catoSettings.clear();
  assert.throws(() => catoSettings.save({ accountId: '', apiKey: KEY }, 'it'), /Enter the Cato account ID/);
  assert.throws(() => catoSettings.save({ accountId: '4242' }, 'it'), /Enter the Cato API key/);
  const badKey = 'has spaces in it but is long enough';
  assert.throws(() => catoSettings.save({ accountId: '4242', apiKey: badKey }, 'it'), err => /doesn't look like a Cato API key/.test(err.message) && !err.message.includes('spaces in it'));
  assert.deepEqual(catoSettings.save({ accountId: '4242', apiKey: KEY }, 'it@example'), ['account ID 4242', 'API key added']);
  assert.ok(!getSetting('cato_api_key').includes(KEY), 'stored encrypted');
  const s = catoSettings.stored();
  assert.deepEqual([s.saved, s.accountId, s.apiKey, s.keySaved, s.keyError, s.updatedBy], [true, '4242', KEY, true, null, 'it@example']);
  assert.deepEqual(catoSettings.save({ accountId: '4242', apiKey: '' }, 'it'), [], 'nothing changed');
  assert.deepEqual(catoSettings.save({ accountId: '5555' }, 'it'), ['account ID 4242 → 5555']);
  assert.equal(catoSettings.stored().apiKey, KEY, 'the key is kept');
  assert.deepEqual(catoSettings.save({ accountId: '5555', apiKey: `${KEY}X` }, 'it'), ['API key replaced']);
});

test('the app\'s settings win over app.env as a whole; app.env is used when nothing is saved', () => {
  catoSettings.clear();
  catoSettings.save({ accountId: '4242', apiKey: KEY }, 'it');
  const both = cato.settings({ CATO_API_KEY: 'env-key-0000000000', CATO_ACCOUNT_ID: '9999' });
  assert.deepEqual([both.source, both.accountId, both.apiKey], ['settings', '4242', KEY]);
  assert.equal(cato.isConfigured({}), true);
  catoSettings.clear();
  const env = cato.settings({ CATO_API_KEY: 'env-key-0000000000', CATO_ACCOUNT_ID: '9999' });
  assert.deepEqual([env.source, env.accountId], ['app.env', '9999']);
  assert.equal(cato.settings({}).source, null);
  assert.equal(cato.isConfigured({}), false);
});

test('a saved key that no longer decrypts says to enter it again, and the client won\'t use app.env instead', async () => {
  catoSettings.clear();
  catoSettings.save({ accountId: '4242', apiKey: KEY }, 'it');
  const before = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'rotated-secret';
  try {
    const s = cato.settings({ CATO_API_KEY: 'env-key-0000000000', CATO_ACCOUNT_ID: '9999' });
    assert.equal(s.source, 'settings');
    assert.equal(s.keyError, catoSettings.KEY_UNREADABLE);
    assert.equal(cato.isConfigured({}), false);
    assert.throws(() => cato.client({ env: {} }), /can't be decrypted.*Enter it again in Admin › Settings/);
  } finally {
    if (before === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = before;
  }
  // With the right secret again, the client sends the saved key
  const calls = [];
  const api = cato.client({ env: {}, sleep: async () => {}, fetchImpl: async (url, opts) => { calls.push(opts.headers['x-api-key']); return page([], 0); } });
  await api.allUsers();
  assert.deepEqual(calls, [KEY]);
  assert.equal(catoSettings.clear(), true);
  assert.equal(catoSettings.stored().saved, false);
});

// ── Cato page: month by month, CSV and Excel ──

const { field } = require('../lib/csv');

test('CSV fields: quoted when needed, and text that a spreadsheet would run as a formula is made plain text', () => {
  assert.equal(field('plain'), 'plain');
  assert.equal(field('Lead, "Design"'), '"Lead, ""Design"""');
  assert.equal(field('two\nlines'), '"two\nlines"');
  assert.equal(field('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(field('+44 20'), "'+44 20");
  assert.equal(field('@sum'), "'@sum");
  assert.equal(field(-3), '-3', 'numbers stay numbers');
  assert.equal(field(null), '');
});

test('Cato report: users at each month end, with the change from the month before', () => {
  // Earlier tests left 2026-11-01 ([AD person, cato:u9]) and 2026-11-04 ([x]); add August and September month ends
  snaps.importSnapshot(snap('2026-09-01', catoEntry([person('a'), person('b')], { total: 300, used: 2 })));
  snaps.importSnapshot(snap('2026-10-01', catoEntry([person('a'), person('b'), person('c', { name: '=cmd|evil', title: 'Lead, "Design"' })], { total: 300, used: 3 })));
  const r = snaps.catoReport(null, '2026-11-25');
  assert.deepEqual(r.group, { name: 'Cato ZTNA users', label: null, monitored: true });
  assert.deepEqual(r.months.map(m => [m.month, m.basis, m.count, m.net, m.added, m.removed]), [
    ['2026-11', 'month-to-date', 1, -1, 1, 2],
    ['2026-10', 'month-end', 2, -1, 2, 3],
    ['2026-09', 'month-end', 3, 1, 1, 0],
    ['2026-08', 'month-end', 2, null, null, null],
  ]);
  assert.deepEqual([r.months[2].licenceTotal, r.months[2].licenceUsed, r.months[2].previousDate], [300, 3, '2026-09-01']);
  assert.equal(r.selected.month, '2026-11', 'the latest month by default');
  assert.deepEqual(r.selected.rows.map(m => m.objectId), ['x']);
  assert.deepEqual(r.selected.joined.map(m => m.objectId), ['x']);
  assert.equal(r.selected.left.length, 2);
  assert.ok(r.series.length >= 4);

  const sep = snaps.catoReport('2026-09', '2026-11-25').selected;
  assert.deepEqual([sep.date, sep.count, sep.previousDate], ['2026-10-01', 3, '2026-09-01']);
  assert.deepEqual(sep.joined.map(m => m.objectId), ['c']);
  assert.throws(() => snaps.catoReport('2026-9', '2026-11-25'), /YYYY-MM/);
  assert.throws(() => snaps.catoReport('2025-01', '2026-11-25'), /no Cato snapshot for 2025-01/);
});

test('Cato CSV and Excel: the month\'s users, with formula-like text made safe', () => {
  const r = snaps.catoReport('2026-09', '2026-11-25');
  const csv = reports.catoUsersCsv(r).toString('utf8');
  assert.ok(csv.startsWith('﻿Name,Email,Username,Job title,Department,Account status,Snapshot date\r\n'));
  assert.equal(csv.trim().split('\r\n').length, 4, 'a header and three users');
  assert.ok(csv.includes(`"'=cmd|evil"`) || csv.includes("'=cmd|evil"));
  assert.ok(csv.includes('"Lead, ""Design"""'));
  assert.ok(csv.includes(',2026-10-01\r\n'));

  const xlsx = reports.catoWorkbook(r, 'Test');
  const names = [];
  for (let p = 0; xlsx.readUInt32LE(p) === 0x04034b50;) {
    const size = xlsx.readUInt32LE(p + 18), nameLen = xlsx.readUInt16LE(p + 26), extra = xlsx.readUInt16LE(p + 28);
    if (xlsx.toString('utf8', p + 30, p + 30 + nameLen) === 'xl/workbook.xml') {
      names.push(...[...zlib.inflateRawSync(xlsx.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size)).toString().matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]));
    }
    p += 30 + nameLen + extra + size;
  }
  assert.deepEqual(names, ['Month by month', 'Users 2026-09', 'Joiners and leavers']);
});
