'use strict';
// Excel workbooks for the three reports: month end, a point in time, and a comparison of two dates
const { workbook } = require('./xlsx');
const snaps = require('./snapshots');

const fmtDate = ymd => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const fmtDateTime = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const monthName = month => new Date(`${month}-15T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
// Contacts and members from another domain have no account here, so the status column says what they are
const status = m => (m.kind === 'contact' ? 'Contact (no account)' : m.kind === 'external' ? 'Account in another domain'
  : m.enabled === false ? 'Disabled' : 'Enabled');

const MEMBER_COLUMNS = [
  { header: 'Name', key: 'name', width: 28 },
  { header: 'Email', key: 'email', width: 36 },
  { header: 'Job title', key: 'title', width: 30 },
  { header: 'Department', key: 'department', width: 24 },
  { header: 'Account status', key: status, width: 24 },
];
const WITH_GROUP = [{ header: 'Group', key: 'group', width: 30 }, ...MEMBER_COLUMNS];

const snapshotNote = s => `Snapshot taken ${fmtDateTime(s.takenAt)}${s.late ? ' (late: after 01:00)' : ''}` +
  `${s.status !== 'complete' ? ` - ${s.status}, some groups could not be read` : ''}.`;
const generated = who => `Generated ${fmtDateTime(new Date().toISOString())} by ${who}.`;

function groupSheets(groups, rows) {
  return groups.map(g => ({
    name: g.name,
    title: g.name,
    notes: [g.problem ? `Problem: ${g.problem}` : `${g.count} member${g.count === 1 ? '' : 's'}`],
    columns: MEMBER_COLUMNS,
    rows: rows.filter(r => r.group === g.name),
  }));
}

function countSheet(groups, extraCols = []) {
  const total = groups.reduce((n, g) => n + (g.count || 0), 0);
  return {
    columns: [
      { header: 'Group', key: 'name', width: 32 },
      { header: 'Members', key: 'count', width: 11 },
      ...extraCols,
      { header: 'Disabled accounts', key: 'disabled', width: 18 },
      { header: 'Problem', key: 'problem', width: 40 },
    ],
    rows: [...groups, { name: 'Total (licence assignments)', count: total }],
  };
}

function monthEndWorkbook(report, who) {
  const s = report.snapshot;
  const rows = snaps.members(s.id);
  const basis = report.basis === 'month-end'
    ? `Month-end position: snapshot of ${fmtDate(s.date)}, showing membership at the end of ${fmtDate(snaps.addDays(s.date, -1))}.`
    : `Snapshot of ${fmtDate(s.date)}.`;
  const prev = report.previous
    ? `Joiners and leavers are compared with the snapshot of ${fmtDate(report.previous.snapshot.date)}.` : null;
  const changes = (report.changes || []).flatMap(c => [
    ...c.added.map(m => ({ ...m, change: 'Joined' })),
    ...c.removed.map(m => ({ ...m, change: 'Left' })),
  ]);
  const summary = countSheet(report.groups, [
    { header: 'Joined in month', key: 'added', width: 16 },
    { header: 'Left in month', key: 'removed', width: 14 },
  ]);
  const sheets = [
    { name: 'Summary', title: `Licence groups - month end ${monthName(report.month)}`,
      notes: [basis, snapshotNote(s), prev, ...report.warnings, generated(who)].filter(Boolean), ...summary },
    { name: 'All groups', title: `All members - ${monthName(report.month)}`, notes: [basis], columns: WITH_GROUP, rows },
  ];
  if (report.previous) {
    sheets.push({ name: 'Joiners and leavers', title: `Joiners and leavers - ${monthName(report.month)}`, notes: [prev],
      columns: [{ header: 'Group', key: 'group', width: 30 }, { header: 'Change', key: 'change', width: 10 }, ...MEMBER_COLUMNS],
      rows: changes });
  }
  return workbook([...sheets, ...groupSheets(report.groups, rows)]);
}

function membersWorkbook({ snapshot, requestedDate, groupName }, who) {
  const groups = snaps.snapshotGroups(snapshot.id).filter(g => !groupName || g.name === groupName);
  const rows = snaps.members(snapshot.id, groupName);
  const asAt = requestedDate === snapshot.date
    ? `Membership on ${fmtDate(snapshot.date)} (00:10 snapshot).`
    : `Membership on ${fmtDate(requestedDate)}: there is no snapshot for that day, so this is the latest one before it, ${fmtDate(snapshot.date)}.`;
  const notes = [asAt, snapshotNote(snapshot), generated(who)];
  if (groupName) {
    const g = groups[0];
    return workbook([{ name: groupName, title: groupName, columns: MEMBER_COLUMNS, rows,
      notes: [...notes, g?.problem ? `Problem: ${g.problem}` : `${rows.length} member${rows.length === 1 ? '' : 's'}`] }]);
  }
  return workbook([
    { name: 'Summary', title: `Licence groups on ${fmtDate(requestedDate)}`, notes, ...countSheet(groups) },
    { name: 'All groups', title: `All members on ${fmtDate(requestedDate)}`, notes: [asAt], columns: WITH_GROUP, rows },
    ...groupSheets(groups, rows),
  ]);
}

function compareWorkbook({ from, to, result }, who) {
  const notes = [`Changes between the snapshot of ${fmtDate(from.date)} and that of ${fmtDate(to.date)}.`, generated(who)];
  const changes = result.flatMap(c => [
    ...c.added.map(m => ({ ...m, change: 'Joined' })),
    ...c.removed.map(m => ({ ...m, change: 'Left' })),
  ]);
  return workbook([
    { name: 'Summary', title: `Licence group changes, ${fmtDate(from.date)} to ${fmtDate(to.date)}`, notes,
      columns: [
        { header: 'Group', key: 'name', width: 32 },
        { header: `Members ${from.date}`, key: 'before', width: 18 },
        { header: `Members ${to.date}`, key: 'after', width: 18 },
        { header: 'Joined', key: c => c.added.length, width: 10 },
        { header: 'Left', key: c => c.removed.length, width: 10 },
      ],
      rows: result },
    { name: 'Joiners and leavers', title: 'Joiners and leavers', notes: notes.slice(0, 1),
      columns: [{ header: 'Group', key: 'group', width: 30 }, { header: 'Change', key: 'change', width: 10 }, ...MEMBER_COLUMNS],
      rows: changes },
  ]);
}

module.exports = { monthEndWorkbook, membersWorkbook, compareWorkbook, monthName };
