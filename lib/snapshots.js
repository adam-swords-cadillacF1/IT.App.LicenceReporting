'use strict';
// Daily snapshots of the monitored AD groups.
//
// snapshot/Take-Snapshot.ps1 runs on the server at 00:10 (scheduled task), reads the group list from
// DATA_DIR/groups.json and writes one JSON file into DATA_DIR/snapshots/incoming. The app imports
// those files into the database (processIncoming) and answers every report from there.
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR, nowIso, transaction, logActivity, getSetting, DEFAULT_RETENTION_MONTHS } = require('./db');

const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const INCOMING = path.join(SNAP_DIR, 'incoming');
const PROCESSED = path.join(SNAP_DIR, 'processed');
const REJECTED = path.join(SNAP_DIR, 'rejected');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const REQUEST_FILE = path.join(SNAP_DIR, 'request.json');
for (const dir of [INCOMING, PROCESSED, REJECTED]) fs.mkdirSync(dir, { recursive: true });

const KEEP_PROCESSED_DAYS = 30;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const LATE_AFTER = '01:00:00';   // the task runs at 00:10; anything after 01:00 is flagged as late

// ── Dates (YYYY-MM-DD strings; local time zone is APP_TZ, set in server.js) ───

const pad = n => String(n).padStart(2, '0');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const localYmd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function isRealDate(ymd) {
  if (!DATE_RE.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const monthOf = ymd => ymd.slice(0, 7);
const firstOfMonth = month => `${month}-01`;
function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
}
const isLate = (date, takenAt) => new Date(takenAt) > new Date(`${date}T${LATE_AFTER}`);

// ── Monitored groups ──────────────────────────────────────────────────────────

// AD groups first, then Entra groups, each in the order IT listed them
function monitoredGroups(source = null) {
  return db.prepare(`SELECT id, name, label, source, entra_id AS entraId FROM ad_groups WHERE monitored = 1 AND (? IS NULL OR source = ?)
                     ORDER BY source = 'entra', position, name`).all(source, source);
}

// Written whenever the list changes, and at startup, for the snapshot script to read
function writeGroupsFile() {
  // Entra groups are read by snapshot/entra-groups.js, which Take-Snapshot.ps1 runs with this app's Node.js and
  // settings file (the certificate it signs in with is in there)
  const body = JSON.stringify({
    updatedAt: nowIso(),
    groups: monitoredGroups('ad').map(g => g.name),
    entraGroups: monitoredGroups('entra').map(g => ({ id: g.entraId, name: g.name })),
    node: process.execPath,
    config: process.env.APP_CONFIG || null,
  }, null, 2);
  const tmp = `${GROUPS_FILE}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, GROUPS_FILE);
}

// sAMAccountNames: up to 256 characters, none of the characters AD refuses, no wildcards
const BAD_GROUP_CHARS = /["/\\[\]:;|=,+*?<>\x00-\x1f]/;
function cleanGroupNames(names) {
  if (!Array.isArray(names)) throw Object.assign(new Error('Send a list of group names'), { status: 400 });
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    if (name.length > 256 || BAD_GROUP_CHARS.test(name)) {
      throw Object.assign(new Error(`"${name.slice(0, 80)}" is not a valid group name`), { status: 400 });
    }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (!out.length) throw Object.assign(new Error('Keep at least one group'), { status: 400 });
  if (out.length > 200) throw Object.assign(new Error('That is more than 200 groups'), { status: 400 });
  return out;
}

function setMonitoredGroups(names) {
  const clean = cleanGroupNames(names);
  const entra = clean.map(n => db.prepare("SELECT name FROM ad_groups WHERE name = ? AND source = 'entra'").get(n)).find(Boolean);
  if (entra) throw Object.assign(new Error(`"${entra.name}" is an Entra group. Keep it in the Entra list.`), { status: 400 });
  transaction(() => {
    db.prepare("UPDATE ad_groups SET monitored = 0 WHERE source = 'ad'").run();
    const upsert = db.prepare(`INSERT INTO ad_groups (name, monitored, position) VALUES (?, 1, ?)
      ON CONFLICT(name) DO UPDATE SET monitored = 1, position = excluded.position, name = excluded.name`);
    clean.forEach((name, i) => upsert.run(name, i));
  });
  writeGroupsFile();
  return clean;
}

// groups: [{ id, name }] already found in Entra (lib/graph.js findGroup). Kept by object ID, so a renamed group
// keeps its history. A name already used by an AD group is refused: that group is almost certainly synced from AD.
function setMonitoredEntraGroups(groups) {
  if (groups.length > 200) throw Object.assign(new Error('That is more than 200 groups'), { status: 400 });
  transaction(() => {
    db.prepare("UPDATE ad_groups SET monitored = 0 WHERE source = 'entra'").run();
    groups.forEach((g, i) => {
      const clash = db.prepare("SELECT name FROM ad_groups WHERE name = ? AND source = 'ad'").get(g.name);
      if (clash) {
        throw Object.assign(new Error(`"${g.name}" has the same name as an AD group, so it is probably synced from AD. Add it to the AD list instead.`), { status: 400 });
      }
      upsertEntraGroup(g.id, g.name, { monitored: 1, position: 1000 + i });
    });
  });
  writeGroupsFile();
  return monitoredGroups('entra');
}

// labels: [{ id, label }] for monitored groups; an empty label removes it. Friendly names must be different
// from each other, so two groups can't look the same in a report.
function setGroupLabels(labels) {
  if (!Array.isArray(labels)) throw Object.assign(new Error('Send a list of names'), { status: 400 });
  const clean = labels.map(l => ({ id: Number(l?.id), label: String(l?.label ?? '').replace(/[\x00-\x1f]/g, '').trim() || null }));
  // Compare against every other monitored group's name too, not just the ones being saved
  const seen = new Map(db.prepare('SELECT id, label FROM ad_groups WHERE monitored = 1 AND label IS NOT NULL').all()
    .filter(r => !clean.some(l => l.id === r.id)).map(r => [r.label.toLowerCase(), r.id]));
  for (const l of clean) {
    if (!db.prepare('SELECT 1 FROM ad_groups WHERE id = ? AND monitored = 1').get(l.id)) {
      throw Object.assign(new Error('One of the groups is no longer in the list. Reload the page.'), { status: 400 });
    }
    if (l.label && l.label.length > 80) throw Object.assign(new Error(`"${l.label.slice(0, 40)}…" is longer than 80 characters`), { status: 400 });
    if (l.label && seen.has(l.label.toLowerCase())) throw Object.assign(new Error(`Two groups are both called "${l.label}"`), { status: 400 });
    if (l.label) seen.set(l.label.toLowerCase(), l.id);
  }
  const changed = [];
  transaction(() => {
    for (const l of clean) {
      const row = db.prepare('SELECT name, label FROM ad_groups WHERE id = ?').get(l.id);
      if ((row.label || null) === l.label) continue;
      db.prepare('UPDATE ad_groups SET label = ? WHERE id = ?').run(l.label, l.id);
      changed.push(`${row.name}: ${l.label ? `"${l.label}"` : 'no friendly name'}`);
    }
  });
  return changed;
}

// Finds an Entra group by object ID (adding it if new) and keeps its name current. Returns its row id.
function upsertEntraGroup(entraId, name, { monitored = null, position = null } = {}) {
  const id = entraId.toLowerCase();
  const existing = db.prepare('SELECT id, name FROM ad_groups WHERE entra_id = ?').get(id);
  // Another (older, deleted) group may hold the name: give that one a distinguishing suffix
  const holder = db.prepare('SELECT id, source FROM ad_groups WHERE name = ? AND (entra_id IS NULL OR entra_id != ?)').get(name, id);
  let finalName = name;
  if (holder?.source === 'entra') {
    db.prepare('UPDATE ad_groups SET name = ? WHERE id = ?').run(`${name} (old ${holder.id})`, holder.id);
  } else if (holder) {
    finalName = `${name} (Entra)`;
  }
  if (existing) {
    db.prepare(`UPDATE ad_groups SET name = ?, monitored = COALESCE(?, monitored), position = COALESCE(?, position) WHERE id = ?`)
      .run(finalName, monitored, position, existing.id);
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO ad_groups (name, source, entra_id, monitored, position) VALUES (?, 'entra', ?, ?, ?)`)
    .run(finalName, id, monitored ?? 0, position ?? 1999).lastInsertRowid);
}

