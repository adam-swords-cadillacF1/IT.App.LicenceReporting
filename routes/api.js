'use strict';
const express = require('express');
const snaps = require('../lib/snapshots');
const reports = require('../lib/reports');
const { takeSnapshotNow } = require('../lib/trigger');
const { db, getSetting, setSetting, logActivity, DEFAULT_RETENTION_MONTHS } = require('../lib/db');

const router = express.Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const who = req => req.user.email || req.user.name;

const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : next(fail(403, 'Only IT admins can do that')));

function dateParam(value, name) {
  if (value === undefined || value === '') return null;
  if (!snaps.isRealDate(String(value))) throw fail(400, `${name} must be a date (YYYY-MM-DD)`);
  return String(value);
}
function groupParam(value) {
  if (value === undefined || value === '') return null;
  const name = String(value);
  if (!db.prepare('SELECT 1 FROM ad_groups WHERE name = ?').get(name)) throw fail(404, `No group called ${name}`);
  return name;
}

// The snapshot in force on a date (that day's, or the latest before it); the latest one if no date is given
function resolveSnapshot(date) {
  const snapshot = date ? snaps.snapshotOnOrBefore(date) : snaps.latestSnapshot();
  if (!snapshot) throw fail(404, date ? `There is no snapshot on or before ${date}` : 'There are no snapshots yet');
  return { ...snapshot, late: Boolean(snapshot.late) };
}

function sendXlsx(res, buffer, filename) {
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\w .-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': buffer.length,
  });
  res.end(buffer);
}

// ── Everyone signed in (Viewer and Admin) ────────────────────────────────────

router.get('/me', (req, res) => res.json({ ...req.user, appEnv: req.app.locals.appEnv, authMode: req.app.locals.authMode }));

router.get('/meta', (req, res) => {
  const dates = snaps.snapshotDates();
  res.json({
    today: snaps.localYmd(),
    first: dates[0]?.date || null,
    last: dates.at(-1)?.date || null,
    dates: dates.map(d => d.date),
    months: snaps.reportMonths(),
    groups: snaps.monitoredGroups().map(g => ({ name: g.name, label: g.label, source: g.source })),
    // The Cato page is offered once Cato has been switched on (its history stays after it's switched off)
    cato: (g => (g ? { name: g.name, label: g.label, monitored: Boolean(g.monitored) } : null))(snaps.catoGroup()),
  });
});

router.get('/dashboard', (req, res) => res.json(snaps.dashboard()));

router.get('/members', (req, res) => {
  const requestedDate = dateParam(req.query.date, 'date');
  const groupName = groupParam(req.query.group);
  const snapshot = resolveSnapshot(requestedDate);
  res.json({
    requestedDate: requestedDate || snapshot.date,
    snapshot,
    groups: snaps.snapshotGroups(snapshot.id).filter(g => !groupName || g.name === groupName),
    rows: snaps.members(snapshot.id, groupName),
  });
});

router.get('/members.xlsx', (req, res) => {
  const requestedDate = dateParam(req.query.date, 'date');
  const groupName = groupParam(req.query.group);
  const snapshot = resolveSnapshot(requestedDate);
  const date = requestedDate || snapshot.date;
  const buffer = reports.membersWorkbook({ snapshot, requestedDate: date, groupName }, req.user.name);
  logActivity(who(req), 'Downloaded members report', `${date}${groupName ? `, ${groupName}` : ', all groups'}`);
  sendXlsx(res, buffer, `Licence groups ${groupName ? `${groupName} ` : ''}${date}.xlsx`);
});

function comparison(req) {
  const fromDate = dateParam(req.query.from, 'from');
  if (!fromDate) throw fail(400, 'Choose a From date');
  const from = resolveSnapshot(fromDate);
  const to = resolveSnapshot(dateParam(req.query.to, 'to'));
  if (from.date >= to.date) throw fail(400, from.id === to.id ? 'Both dates fall on the same snapshot' : 'From must be before To');
  const groupName = groupParam(req.query.group);
  return { from, to, groupName, result: snaps.compare(from.id, to.id, groupName) };
}

