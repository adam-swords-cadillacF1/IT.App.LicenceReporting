'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'licences.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// One snapshot per day. A person's details are stored once per distinct set of values (people), and each
// day's membership is a list of (group, person) pairs, so a year of daily snapshots stays small.
db.exec(`
CREATE TABLE IF NOT EXISTS ad_groups (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  monitored INTEGER NOT NULL DEFAULT 0,      -- 1 = in the list the daily snapshot reads
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY,
  date         TEXT NOT NULL UNIQUE,          -- local date the snapshot is for, YYYY-MM-DD
  taken_at     TEXT NOT NULL,                 -- when the script ran (ISO, with offset)
  imported_at  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('complete','partial','failed')),
  late         INTEGER NOT NULL DEFAULT 0,    -- taken after 01:00 instead of at 00:10
  requested_by TEXT,                          -- set when an admin asked for it from the app
  computer     TEXT,
  run_as       TEXT
);

CREATE TABLE IF NOT EXISTS snapshot_groups (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  group_id     INTEGER NOT NULL REFERENCES ad_groups(id),
  found        INTEGER NOT NULL,
  error        TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, group_id)
) WITHOUT ROWID;

-- Empty strings rather than NULLs, so the UNIQUE constraint really dedupes
CREATE TABLE IF NOT EXISTS people (
  id         INTEGER PRIMARY KEY,
  object_id  TEXT NOT NULL,                   -- objectGUID, or the SID for members from another domain
  kind       TEXT NOT NULL,                   -- user, contact or external
  username   TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  enabled    INTEGER,                         -- NULL when not known (contacts, external members)
  UNIQUE (object_id, kind, username, name, email, title, department, enabled)
);

CREATE TABLE IF NOT EXISTS snapshot_members (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  group_id    INTEGER NOT NULL,
  person_id   INTEGER NOT NULL REFERENCES people(id),
  PRIMARY KEY (snapshot_id, group_id, person_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS snapshot_members_person ON snapshot_members(person_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  who    TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

// Entra (cloud) groups sit in the same table: source 'entra', identified by their object ID, named by their
// display name (kept up to date by each snapshot). Added after the first release, so older databases are migrated.
const groupCols = db.prepare('PRAGMA table_info(ad_groups)').all().map(c => c.name);
if (!groupCols.includes('source')) {
  db.exec(`ALTER TABLE ad_groups ADD COLUMN source TEXT NOT NULL DEFAULT 'ad';
           ALTER TABLE ad_groups ADD COLUMN entra_id TEXT;
           CREATE UNIQUE INDEX IF NOT EXISTS ad_groups_entra_id ON ad_groups(entra_id) WHERE entra_id IS NOT NULL;`);
}

// A friendly name per group, shown alongside the real group name in screens and reports (display only)
if (!db.prepare('PRAGMA table_info(ad_groups)').all().some(c => c.name === 'label')) {
  db.exec('ALTER TABLE ad_groups ADD COLUMN label TEXT');
}

// Licence totals a vendor reports for a group (Cato ZTNA: licences purchased and allocated), kept per snapshot.
// NULL for groups with no such figures (AD and Entra groups).
const snapGroupCols = db.prepare('PRAGMA table_info(snapshot_groups)').all().map(c => c.name);
if (!snapGroupCols.includes('licence_total')) {
  db.exec(`ALTER TABLE snapshot_groups ADD COLUMN licence_total INTEGER;
           ALTER TABLE snapshot_groups ADD COLUMN licence_used INTEGER;`);
}

// The groups from "1 Month End report for licesening.ps1", used to start the list on an empty database
const DEFAULT_GROUPS = [
  'DL-APP-CreateCloudPro',
  'DL-APP-AcrobatPro',
  'DL-APP-Illustrator',
  'DL-M365-CoPilot',
  'DL-M365-E5-License',
  'DL-M365-Planner&Project-P3',
  'DL-M365-Planner-P1',
  'DL-M365-Planner&Project-P5',
  'DL-M365-PowerBIAddOn',
  'DL-M365-PowerBIPremium',
  'DL-M365-Visio',
  'DL-M365-E5Monthly-License',
  'DL-M365-E3-License',
];

const nowIso = () => new Date().toISOString();
// Snapshots hold names and email addresses, so they are kept for 3 years unless Admin › Settings says otherwise
const DEFAULT_RETENTION_MONTHS = 36;

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function logActivity(who, action, detail = null) {
  db.prepare('INSERT INTO activity (at, who, action, detail) VALUES (?, ?, ?, ?)').run(nowIso(), who, action, detail);
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

if (!getSetting('groups_seeded')) {
  transaction(() => {
    const insert = db.prepare(`INSERT INTO ad_groups (name, monitored, position) VALUES (?, 1, ?)
                               ON CONFLICT(name) DO UPDATE SET monitored = 1, position = excluded.position`);
    DEFAULT_GROUPS.forEach((name, i) => insert.run(name, i));
    setSetting('groups_seeded', '1');
  });
}

if (getSetting('retention_months') === null) setSetting('retention_months', DEFAULT_RETENTION_MONTHS);

module.exports = { db, DATA_DIR, nowIso, getSetting, setSetting, logActivity, transaction, DEFAULT_GROUPS, DEFAULT_RETENTION_MONTHS };