// ── Import ───────────────────────────────────────────────────────────────────

const KINDS = new Set(['user', 'contact', 'external']);
const str = (v, max = 512) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));

// Checks a snapshot file and returns it in the shape the database expects. Throws on anything unexpected.
function normaliseSnapshot(raw) {
  const bad = msg => { throw new Error(`Snapshot file rejected: ${msg}`); };
  if (!raw || typeof raw !== 'object') bad('not a JSON object');
  if (raw.version !== 1) bad(`unknown version ${raw.version}`);
  if (!isRealDate(raw.date)) bad(`bad date ${raw.date}`);
  if (Number.isNaN(Date.parse(raw.takenAt))) bad(`bad takenAt ${raw.takenAt}`);
  if (!Array.isArray(raw.groups) || raw.groups.length > 500) bad('groups must be a list');
  const groups = raw.groups.map(g => {
    if (!g || typeof g.name !== 'string' || !g.name.trim()) bad('a group has no name');
    const members = Array.isArray(g.members) ? g.members : [];
    if (members.length > 200000) bad(`${g.name} has too many members`);
    const source = g.source === 'entra' ? 'entra' : g.source === undefined || g.source === 'ad' ? 'ad' : bad(`unknown source ${g.source}`);
    if (source === 'entra' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.entraId || '')) bad(`${g.name} has no Entra object ID`);
    return {
      name: str(g.name, 256),
      source,
      entraId: source === 'entra' ? g.entraId.toLowerCase() : null,
      found: g.found === true,
      error: g.error ? str(g.error, 2000) : null,
      members: members.map(m => {
        if (!m || !str(m.id, 100)) bad(`a member of ${g.name} has no id`);
        const kind = KINDS.has(m.kind) ? m.kind : bad(`unknown member type ${m.kind}`);
        return {
          object_id: str(m.id, 100).toLowerCase(),
          kind,
          username: str(m.username, 256),
          name: str(m.name),
          email: str(m.email, 320),
          title: str(m.title),
          department: str(m.department),
          enabled: typeof m.enabled === 'boolean' ? (m.enabled ? 1 : 0) : null,
        };
      }),
    };
  });
  const ok = groups.filter(g => g.found && !g.error).length;
  const status = groups.length && ok === groups.length ? 'complete' : ok ? 'partial' : 'failed';
  return {
    date: raw.date,
    takenAt: new Date(raw.takenAt).toISOString(),
    requestedBy: raw.requestedBy ? str(raw.requestedBy, 200) : null,
    computer: str(raw.computer, 100) || null,
    runAs: str(raw.runAs, 200) || null,
    status,
    groups,
  };
}