router.get('/compare', (req, res) => {
  const { from, to, result } = comparison(req);
  res.json({ from, to, groups: result });
});

router.get('/compare.xlsx', (req, res) => {
  const c = comparison(req);
  logActivity(who(req), 'Downloaded comparison report', `${c.from.date} to ${c.to.date}${c.groupName ? `, ${c.groupName}` : ''}`);
  sendXlsx(res, reports.compareWorkbook(c, req.user.name), `Licence group changes ${c.from.date} to ${c.to.date}.xlsx`);
});

function monthEndReport(req) {
  const month = String(req.query.month || '');
  const report = snaps.monthEnd(month);
  if (!report) throw fail(404, `There are no snapshots for ${month}`);
  return report;
}

router.get('/month-end', (req, res) => {
  const r = monthEndReport(req);
  res.json({
    month: r.month, basis: r.basis, snapshot: { ...r.snapshot, late: Boolean(r.snapshot.late) },
    previous: r.previous ? { date: r.previous.snapshot.date, basis: r.previous.basis } : null,
    groups: r.groups, warnings: r.warnings,
  });
});

router.get('/month-end.xlsx', (req, res) => {
  const r = monthEndReport(req);
  logActivity(who(req), 'Downloaded month-end report', `${r.month} (snapshot ${r.snapshot.date}, ${r.basis})`);
  sendXlsx(res, reports.monthEndWorkbook(r, req.user.name),
    `Licence month end ${reports.monthName(r.month)}${r.basis === 'month-to-date' ? ' (to date)' : ''}.xlsx`);
});

// ── Cato ZTNA users ──

function catoReport(req, { needMonth = false } = {}) {
  const report = snaps.catoReport(req.query.month ? String(req.query.month) : null);
  if (!report) throw fail(404, 'Cato isn\'t switched on. An admin can switch it on under Admin › Groups.');
  if (needMonth && !report.selected) throw fail(404, 'There are no snapshots with Cato in them yet');
  return report;
}

router.get('/cato', (req, res) => res.json(catoReport(req)));

