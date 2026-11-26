'use strict';
// Excel workbooks for the three reports: month end, a point in time, and a comparison of two dates
const { workbook } = require('./xlsx');
const { toCsv } = require('./csv');
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
// The friendly name (Admin › Groups) where there is one, and always the real group it looks up
const display = g => g.label || g.name;
const sourceName = s => (s === 'entra' ? 'Entra ID' : s === 'cato' ? 'Cato' : 'AD');
// What each kind of group is, for the "Looks up ..." line on its sheet
const looksUp = g => (g.source === 'cato' ? 'Lists the Cato users eligible for licensed remote access (ZTNA)'
  : `Looks up the ${sourceName(g.source)} group ${g.name}`);
// Licence totals a vendor reports (Cato ZTNA), when the group has them
const licenceNote = g => (g.licenceTotal === null || g.licenceTotal === undefined ? null
  : `${g.licenceTotal} licence${g.licenceTotal === 1 ? '' : 's'} purchased${g.licenceUsed === null || g.licenceUsed === undefined ? ''
    : `, ${g.licenceUsed} allocated according to ${sourceName(g.source)}`}.`);
const GROUP_COLS = [
  { header: 'Group', key: m => m.groupLabel || m.group, width: 30 },
  { header: 'Directory group', key: 'group', width: 30 },
];
const WITH_GROUP = [...GROUP_COLS, ...MEMBER_COLUMNS];
const CHANGE_COLS = [...GROUP_COLS, { header: 'Change', key: 'change', width: 10 }, ...MEMBER_COLUMNS];

const snapshotNote = s => `Snapshot taken ${fmtDateTime(s.takenAt)}${s.late ? ' (late: after 01:00)' : ''}` +
  `${s.status !== 'complete' ? ` - ${s.status}, some groups could not be read` : ''}.`;
const generated = who => `Generated ${fmtDateTime(new Date().toISOString())} by ${who}.`;

function groupSheets(groups, rows) {
  return groups.map(g => ({
    name: display(g),
    title: display(g),
    notes: [`${looksUp(g)}.`,
      g.problem ? `Problem: ${g.problem}` : `${g.count} member${g.count === 1 ? '' : 's'}`, licenceNote(g)].filter(Boolean),
    columns: MEMBER_COLUMNS,
    rows: rows.filter(r => r.group === g.name),
  }));
}

function countSheet(groups, extraCols = []) {
  const total = groups.reduce((n, g) => n + (g.count || 0), 0);
  // Only shown when a group has licence totals from its vendor, so AD-only reports look as before
  const licenceCols = groups.some(g => g.licenceTotal !== null && g.licenceTotal !== undefined) ? [
    { header: 'Licences purchased', key: 'licenceTotal', width: 18 },
    { header: 'Licences allocated (vendor)', key: 'licenceUsed', width: 26 },
  ] : [];
  return {
    columns: [
      { header: 'Group', key: g => g.total || display(g), width: 32 },
      { header: 'Directory group', key: g => (g.total ? '' : g.name), width: 32 },
      { header: 'Source', key: g => (g.source ? sourceName(g.source) : ''), width: 10 },
      { header: 'Members', key: 'count', width: 11 },
      ...licenceCols,
      ...extraCols,
      { header: 'Disabled accounts', key: 'disabled', width: 18 },
      { header: 'Problem', key: 'problem', width: 40 },
    ],
    rows: [...groups, { total: 'Total (licence assignments)', count: total }],
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
      columns: CHANGE_COLS, rows: changes });
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
    return workbook([{ name: g ? display(g) : groupName, title: g ? display(g) : groupName, columns: MEMBER_COLUMNS, rows,
      notes: [...notes, g ? `${looksUp(g)}.` : `Looks up the group ${groupName}.`,
        g?.problem ? `Problem: ${g.problem}` : `${rows.length} member${rows.length === 1 ? '' : 's'}`, g ? licenceNote(g) : null].filter(Boolean) }]);
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
        { header: 'Group', key: display, width: 32 },
        { header: 'Directory group', key: 'name', width: 32 },
        { header: `Members ${from.date}`, key: 'before', width: 18 },
        { header: `Members ${to.date}`, key: 'after', width: 18 },
        { header: 'Joined', key: c => c.added.length, width: 10 },
        { header: 'Left', key: c => c.removed.length, width: 10 },
      ],
      rows: result },
    { name: 'Joiners and leavers', title: 'Joiners and leavers', notes: notes.slice(0, 1),
      columns: CHANGE_COLS, rows: changes },
  ]);
}