const RANK = { failed: 0, partial: 1, complete: 2 };

// One snapshot per date. A complete snapshot is never replaced; a partial or failed one is replaced by a
// later attempt for the same date that did at least as well (e.g. the task's retry, or "Take snapshot now").
function importSnapshot(raw) {
  const snap = normaliseSnapshot(raw);
  return transaction(() => {
    const existing = db.prepare('SELECT id, status FROM snapshots WHERE date = ?').get(snap.date);
    if (existing && (existing.status === 'complete' || RANK[snap.status] < RANK[existing.status])) {
      return { outcome: 'kept-existing', date: snap.date, status: existing.status };
    }
    if (existing) db.prepare('DELETE FROM snapshots WHERE id = ?').run(existing.id);

    const snapshotId = Number(db.prepare(`INSERT INTO snapshots
      (date, taken_at, imported_at, status, late, requested_by, computer, run_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snap.date, snap.takenAt, nowIso(), snap.status, isLate(snap.date, snap.takenAt) ? 1 : 0,
        snap.requestedBy, snap.computer, snap.runAs).lastInsertRowid);

    const groupId = db.prepare("SELECT id FROM ad_groups WHERE name = ? AND source = 'ad'");
    const addGroup = db.prepare('INSERT INTO ad_groups (name, monitored, position) VALUES (?, 0, 999)');
    const addSnapGroup = db.prepare(`INSERT OR REPLACE INTO snapshot_groups (snapshot_id, group_id, found, error, member_count)
                                     VALUES (?, ?, ?, ?, ?)`);
    const findPerson = db.prepare(`SELECT id FROM people WHERE object_id = ? AND kind = ? AND username = ? AND name = ?
      AND email = ? AND title = ? AND department = ? AND enabled IS ?`);
    const addPerson = db.prepare(`INSERT INTO people (object_id, kind, username, name, email, title, department, enabled)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const addMember = db.prepare('INSERT OR IGNORE INTO snapshot_members (snapshot_id, group_id, person_id) VALUES (?, ?, ?)');

    for (const g of snap.groups) {
      const gid = g.source === 'entra'
        // A group that couldn't be read keeps the name it already has
        ? upsertEntraGroup(g.entraId, g.found ? g.name : (db.prepare('SELECT name FROM ad_groups WHERE entra_id = ?').get(g.entraId)?.name || g.name))
        : groupId.get(g.name)?.id ?? Number(addGroup.run(g.name).lastInsertRowid);
      const ids = new Set();
      for (const m of g.members) {
        if (ids.has(m.object_id)) continue;   // the same object listed twice counts once
        ids.add(m.object_id);
        const values = [m.object_id, m.kind, m.username, m.name, m.email, m.title, m.department, m.enabled];
        const pid = findPerson.get(...values)?.id ?? Number(addPerson.run(...values).lastInsertRowid);
        addMember.run(snapshotId, gid, pid);
      }
      addSnapGroup.run(snapshotId, gid, g.found ? 1 : 0, g.error, ids.size);
    }
    return { outcome: existing ? 'replaced' : 'imported', date: snap.date, status: snap.status };
  });
}

// Imports every finished file in the incoming folder (the script writes *.tmp and renames when done)
function processIncoming() {
  const results = [];
  const files = fs.readdirSync(INCOMING).filter(f => f.endsWith('.json')).sort();
  for (const file of files) {
    const full = path.join(INCOMING, file);
    let target = PROCESSED;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) throw new Error('Snapshot file rejected: larger than 200 MB');
      const raw = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^﻿/, ''));
      const result = importSnapshot(raw);
      results.push({ file, ...result });
      const failed = raw.groups?.filter(g => !g.found || g.error).map(g => g.name) || [];
      logActivity('Snapshot', `Snapshot ${result.outcome}`,
        `${result.date}: ${result.status}${failed.length ? ` (problems with ${failed.join(', ')})` : ''}`);
      console.log(`[snapshot] ${file}: ${result.outcome} (${result.date}, ${result.status})`);
    } catch (err) {
      target = REJECTED;
      results.push({ file, outcome: 'rejected', error: err.message });
      logActivity('Snapshot', 'Snapshot file rejected', `${file}: ${err.message}`);
      console.error(`[snapshot] ${file}: ${err.message}`);
    }
    try { fs.renameSync(full, path.join(target, file)); } catch (err) {
      console.error(`[snapshot] Could not move ${file} out of incoming: ${err.message}`);
    }
  }
  if (results.length) pruneByRetention();
  const cutoff = Date.now() - KEEP_PROCESSED_DAYS * 86400000;
  for (const dir of [PROCESSED, REJECTED]) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  }
  return results;
}