router.get('/cato/users.csv', (req, res) => {
  const r = catoReport(req, { needMonth: true });
  const buffer = reports.catoUsersCsv(r);
  logActivity(who(req), 'Downloaded Cato users (CSV)', `${r.selected.month} (snapshot ${r.selected.date})`);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="Cato ZTNA users ${r.selected.date}.csv"`,
    'Content-Length': buffer.length,
  });
  res.end(buffer);
});

router.get('/cato.xlsx', (req, res) => {
  const r = catoReport(req, { needMonth: true });
  logActivity(who(req), 'Downloaded Cato users report', `${r.selected.month} (snapshot ${r.selected.date})`);
  sendXlsx(res, reports.catoWorkbook(r, req.user.name), `Cato ZTNA users ${reports.monthName(r.selected.month)}.xlsx`);
});

// ── Admin (IT) ───────────────────────────────────────────────────────────────

router.get('/admin/groups', adminOnly, (req, res) => res.json(snaps.monitoredGroups('ad').map(g => g.name)));

router.put('/admin/groups', adminOnly, (req, res) => {
  const before = snaps.monitoredGroups('ad').map(g => g.name);
  const after = snaps.setMonitoredGroups(req.body?.groups);
  const added = after.filter(n => !before.some(b => b.toLowerCase() === n.toLowerCase()));
  const removed = before.filter(n => !after.some(a => a.toLowerCase() === n.toLowerCase()));
  if (added.length || removed.length) {
    logActivity(who(req), 'Changed the group list',
      [added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean).join('; '));
  }
  res.json(after);
});

// ── Friendly names ──

router.get('/admin/group-labels', adminOnly, (req, res) => {
  res.json(snaps.monitoredGroups().map(g => ({ id: g.id, name: g.name, source: g.source, label: g.label })));
});

router.put('/admin/group-labels', adminOnly, (req, res) => {
  const changed = snaps.setGroupLabels(req.body?.labels);
  if (changed.length) logActivity(who(req), 'Changed friendly names', changed.join('; '));
  res.json(snaps.monitoredGroups().map(g => ({ id: g.id, name: g.name, source: g.source, label: g.label })));
});

// ── Entra (cloud) groups ──

router.get('/admin/entra-groups', adminOnly, (req, res) => {
  res.json({ groups: snaps.monitoredGroups('entra').map(g => ({ id: g.entraId, name: g.name })),
    live: require('../lib/entra').configured });
});

// Each line is an object ID (anywhere in the line, so "Name (id)" as shown in Admin works) or an exact
// display name. Every line is looked up in Entra first; if any can't be found, nothing is saved.
async function resolveEntraLines(lines) {
  const entra = require('../lib/entra');
  const graph = entra.configured ? require('../lib/graph').client() : null;
  const found = [];
  const problems = [];
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    const id = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    const query = id || line;
    try {
      if (graph) {
        const g = await graph.findGroup(query);
        found.push({ id: g.id.toLowerCase(), name: g.displayName, synced: Boolean(g.onPremisesSyncEnabled) });
      } else {
        // No Entra connection (development): accept the line as it is, with a stable made-up ID
        const fake = id || require('node:crypto').createHash('sha256').update(line).digest('hex')
          .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
        found.push({ id: fake.toLowerCase(), name: id ? `Entra group ${id.slice(0, 8)}` : line, synced: false });
      }
    } catch (err) {
      problems.push(`${line.slice(0, 100)}: ${err.message}`);
    }
  }
  if (problems.length) throw fail(400, problems.join('\n'));
  return found.filter((g, i) => found.findIndex(x => x.id === g.id) === i);
}

router.put('/admin/entra-groups', adminOnly, async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.lines)) throw fail(400, 'Send the list of groups');
    const before = snaps.monitoredGroups('entra').map(g => g.name);
    const found = await resolveEntraLines(req.body.lines);
    const synced = found.filter(g => g.synced).map(g => g.name);
    const saved = snaps.setMonitoredEntraGroups(found).map(g => ({ id: g.entraId, name: g.name }));
    const after = saved.map(g => g.name);
    const added = after.filter(n => !before.includes(n));
    const removed = before.filter(n => !after.includes(n));
    if (added.length || removed.length) {
      logActivity(who(req), 'Changed the Entra group list',
        [added.length && `added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean).join('; '));
    }
    res.json({ groups: saved,
      warning: synced.length ? `Synced from AD: ${synced.join(', ')}. These are usually better in the AD list, which also sees nested AD groups.` : null });
  } catch (err) { next(err); }
});

// ── Cato ZTNA licence holders ──

// Never includes the API key: only whether one is saved, and where the settings come from
function catoStatus() {
  const cato = require('../lib/cato');
  const saved = require('../lib/cato-settings').stored();
  const group = snaps.catoGroup();
  const s = cato.settings(process.env, saved);
  return { configured: Boolean(s.apiKey && s.accountId), enabled: Boolean(group?.monitored), name: group?.name || snaps.CATO_GROUP_NAME,
    label: group?.label || null, accountId: s.accountId || null, apiUrl: s.url, source: s.source,
    keySaved: saved.keySaved, keyError: s.keyError, updatedBy: saved.updatedBy || null, updatedAt: saved.updatedAt || null };
}

router.get('/admin/cato', adminOnly, (req, res) => res.json(catoStatus()));

router.put('/admin/cato', adminOnly, (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw fail(400, 'Send enabled: true or false');
  const before = catoStatus().enabled;
  snaps.setCatoMonitored(req.body.enabled);
  if (before !== req.body.enabled) logActivity(who(req), req.body.enabled ? 'Switched Cato licences on' : 'Switched Cato licences off');
  res.json(catoStatus());
});

