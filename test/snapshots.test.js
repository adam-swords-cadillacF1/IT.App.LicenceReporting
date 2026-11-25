'use strict';
// Run with: npm test   (uses a throwaway data folder; never touches ./data)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'Europe/London';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'licrep-test-'));

const { db, DEFAULT_GROUPS, setSetting, getSetting } = require('../lib/db');
const snaps = require('../lib/snapshots');
const reports = require('../lib/reports');
const { workbook, sheetNames } = require('../lib/xlsx');

// Reads a zip produced by lib/xlsx.js back into { name: text }
function unzip(buf) {
  const files = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 14);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extra = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const data = buf.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(zlib.crc32(raw), crc, `CRC of ${name}`);
    files[name] = raw.toString('utf8');
    p += 30 + nameLen + extra + size;
  }
  assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory follows the entries');
  return files;
}

const person = (n, extra = {}) => ({ id: `guid-${n}`, kind: 'user', username: `user${n}`, name: `Person ${n}`,
  email: `p${n}@example.invalid`, title: 'Engineer', department: 'Aero', enabled: true, ...extra });
// takenAt in local time with its offset, as Take-Snapshot.ps1 writes it
const snapshot = (date, groups, extra = {}) => ({ version: 1, date, takenAt: new Date(`${date}T00:10:05`).toISOString(), groups, ...extra });
const group = (name, members, extra = {}) => ({ name, found: true, error: null, members, ...extra });

test('the group list starts with the groups from the PowerShell script and is written for the script', () => {
  assert.deepEqual(snaps.monitoredGroups().map(g => g.name), DEFAULT_GROUPS);
  snaps.writeGroupsFile();
  assert.deepEqual(JSON.parse(fs.readFileSync(snaps.GROUPS_FILE, 'utf8')).groups, DEFAULT_GROUPS);
});

test('snapshots are kept for 3 years by default', () => {
  assert.equal(getSetting('retention_months'), '36');
});

test('group names are checked, trimmed and de-duplicated', () => {
  assert.deepEqual(snaps.cleanGroupNames([' A ', 'a', '', 'B&C']), ['A', 'B&C']);
  assert.throws(() => snaps.cleanGroupNames(['bad*name']), /not a valid group name/);
  assert.throws(() => snaps.cleanGroupNames(['']), /at least one/);
});

test("PowerShell's round-trip timestamps (7 decimal places, offset) are read correctly", () => {
  const s = snaps.normaliseSnapshot({ version: 1, date: '2026-11-25', takenAt: '2026-11-25T00:10:03.1234567+00:00', groups: [] });
  assert.equal(s.takenAt, '2026-11-25T00:10:03.123Z');
  assert.equal(s.status, 'failed');
});

test('bad snapshot files are rejected', () => {
  assert.throws(() => snaps.normaliseSnapshot({ version: 2 }), /unknown version/);
  assert.throws(() => snaps.normaliseSnapshot(snapshot('2026-02-30', [])), /bad date/);
  assert.throws(() => snaps.normaliseSnapshot(snapshot('2026-11-01', [group('G', [{ kind: 'user' }])])), /no id/);
  assert.throws(() => snaps.normaliseSnapshot(snapshot('2026-11-01', [group('G', [person(1, { kind: 'computer' })])])), /unknown member type/);
});

test('import: one snapshot per date; complete is never replaced, partial is replaced by a later complete one', () => {
  const partial = snapshot('2026-10-01', [group('G1', [person(1)]), group('G2', [], { found: false, error: 'Group not found in AD' })]);
  assert.deepEqual(snaps.importSnapshot(partial), { outcome: 'imported', date: '2026-10-01', status: 'partial' });
  const failedRetry = snapshot('2026-10-01', [group('G1', [], { error: 'Server down' }), group('G2', [], { error: 'Server down' })]);
  assert.equal(snaps.importSnapshot(failedRetry).outcome, 'kept-existing');
  const complete = snapshot('2026-10-01', [group('G1', [person(1), person(2)]), group('G2', [person(3)])]);
  assert.equal(snaps.importSnapshot(complete).outcome, 'replaced');
  assert.equal(snaps.importSnapshot({ ...complete, groups: [group('G1', [])] }).outcome, 'kept-existing');
  const s = snaps.snapshotByDate('2026-10-01');
  assert.equal(s.status, 'complete');
  assert.deepEqual(snaps.members(s.id).map(m => m.name), ['Person 1', 'Person 2', 'Person 3']);
});

test('import: a member listed twice counts once, and unchanged people are stored once across days', () => {
  snaps.importSnapshot(snapshot('2026-10-02', [group('G1', [person(1), person(1), person(2)]), group('G2', [person(3)])]));
  const s = snaps.snapshotByDate('2026-10-02');
  assert.equal(snaps.snapshotGroups(s.id).find(g => g.name === 'G1').count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 3);
});