// Deletes daily snapshots older than the retention period (0 or unset = keep everything). Month-end
// snapshots (the 1st of each month) follow the same rule; there is no separate setting for them.
function pruneByRetention(months = Number(getSetting('retention_months', DEFAULT_RETENTION_MONTHS))) {
  if (!months || months < 1) return 0;
  const cutoff = firstOfMonth(addMonths(monthOf(localYmd()), -months));
  const removed = db.prepare('DELETE FROM snapshots WHERE date < ?').run(cutoff).changes;
  if (removed) {
    db.prepare('DELETE FROM people WHERE id NOT IN (SELECT DISTINCT person_id FROM snapshot_members)').run();
    logActivity('Snapshot', 'Old snapshots deleted', `${removed} snapshot(s) before ${cutoff} (retention ${months} months)`);
  }
  return removed;
}

// "Take snapshot now": the script reads this to record who asked
function writeRequest(who) {
  fs.writeFileSync(REQUEST_FILE, JSON.stringify({ requestedBy: who, at: nowIso() }));
}

// ── Queries ──────────────────────────────────────────────────────────────────

const SNAP_COLS = 'id, date, taken_at AS takenAt, status, late, requested_by AS requestedBy';
const snapshotByDate = date => db.prepare(`SELECT ${SNAP_COLS} FROM snapshots WHERE date = ?`).get(date) || null;
const latestSnapshot = () => db.prepare(`SELECT ${SNAP_COLS} FROM snapshots ORDER BY date DESC LIMIT 1`).get() || null;
// The snapshot that was current on a date: that day's, or the most recent one before it
const snapshotOnOrBefore = date =>
  db.prepare(`SELECT ${SNAP_COLS} FROM snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1`).get(date) || null;