// The account ID and API key, from Admin › Settings. A blank apiKey keeps the saved key.
router.put('/admin/cato-settings', adminOnly, (req, res) => {
  const changes = require('../lib/cato-settings').save(req.body, who(req));
  if (changes.length) logActivity(who(req), 'Changed the Cato API settings', changes.join('; '));
  res.json(catoStatus());
});

router.delete('/admin/cato-settings', adminOnly, (req, res) => {
  if (require('../lib/cato-settings').clear()) logActivity(who(req), 'Removed the Cato API settings');
  res.json(catoStatus());
});

// Reads Cato now, without saving anything, so IT can check the key and account before the next snapshot.
// Answers with counts only (no names), and the licence totals.
router.post('/admin/cato/test', adminOnly, async (req, res, next) => {
  try {
    const cato = require('../lib/cato');
    if (!cato.isConfigured()) throw fail(400, cato.NOT_CONFIGURED);
    const client = cato.client();
    const users = await client.allUsers();
    const licensed = users.filter(u => u?.hasRemoteAccessEligibility === true);
    let licences = null;
    let licenceError = null;
    try { licences = await client.ztnaLicences(); } catch (err) { licenceError = err.message; }
    logActivity(who(req), 'Tested the Cato connection', `${licensed.length} licensed of ${users.length} users`);
    res.json({
      users: users.length,
      licensed: licensed.length,
      disabledLicensed: licensed.filter(u => u.userStatus !== 'ACTIVE').length,
      withEntraId: licensed.filter(u => u.objectId).length,
      licences, licenceError,
    });
  } catch (err) {
    // Shown to the admin as it is (a 5xx would be replaced by a generic message); Cato errors never hold the key
    next(err.status ? err : fail(424, err.message));
  }
});

router.get('/admin/snapshots', adminOnly, (req, res) => res.json(snaps.snapshotList()));

router.post('/admin/snapshot-now', adminOnly, async (req, res, next) => {
  try {
    const today = snaps.snapshotByDate(snaps.localYmd());
    if (today?.status === 'complete') {
      throw fail(409, "Today's snapshot is already complete. The next one is taken at 00:10 tomorrow.");
    }
    const result = await takeSnapshotNow(who(req));
    logActivity(who(req), 'Took a snapshot now', result.mode === 'task' ? `started task "${result.task}"` : 'sample data (not on the server)');
    res.status(202).json(result);
  } catch (err) { next(err); }
});

router.get('/admin/settings', adminOnly, (req, res) => {
  res.json({ retentionMonths: Number(getSetting('retention_months', DEFAULT_RETENTION_MONTHS)), defaultMonths: DEFAULT_RETENTION_MONTHS });
});

router.put('/admin/settings', adminOnly, (req, res) => {
  const months = Number(req.body?.retentionMonths);
  if (!Number.isInteger(months) || months < 0 || months > 240) throw fail(400, 'Retention must be 0 (keep everything) or 1-240 months');
  const before = Number(getSetting('retention_months', DEFAULT_RETENTION_MONTHS));
  // Shortening retention deletes history for good, so the change must be confirmed with the cut-off shown
  const cutoff = months ? snaps.firstOfMonth(snaps.addMonths(snaps.monthOf(snaps.localYmd()), -months)) : null;
  const wouldDelete = cutoff ? db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE date < ?').get(cutoff).n : 0;
  if (wouldDelete && req.body?.confirmDelete !== wouldDelete) {
    return res.status(409).json({ error: `This deletes ${wouldDelete} snapshot(s) taken before ${cutoff}. Confirm to go ahead.`,
      confirmDelete: wouldDelete, cutoff });
  }
  setSetting('retention_months', months);
  if (months !== before) logActivity(who(req), 'Changed retention', months ? `${months} months` : 'keep everything');
  const deleted = snaps.pruneByRetention(months);
  res.json({ retentionMonths: months, deleted });
});

router.get('/admin/activity', adminOnly, (req, res) => {
  res.json(db.prepare('SELECT at, who, action, detail FROM activity ORDER BY id DESC LIMIT 500').all());
});

module.exports = { router };
