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
  const env = { ...process.env, DATA_DIR, PORT: String(PORT), AUTH_MODE: 'dev', APP_CONFIG: '' };
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