function snapshotList(limit = 400) {
  const snaps = db.prepare(`SELECT ${SNAP_COLS}, imported_at AS importedAt, computer, run_as AS runAs
                            FROM snapshots ORDER BY date DESC LIMIT ?`).all(limit);
  const problems = db.prepare(`SELECT g.name, sg.found, sg.error FROM snapshot_groups sg JOIN ad_groups g ON g.id = sg.group_id
                               WHERE sg.snapshot_id = ? AND (sg.found = 0 OR sg.error IS NOT NULL) ORDER BY g.name`);
  const totals = db.prepare('SELECT COUNT(*) AS groups, SUM(member_count) AS members FROM snapshot_groups WHERE snapshot_id = ?');
  return snaps.map(s => ({ ...s, late: Boolean(s.late), ...totals.get(s.id),
    problems: problems.all(s.id).map(p => ({ name: p.name, error: p.error || 'Group not found in AD' })) }));
}

const snapshotDates = () => db.prepare('SELECT date, status FROM snapshots ORDER BY date').all();

// Groups in a snapshot, in the monitored order, with counts and any problem
function snapshotGroups(snapshotId) {
  return db.prepare(`
    SELECT g.name, g.label, g.source, sg.found, sg.error, sg.member_count AS count,
           (SELECT COUNT(*) FROM snapshot_members sm JOIN people p ON p.id = sm.person_id
             WHERE sm.snapshot_id = sg.snapshot_id AND sm.group_id = sg.group_id AND p.kind = 'user' AND p.enabled = 0) AS disabled
    FROM snapshot_groups sg JOIN ad_groups g ON g.id = sg.group_id
    WHERE sg.snapshot_id = ?
    ORDER BY g.monitored DESC, g.position, g.name`).all(snapshotId)
    .map(r => ({ ...r, found: Boolean(r.found), problem: !r.found ? (r.error || 'Group not found in AD') : r.error }));
}

function members(snapshotId, groupName = null) {
  return db.prepare(`
    SELECT g.name AS "group", g.label AS groupLabel, p.object_id AS objectId, p.kind, p.username, p.name, p.email, p.title, p.department, p.enabled
    FROM snapshot_members sm
    JOIN ad_groups g ON g.id = sm.group_id
    JOIN people p ON p.id = sm.person_id
    WHERE sm.snapshot_id = ? AND (? IS NULL OR g.name = ?)
    ORDER BY g.monitored DESC, g.position, g.name, p.name COLLATE NOCASE, p.email`)
    .all(snapshotId, groupName, groupName)
    .map(r => ({ ...r, enabled: r.enabled === null ? null : Boolean(r.enabled) }));
}