test('late snapshots are flagged (after 01:00 local time)', () => {
  snaps.importSnapshot(snapshot('2026-10-03', [group('G1', [person(1)])], { takenAt: '2026-10-03T09:30:00+01:00' }));
  assert.equal(snaps.snapshotByDate('2026-10-03').late, 1);
  assert.equal(snaps.snapshotByDate('2026-10-02').late, 0);
});

test('compare matches people by AD object, so a new job title is not a joiner plus a leaver', () => {
  snaps.importSnapshot(snapshot('2026-10-04', [group('G1', [person(1, { title: 'Senior Engineer' }), person(4)]), group('G2', [])]));
  const [g1, g2] = snaps.compare(snaps.snapshotByDate('2026-10-02').id, snaps.snapshotByDate('2026-10-04').id);
  assert.equal(g1.name, 'G1');
  assert.deepEqual(g1.added.map(m => m.name), ['Person 4']);
  assert.deepEqual(g1.removed.map(m => m.name), ['Person 2']);
  assert.deepEqual(g2.removed.map(m => m.name), ['Person 3']);
});

test('members on a date fall back to the latest snapshot before it', () => {
  assert.equal(snaps.snapshotOnOrBefore('2026-10-10').date, '2026-10-04');
  assert.equal(snaps.snapshotOnOrBefore('2026-09-30'), null);
});

test('month end uses the 00:10 snapshot on the 1st of the next month, or says what it used instead', () => {
  snaps.importSnapshot(snapshot('2026-11-01', [group('G1', [person(1), person(4), person(5)]), group('G2', [person(3)])]));
  snaps.importSnapshot(snapshot('2026-11-20', [group('G1', [person(1)]), group('G2', [person(3)])]));

  const oct = snaps.monthEnd('2026-10', '2026-11-25');
  assert.equal(oct.basis, 'month-end');
  assert.equal(oct.snapshot.date, '2026-11-01');
  assert.equal(oct.previous.snapshot.date, '2026-10-01');   // September's month end is the snapshot of 1 October
  const g1 = oct.groups.find(g => g.name === 'G1');
  assert.equal(g1.count, 3);

  const nov = snaps.monthEnd('2026-11', '2026-11-25');
  assert.equal(nov.basis, 'month-to-date');
  assert.equal(nov.snapshot.date, '2026-11-20');
  assert.equal(nov.previous.snapshot.date, '2026-11-01');
  assert.deepEqual(nov.changes.find(c => c.name === 'G1').removed.map(m => m.name).sort(), ['Person 4', 'Person 5']);

  assert.equal(snaps.monthEnd('2026-11', '2026-12-05').basis, 'latest-in-month');
  assert.equal(snaps.monthEnd('2025-01', '2026-11-25'), null);
  assert.deepEqual(snaps.reportMonths(), ['2026-11', '2026-10', '2026-09']);   // 1 Oct is September's month end
});

test('dashboard shows counts, changes and missing days', () => {
  const d = snaps.dashboard({ today: '2026-11-21' });
  assert.equal(d.latest.date, '2026-11-20');
  const g1 = d.groups.find(g => g.name === 'G1');
  assert.equal(g1.count, 1);
  assert.equal(g1.sinceYesterday, null);            // no snapshot on the 19th
  assert.equal(g1.sinceMonthStart, -2);             // 3 on the 1st, 1 now
  assert.ok(d.missing.includes('2026-11-19'));
  assert.ok(!d.missing.includes('2026-11-20'));
  assert.equal(d.people, 2);
});

test('xlsx: valid package, safe sheet names, text never treated as a formula, bad XML characters dropped', () => {
  assert.deepEqual(sheetNames(['DL-M365-Planner&Project-P3', 'a/b', 'Summary', 'summary', 'x'.repeat(40)]),
    ['DL-M365-Planner&Project-P3', 'a-b', 'Summary', 'summary~2', 'x'.repeat(31)]);
  const buf = workbook([{ name: 'Planner&Project', title: 'T & <T>', notes: ['n'],
    columns: [{ header: 'Name', key: 'name' }, { header: 'Count', key: 'n' }],
    rows: [{ name: '=HYPERLINK("http://x")', n: 3 }, { name: 'bell\x07char', n: 0 }] }]);
  const files = unzip(buf);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files[part], `${part} present`);
  }
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;http:\/\/x&quot;\)<\/t>/);
  assert.doesNotMatch(sheet, /<f>/);
  assert.match(sheet, /bellchar/);
  assert.match(sheet, /<v>3<\/v>/);
  assert.match(sheet, /<autoFilter ref="A4:B6"\/>/);
  assert.match(files['xl/workbook.xml'], /name="Planner&amp;Project"/);
  assert.match(files['xl/workbook.xml'], /'Planner&amp;Project'!\$A\$4:\$B\$6/);
});