// ── Cato ZTNA users (lib/snapshots.js catoReport) ──

const basisText = row => (row.basis === 'month-end' ? `month end (snapshot of ${fmtDate(row.date)})`
  : row.basis === 'month-to-date' ? `to date (snapshot of ${fmtDate(row.date)})` : `last snapshot in the month (${fmtDate(row.date)})`);
const catoTitle = report => report.group.label || report.group.name;
const CATO_USER_COLUMNS = [
  { header: 'Name', key: 'name', width: 28 },
  { header: 'Email', key: 'email', width: 36 },
  { header: 'Username', key: 'username', width: 36 },
  { header: 'Job title', key: 'title', width: 30 },
  { header: 'Department', key: 'department', width: 24 },
  { header: 'Account status', key: status, width: 18 },
];

// The selected month's users as CSV, with the snapshot date on every row so the file stands on its own
function catoUsersCsv(report) {
  const sel = report.selected;
  return toCsv([...CATO_USER_COLUMNS, { header: 'Snapshot date', key: () => sel.date }], sel.rows);
}

// Month by month, the selected month's users, and its joiners and leavers
function catoWorkbook(report, who) {
  const sel = report.selected;
  const title = catoTitle(report);
  const months = {
    name: 'Month by month', title: `${title} - month by month`,
    notes: ['Users holding a Cato ZTNA (remote access) licence at each month end, with the change from the month before.',
      'Licence figures are as Cato reports them; allocated can differ a little from the number of users.', generated(who)],
    columns: [
      { header: 'Month', key: r => monthName(r.month), width: 16 },
      { header: 'Figures from', key: basisText, width: 40 },
      { header: 'Users', key: 'count', width: 10 },
      { header: 'Change', key: 'net', width: 10 },
      { header: 'Joined', key: 'added', width: 10 },
      { header: 'Left', key: 'removed', width: 10 },
      { header: 'Disabled or locked', key: 'disabled', width: 18 },
      { header: 'Licences purchased', key: 'licenceTotal', width: 18 },
      { header: 'Licences allocated (Cato)', key: 'licenceUsed', width: 24 },
      { header: 'Problem', key: 'problem', width: 40 },
    ],
    rows: report.months,
  };
  const users = {
    name: `Users ${sel.month}`, title: `${title} - ${monthName(sel.month)}`,
    notes: [`Users at the ${basisText(sel)}.`, `${sel.count ?? 0} user${sel.count === 1 ? '' : 's'}.`],
    columns: CATO_USER_COLUMNS, rows: sel.rows,
  };
  const changes = {
    name: 'Joiners and leavers', title: `Joiners and leavers - ${monthName(sel.month)}`,
    notes: [sel.previousDate ? `Compared with the snapshot of ${fmtDate(sel.previousDate)} (the month before).` : 'There is no earlier month to compare with.'],
    columns: [{ header: 'Change', key: 'change', width: 10 }, ...CATO_USER_COLUMNS],
    rows: [...sel.joined.map(m => ({ ...m, change: 'Joined' })), ...sel.left.map(m => ({ ...m, change: 'Left' }))],
  };
  return workbook([months, users, changes]);
}

module.exports = { monthEndWorkbook, membersWorkbook, compareWorkbook, catoUsersCsv, catoWorkbook, monthName };
