'use strict';
// Starts the real server (development sign-in, throwaway data folder, sample snapshots) and checks the API
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'licrep-api-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

test.before(async () => {
  // Sample snapshots go in first, so the server imports them as it starts
  // No Cato account here, whatever the developer's own environment has
  const env = { ...process.env, DATA_DIR, PORT: String(PORT), AUTH_MODE: 'dev', APP_CONFIG: '', CATO_API_KEY: '', CATO_ACCOUNT_ID: '' };
  await new Promise((resolve, reject) => {
    const gen = spawn(process.execPath, ['scripts/sample-data.js', '75'], { cwd: ROOT, env, stdio: 'ignore' });
    gen.on('exit', code => (code === 0 ? resolve() : reject(new Error(`sample-data exited ${code}`))));
  });
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 100 && !log.includes('listening'); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(log, /listening/, log);
});
test.after(() => server?.kill());

async function signIn(role) {
  const res = await fetch(`${BASE}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (url, opts = {}) => fetch(`${BASE}${url}`, { ...opts, headers: { Cookie: cookie, ...(opts.headers || {}) } });
}

test('signed-out requests are refused and the app page redirects to sign-in', async () => {
  assert.equal((await fetch(`${BASE}/api/dashboard`)).status, 401);
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('a viewer (Finance) sees the dashboard and reports but not Admin', async () => {
  const get = await signIn('viewer');
  const dash = await (await get('/api/dashboard')).json();
  assert.equal(dash.groups.length, 13);
  assert.ok(dash.groups.every(g => typeof g.count === 'number' && g.series.length > 1));
  const meta = await (await get('/api/meta')).json();
  assert.equal(meta.dates.length, 75);
  for (const url of ['/api/admin/groups', '/api/admin/snapshots', '/api/admin/activity', '/api/admin/settings']) {
    assert.equal((await get(url)).status, 403, url);
  }
  const put = await get('/api/admin/groups', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"groups":["X"]}' });
  assert.equal(put.status, 403);
  assert.equal((await get('/api/admin/snapshot-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await get('/api/admin/entra-groups')).status, 403);
  assert.equal((await get('/api/admin/entra-groups', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"lines":["X"]}' })).status, 403);
});

test('an admin can add Entra groups (looked up without Entra in development) and they reach the snapshot task', async () => {
  const get = await signIn('admin');
  const put = body => get('/api/admin/entra-groups', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const r = await (await put({ lines: ['Licence - Copilot', '', 'Licence - Copilot', 'Shown name  (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)'] })).json();
  assert.deepEqual(r.groups.map(g => g.name), ['Licence - Copilot', 'Entra group aaaaaaaa']);
  assert.equal(r.groups[1].id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'groups.json'), 'utf8'));
  assert.deepEqual(file.entraGroups.map(g => g.name), ['Licence - Copilot', 'Entra group aaaaaaaa']);
  assert.equal((await put({ lines: ['DL-M365-Visio'] })).status, 400);   // same name as an AD group
  const meta = await (await get('/api/meta')).json();
  assert.ok(meta.groups.some(g => g.name === 'Licence - Copilot' && g.source === 'entra'));
});

test('Cato: only admins see or change it; switching it on reaches the snapshot task; Test says what is missing', async () => {
  const viewer = await signIn('viewer');
  assert.equal((await viewer('/api/admin/cato')).status, 403);
  assert.equal((await viewer('/api/admin/cato/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);

  const get = await signIn('admin');
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual(await (await get('/api/admin/cato')).json(),
    { configured: false, enabled: false, name: 'Cato ZTNA users', label: null, accountId: null, apiUrl: 'https://api.catonetworks.com/api/v1/graphql2',
      source: null, keySaved: false, keyError: null, updatedBy: null, updatedAt: null });
  assert.equal((await get('/api/admin/cato', json('PUT', { enabled: 'yes' }))).status, 400);
  assert.equal((await (await get('/api/admin/cato', json('PUT', { enabled: true }))).json()).enabled, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'groups.json'), 'utf8')).cato, { name: 'Cato ZTNA users' });
  const meta = await (await get('/api/meta')).json();
  assert.equal(meta.groups.at(-1).source, 'cato');
  const tested = await get('/api/admin/cato/test', json('POST', {}));
  assert.equal(tested.status, 400);
  assert.match((await tested.json()).error, /account ID and API key in Admin › Settings/);
  const activity = await (await get('/api/admin/activity')).json();
  assert.ok(activity.some(a => a.action === 'Switched Cato licences on'));
});

test('Cato API settings: entered by an admin, the key is never sent back or logged, and can be removed', async () => {
  const KEY = 'Zy9xWv8uTs7rQp6oNm5lKj4iHg3fEd2c';
  const viewer = await signIn('viewer');
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await viewer('/api/admin/cato-settings', json('PUT', { accountId: '4242', apiKey: KEY }))).status, 403);
  assert.equal((await viewer('/api/admin/cato-settings', json('DELETE', {}))).status, 403);

  const get = await signIn('admin');
  const bad = await get('/api/admin/cato-settings', json('PUT', { accountId: '4242', apiKey: 'not a key at all, with spaces' }));
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes('with spaces'));
  const saved = await get('/api/admin/cato-settings', json('PUT', { accountId: '4242', apiKey: KEY }));
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.ok(!text.includes(KEY), 'the key is never sent back');
  const status = JSON.parse(text);
  assert.deepEqual([status.configured, status.source, status.accountId, status.keySaved, status.updatedBy], [true, 'settings', '4242', true, 'dev.admin@localhost']);
  assert.ok(!(await (await get('/api/admin/cato')).text()).includes(KEY));
  const activity = await (await get('/api/admin/activity')).text();
  assert.ok(activity.includes('Changed the Cato API settings'));
  assert.ok(!activity.includes(KEY), 'the key is not in the activity log');
  // The database and its write-ahead log (recent writes may only be there yet)
  for (const file of ['licences.db', 'licences.db-wal'].map(f => path.join(DATA_DIR, f)).filter(f => fs.existsSync(f))) {
    assert.ok(!fs.readFileSync(file).includes(KEY), `the key is not stored in plain text in ${path.basename(file)}`);
  }

  const removed = await (await get('/api/admin/cato-settings', json('DELETE', {}))).json();
  assert.deepEqual([removed.configured, removed.source, removed.keySaved], [false, null, false]);
});

test('Cato page: everyone signed in sees the users and month-to-month change, and can download CSV or Excel', async () => {
  // Snapshots with Cato in them, on dates before the sample data, written straight into the server's database
  const catoSnap = (date, ids) => ({ version: 1, date, takenAt: new Date(`${date}T00:10:00Z`).toISOString(), groups: [{
    name: 'Cato ZTNA users', source: 'cato', found: true, error: null, licences: { total: 100, used: ids.length },
    members: ids.map(id => ({ id: `cato:${id}`, kind: 'user', username: `${id}@x`, name: `User ${id}`, email: `${id}@example.invalid`, title: '', department: '', enabled: true })),
  }] });
  const code = 'const s = require("./lib/snapshots"); for (const x of JSON.parse(process.env.SNAPS)) s.importSnapshot(x);';
  const out = require('node:child_process').spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { ...process.env, DATA_DIR, TZ: 'Europe/London',
    SNAPS: JSON.stringify([catoSnap('2025-01-01', ['u1', 'u2']), catoSnap('2025-02-01', ['u1', 'u2', 'u3']), catoSnap('2025-02-10', ['u2', 'u3'])]) } });
  assert.equal(out.status, 0, String(out.stderr));

  const get = await signIn('viewer');
  assert.deepEqual((await (await get('/api/meta')).json()).cato, { name: 'Cato ZTNA users', label: null, monitored: true });
  const r = await (await get('/api/cato')).json();
  assert.deepEqual(r.months.map(m => [m.month, m.count, m.net]), [['2025-02', 2, -1], ['2025-01', 3, 1], ['2024-12', 2, null]]);
  assert.equal(r.selected.month, '2025-02');
  assert.deepEqual(r.selected.left.map(m => m.name), ['User u1']);
  assert.equal((await (await get('/api/cato?month=2025-01')).json()).selected.count, 3);
  assert.equal((await get('/api/cato?month=bad')).status, 400);
  assert.equal((await get('/api/cato?month=2030-01')).status, 404);

  const csv = await get('/api/cato/users.csv?month=2025-01');
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="Cato ZTNA users 2025-02-01\.csv"/);
  const text = await csv.text();
  assert.match(text, /^\uFEFF?Name,Email,Username,Job title,Department,Account status,Snapshot date\r\n/);
  assert.ok(text.includes('User u3,u3@example.invalid,u3@x,,,Enabled,2025-02-01'));
  const xlsx = await get('/api/cato.xlsx?month=2025-01');
  assert.equal(xlsx.status, 200);
  assert.equal(Buffer.from(await xlsx.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  const activity = await (await (await signIn('admin'))('/api/admin/activity')).json();
  assert.ok(activity.some(a => a.action === 'Downloaded Cato users (CSV)' && a.detail.startsWith('2025-01')));
  assert.ok(activity.some(a => a.action === 'Downloaded Cato users report'));
});

test('friendly names: an admin sets them, they show in the API and Excel, and viewers cannot change them', async () => {
  const admin = await signIn('admin');
  const put = (get, body) => get('/api/admin/group-labels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const groups = await (await admin('/api/admin/group-labels')).json();
  const e3 = groups.find(g => g.name === 'DL-M365-E3-License');
  const saved = await (await put(admin, { labels: [{ id: e3.id, label: '  Microsoft 365 E3  ' }] })).json();
  assert.equal(saved.find(g => g.id === e3.id).label, 'Microsoft 365 E3');
  const copilot = groups.find(g => g.name === 'DL-M365-CoPilot');
  assert.equal((await put(admin, { labels: [{ id: copilot.id, label: 'microsoft 365 e3' }] })).status, 400);   // same as another
  assert.equal((await put(admin, { labels: [{ id: copilot.id, label: 'x'.repeat(81) }] })).status, 400);

  const viewer = await signIn('viewer');
  assert.equal((await put(viewer, { labels: [{ id: e3.id, label: 'Nope' }] })).status, 403);
  const meta = await (await viewer('/api/meta')).json();
  assert.equal(meta.groups.find(g => g.name === 'DL-M365-E3-License').label, 'Microsoft 365 E3');
  const dash = await (await viewer('/api/dashboard')).json();
  assert.equal(dash.groups.find(g => g.name === 'DL-M365-E3-License').label, 'Microsoft 365 E3');
  const members = await (await viewer(`/api/members?group=DL-M365-E3-License`)).json();
  assert.ok(members.rows.every(r => r.groupLabel === 'Microsoft 365 E3'));
  const activity = await (await admin('/api/admin/activity')).json();
  assert.ok(activity.some(a => a.action === 'Changed friendly names' && /DL-M365-E3-License: "Microsoft 365 E3"/.test(a.detail)));
});

test('reports: members on a date, compare, and month end, as JSON and Excel', async () => {
  const get = await signIn('viewer');
  const meta = await (await get('/api/meta')).json();
  const members = await (await get(`/api/members?date=${meta.dates[10]}&group=DL-M365-E3-License`)).json();
  assert.equal(members.snapshot.date, meta.dates[10]);
  assert.ok(members.rows.length > 100);
  assert.ok(members.rows.every(r => r.group === 'DL-M365-E3-License' && 'title' in r && 'department' in r && 'email' in r));

  const cmp = await (await get(`/api/compare?from=${meta.dates[0]}&to=${meta.last}`)).json();
  assert.ok(cmp.groups.some(g => g.added.length || g.removed.length));
  assert.equal((await get(`/api/compare?from=${meta.last}&to=${meta.dates[0]}`)).status, 400);

  const month = meta.months[1];
  const me = await (await get(`/api/month-end?month=${month}`)).json();
  assert.equal(me.basis, 'month-end');
  assert.equal(me.snapshot.date.slice(8), '01');

  for (const url of [`/api/month-end.xlsx?month=${month}`, `/api/members.xlsx?date=${meta.last}`, `/api/compare.xlsx?from=${meta.dates[0]}&to=${meta.last}`]) {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(res.headers.get('content-disposition'), /attachment; filename=".+\.xlsx"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts like a zip');
  }
  assert.equal((await get('/api/members?date=2026-13-01')).status, 400);
  assert.equal((await get('/api/members?group=Nope')).status, 404);
});

test('an admin can change the group list, take a snapshot, and every download is logged', async () => {
  const get = await signIn('admin');
  const json = body => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const groups = await (await get('/api/admin/groups')).json();
  const saved = await (await get('/api/admin/groups', json({ groups: [...groups, 'DL-New-Group'] }))).json();
  assert.equal(saved.at(-1), 'DL-New-Group');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'groups.json'), 'utf8')).groups, saved);
  assert.equal((await get('/api/admin/groups', json({ groups: ['bad*'] }))).status, 400);

  // Form posts are refused (CSRF protection): only JSON changes anything
  const form = await get('/api/admin/groups', { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'groups=x' });
  assert.equal(form.status, 415);

  // Today's sample snapshot already exists and is complete, so "now" is refused
  assert.equal((await get('/api/admin/snapshot-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 409);

  // Shortening retention must be confirmed with the number it would delete
  const first = await get('/api/admin/settings', json({ retentionMonths: 1 }));
  assert.equal(first.status, 409);
  const { confirmDelete } = await first.json();
  assert.ok(confirmDelete > 0);
  const second = await (await get('/api/admin/settings', json({ retentionMonths: 1, confirmDelete }))).json();
  assert.equal(second.deleted, confirmDelete);

  const activity = await (await get('/api/admin/activity')).json();
  for (const action of ['Downloaded month-end report', 'Downloaded members report', 'Downloaded comparison report', 'Changed the group list', 'Changed retention']) {
    assert.ok(activity.some(a => a.action === action), action);
  }
});