test('month-end workbook has a summary, all members, joiners and leavers, and a sheet per group', () => {
  const report = snaps.monthEnd('2026-11', '2026-11-25');
  const files = unzip(reports.monthEndWorkbook(report, 'Test User'));
  const wb = files['xl/workbook.xml'];
  const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(names, ['Summary', 'All groups', 'Joiners and leavers', 'G1', 'G2']);
  assert.match(files['xl/worksheets/sheet1.xml'], /Total \(licence assignments\)/);
  assert.match(files['xl/worksheets/sheet3.xml'], /Person 4/);
  // The agreed columns: name, email, job title, department and account status (plus the group where several are shown)
  const headers = [...files['xl/worksheets/sheet2.xml'].matchAll(/<c r="[A-Z]+4" s="1" t="inlineStr"><is><t xml:space="preserve">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(headers, ['Group', 'Directory group', 'Name', 'Email', 'Job title', 'Department', 'Account status']);
});

test('friendly names: shown first in reports, with the real group alongside; the sheet is named after the friendly name', () => {
  const g1 = db.prepare("SELECT id FROM ad_groups WHERE name = 'G1'").get().id;
  assert.throws(() => snaps.setGroupLabels([{ id: g1, label: 'Copilot' }]), /no longer in the list/);   // G1 isn't monitored
  db.prepare('UPDATE ad_groups SET monitored = 1 WHERE id = ?').run(g1);
  assert.deepEqual(snaps.setGroupLabels([{ id: g1, label: 'Copilot licences' }]), ['G1: "Copilot licences"']);
  assert.deepEqual(snaps.setGroupLabels([{ id: g1, label: 'Copilot licences' }]), []);   // unchanged
  const report = snaps.monthEnd('2026-11', '2026-11-25');
  const files = unzip(reports.monthEndWorkbook(report, 'Test'));
  const names = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
  assert.ok(names.includes('Copilot licences'));
  assert.ok(!names.includes('G1'));
  const summary = files['xl/worksheets/sheet1.xml'];
  assert.match(summary, />Copilot licences<\/t><\/is><\/c><c r="B\d+" t="inlineStr"><is><t xml:space="preserve">G1</);
  const all = files['xl/worksheets/sheet2.xml'];
  assert.match(all, />Copilot licences<\/t><\/is><\/c><c r="B\d+" t="inlineStr"><is><t xml:space="preserve">G1</);
  const sheetIndex = names.indexOf('Copilot licences') + 1;
  assert.match(files[`xl/worksheets/sheet${sheetIndex}.xml`], /Looks up the AD group G1\./);
  snaps.setGroupLabels([{ id: g1, label: '' }]);
  assert.equal(db.prepare('SELECT label FROM ad_groups WHERE id = ?').get(g1).label, null);
  db.prepare('UPDATE ad_groups SET monitored = 0 WHERE id = ?').run(g1);
});

test('account status says Disabled, or what a member is when they have no account here', () => {
  snaps.importSnapshot(snapshot('2026-11-21', [group('G1', [person(1, { enabled: false }), person(2),
    { id: 'c1', kind: 'contact', name: 'Agency', email: 'a@agency' }, { id: 'S-1-5-21-9', kind: 'external', name: 'PARTNER\\x' }])]));
  const s = snaps.snapshotByDate('2026-11-21');
  const files = unzip(reports.membersWorkbook({ snapshot: s, requestedDate: s.date, groupName: 'G1' }, 'Test'));
  const sheet = files['xl/worksheets/sheet1.xml'];
  for (const text of ['Disabled', 'Enabled', 'Contact (no account)', 'Account in another domain']) assert.ok(sheet.includes(`>${text}<`), text);
});

test('retention deletes old snapshots and people no longer in any snapshot', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n;
  setSetting('retention_months', '0');
  assert.equal(snaps.pruneByRetention(), 0);
  const removed = snaps.pruneByRetention(1);   // cut-off is the 1st of last month, relative to the real today
  const left = db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n;
  assert.equal(before - removed, left);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people WHERE id NOT IN (SELECT person_id FROM snapshot_members)').get().n, 0);
});

test('incoming files are imported and moved; unreadable ones go to rejected', () => {
  fs.writeFileSync(path.join(snaps.INCOMING, '2030-01-01_001000.json'), `﻿${JSON.stringify(snapshot('2030-01-01', [group('G1', [person(9)])]))}`);
  fs.writeFileSync(path.join(snaps.INCOMING, '2030-01-02_001000.json'), '{not json');
  fs.writeFileSync(path.join(snaps.INCOMING, '2030-01-03_001000.json.tmp'), '{}');
  const results = snaps.processIncoming();
  assert.deepEqual(results.map(r => r.outcome), ['imported', 'rejected']);
  assert.deepEqual(fs.readdirSync(snaps.INCOMING), ['2030-01-03_001000.json.tmp']);
  assert.ok(snaps.snapshotByDate('2030-01-01'));
});