const groupMap = rows => {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.group)) map.set(r.group, new Map());
    map.get(r.group).set(r.objectId, r);
  }
  return map;
};

// Who joined and left each group between two snapshots, matched on the AD object (so a changed job title
// or email isn't counted as a leaver plus a joiner)
function compare(fromId, toId, groupName = null) {
  const before = groupMap(members(fromId, groupName));
  const after = groupMap(members(toId, groupName));
  const names = [...snapshotGroups(toId).map(g => g.name), ...snapshotGroups(fromId).map(g => g.name)]
    .filter((n, i, all) => all.indexOf(n) === i && (!groupName || n === groupName));
  const labels = new Map(db.prepare('SELECT name, label FROM ad_groups').all().map(r => [r.name, r.label]));
  return names.map(name => {
    const a = before.get(name) || new Map();
    const b = after.get(name) || new Map();
    return {
      name,
      label: labels.get(name) || null,
      before: a.size,
      after: b.size,
      added: [...b.values()].filter(m => !a.has(m.objectId)),
      removed: [...a.values()].filter(m => !b.has(m.objectId)),
    };
  });
}

// Months that have a month-end report: any month with a snapshot in it or on the 1st of the month after
function reportMonths() {
  const months = new Set();
  for (const { date } of snapshotDates()) {
    months.add(monthOf(date));
    if (date.endsWith('-01')) months.add(monthOf(addDays(date, -1)));
  }
  return [...months].sort().reverse();
}

// The snapshot that stands for the end of a month. The 00:10 snapshot on the 1st of the next month shows
// membership at the end of the last day, so that is the month-end snapshot. Before then (month still
// running) or if it is missing, the latest snapshot in the month is used and the basis says so.
function monthEndSnapshot(month, today = localYmd()) {
  const end = firstOfMonth(addMonths(month, 1));
  const exact = snapshotByDate(end);
  if (exact) return { snapshot: exact, basis: 'month-end' };
  const inMonth = db.prepare(`SELECT ${SNAP_COLS} FROM snapshots WHERE date >= ? AND date < ? ORDER BY date DESC LIMIT 1`)
    .get(firstOfMonth(month), end);
  if (!inMonth) return null;
  return { snapshot: inMonth, basis: today < end ? 'month-to-date' : 'latest-in-month' };
}

function monthEnd(month, today = localYmd()) {
  if (!MONTH_RE.test(month)) throw Object.assign(new Error('Month must be YYYY-MM'), { status: 400 });
  const current = monthEndSnapshot(month, today);
  if (!current) return null;
  const prev = monthEndSnapshot(addMonths(month, -1), today);
  const previous = prev && prev.snapshot.id !== current.snapshot.id ? prev : null;
  const changes = previous ? compare(previous.snapshot.id, current.snapshot.id) : null;
  const groups = snapshotGroups(current.snapshot.id).map(g => {
    const c = changes?.find(x => x.name === g.name);
    return { ...g, added: c ? c.added.length : null, removed: c ? c.removed.length : null };
  });
  const warnings = [];
  if (current.basis === 'month-to-date') warnings.push(`The month isn't over yet, so this uses the latest snapshot (${current.snapshot.date}).`);
  if (current.basis === 'latest-in-month') warnings.push(`There is no snapshot for ${firstOfMonth(addMonths(month, 1))}, so this uses the last one taken in the month (${current.snapshot.date}).`);
  if (current.snapshot.status !== 'complete') warnings.push(`The snapshot used is ${current.snapshot.status}: some groups could not be read. See the Problem column.`);
  if (!previous) warnings.push('There is no earlier month-end snapshot, so joiners and leavers for the month are not shown.');
  return { month, ...current, previous, groups, changes, warnings };
}

// Dashboard: the latest count per group, the change since the day before and since the start of the month,
// and a daily series for the sparklines
function dashboard({ days = 90, today = localYmd() } = {}) {
  const latest = latestSnapshot();
  const monitored = monitoredGroups();
  const recentFrom = addDays(today, -29);
  const allDates = snapshotDates();
  const firstDate = allDates[0]?.date;
  const have = new Set(allDates.map(d => d.date));
  // Today counts as missing only once the run (00:10) and its retries should have finished
  const todayDue = new Date() > new Date(`${today}T${LATE_AFTER}`);
  const missing = [];
  if (firstDate) {
    for (let d = firstDate > recentFrom ? firstDate : recentFrom; d <= today; d = addDays(d, 1)) {
      if (!have.has(d) && (d < today || todayDue)) missing.push(d);
    }
  }
  if (!latest) return { latest: null, groups: monitored.map(g => ({ name: g.name, count: null, series: [] })), missing, people: null };

  const yesterday = snapshotByDate(addDays(latest.date, -1));
  const monthStart = db.prepare(`SELECT ${SNAP_COLS} FROM snapshots WHERE date >= ? AND date <= ? ORDER BY date LIMIT 1`)
    .get(firstOfMonth(monthOf(latest.date)), latest.date);
  const countsFor = snap => new Map((snap ? snapshotGroups(snap.id) : []).map(g => [g.name, g]));
  const now = countsFor(latest);
  const prevDay = countsFor(yesterday);
  const startMonth = monthStart && monthStart.id !== latest.id ? countsFor(monthStart) : new Map();

  const seriesRows = db.prepare(`
    SELECT s.date, g.name, sg.member_count AS count, sg.found, sg.error
    FROM snapshot_groups sg JOIN snapshots s ON s.id = sg.snapshot_id JOIN ad_groups g ON g.id = sg.group_id
    WHERE s.date > ? ORDER BY s.date`).all(addDays(latest.date, -days));
  const series = new Map();
  for (const r of seriesRows) {
    if (!r.found || r.error) continue;   // a group that couldn't be read that day has no point, not a zero
    if (!series.has(r.name)) series.set(r.name, []);
    series.get(r.name).push({ date: r.date, count: r.count });
  }

  const names = [...monitored.map(g => g.name), ...[...now.keys()].filter(n => !monitored.some(g => g.name === n))];
  const groups = names.map(name => {
    const g = now.get(name);
    const ok = g && g.found && !g.error;
    const y = prevDay.get(name);
    const m = startMonth.get(name);
    const okCount = x => (x && x.found && !x.error ? x.count : null);
    return {
      name,
      monitored: monitored.some(x => x.name === name),
      label: monitored.find(x => x.name === name)?.label || g?.label || null,
      source: g?.source || monitored.find(x => x.name === name)?.source || 'ad',
      count: ok ? g.count : null,
      disabled: ok ? g.disabled : null,
      problem: g ? g.problem : 'Not in the latest snapshot (added since)',
      sinceYesterday: ok && okCount(y) !== null ? g.count - y.count : null,
      sinceMonthStart: ok && okCount(m) !== null ? g.count - m.count : null,
      series: series.get(name) || [],
    };
  });
  const people = db.prepare(`SELECT COUNT(DISTINCT p.object_id) AS n FROM snapshot_members sm JOIN people p ON p.id = sm.person_id
                             WHERE sm.snapshot_id = ?`).get(latest.id).n;
  return {
    latest: { ...latest, late: Boolean(latest.late) },
    yesterday: yesterday ? yesterday.date : null,
    monthStart: monthStart && monthStart.id !== latest.id ? monthStart.date : null,
    groups, missing, people,
  };
}

module.exports = {
  INCOMING, GROUPS_FILE, REQUEST_FILE,
  localYmd, addDays, addMonths, isRealDate, monthOf, firstOfMonth, DATE_RE, MONTH_RE,
  monitoredGroups, setMonitoredGroups, setMonitoredEntraGroups, upsertEntraGroup, setGroupLabels, writeGroupsFile, cleanGroupNames,
  normaliseSnapshot, importSnapshot, processIncoming, pruneByRetention, writeRequest,
  snapshotByDate, latestSnapshot, snapshotOnOrBefore, snapshotList, snapshotDates, snapshotGroups,
  members, compare, reportMonths, monthEndSnapshot, monthEnd, dashboard,
};
