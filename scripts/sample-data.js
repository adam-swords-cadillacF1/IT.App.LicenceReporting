'use strict';
// Made-up snapshots for trying the app locally (no AD needed). Writes files in the same format as
// snapshot/Take-Snapshot.ps1 into DATA_DIR/snapshots/incoming, which the app then imports.
//
//   node scripts/sample-data.js            # the last 120 days up to today
//   node scripts/sample-data.js 400        # the last 400 days
//
// The people are fictional. Never run this against a production DATA_DIR.
const fs = require('node:fs');
const path = require('node:path');

const FIRST = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Jamie', 'Riley', 'Avery', 'Charlie', 'Robin', 'Drew',
  'Quinn', 'Rowan', 'Elliot', 'Harper', 'Kai', 'Sasha', 'Noor', 'Priya', 'Ola', 'Mateo', 'Yuki', 'Leila', 'Tomasz', 'Ines'];
const LAST = ['Smith', 'Jones', 'Patel', 'Garcia', 'Kowalski', 'Nguyen', 'Okafor', 'Müller', 'Rossi', 'Dubois', "O'Brien",
  'Silva', 'Khan', 'Andersson', 'Novak', 'Hughes', 'Clarke', 'Mensah', 'Tanaka', 'Fischer', 'Byrne', 'Evans'];
const DEPTS = {
  Aerodynamics: ['Aerodynamicist', 'CFD Engineer', 'Wind Tunnel Technician'],
  'Vehicle Performance': ['Performance Engineer', 'Simulation Engineer', 'Data Analyst'],
  Design: ['Design Engineer', 'Senior Designer', 'CAD Technician'],
  Manufacturing: ['Composite Technician', 'Machinist', 'Production Planner'],
  Finance: ['Financial Analyst', 'Accounts Assistant', 'Finance Manager'],
  IT: ['IT Support Analyst', 'Systems Engineer', 'IT Manager'],
  'People & Culture': ['HR Advisor', 'Recruiter', 'HR Business Partner'],
  Marketing: ['Content Producer', 'Partnerships Manager', 'Designer'],
};

// Small seeded random generator, so every run produces the same history
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function makePeople(rand, n) {
  const depts = Object.keys(DEPTS);
  return Array.from({ length: n }, (_, i) => {
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    const dept = depts[Math.floor(rand() * depts.length)];
    const titles = DEPTS[dept];
    const user = `${first}.${last}${i}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
    return {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      kind: 'user', username: user, name: `${first} ${last}`, email: `${user}@example.invalid`,
      title: titles[Math.floor(rand() * titles.length)], department: dept, enabled: true,
    };
  });
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Returns one snapshot object per day from start to end (inclusive). The state evolves day by day from
// a fixed seed, so a later call for a single day matches the history.
// groups: names (AD) or { name, source, entraId } as returned by monitoredGroups(); source 'cato' adds licence totals
function generate({ groups: groupList, endDate = ymd(new Date()), days = 120, startDate = '2026-01-01' } = {}) {
  const defs = groupList.map(g => (typeof g === 'string' ? { name: g, source: 'ad' } : g));
  const groups = defs.map(g => g.name);
  const rand = rng(42);
  const people = makePeople(rand, 420);
  // Each group gets a base share of people; E3/E5 are big, add-ons small
  const share = name => (/Cato/.test(name) ? 0.45 : /E3/.test(name) ? 0.55 : /E5-License/.test(name) ? 0.3 : /E5Monthly/.test(name) ? 0.05
    : /CoPilot|Acrobat/.test(name) ? 0.2 : 0.06);
  const membership = new Map(groups.map(g => [g, new Set(people.filter(() => rand() < share(g)).map(p => p.id))]));
  const out = [];
  const end = new Date(`${endDate}T00:10:00`);
  const from = new Date(end); from.setDate(from.getDate() - days + 1);
  const first = new Date(Math.min(new Date(`${startDate}T00:10:00`), from));
  for (let d = new Date(first); d <= end; d.setDate(d.getDate() + 1)) {
    // Daily churn: a few joiners and leavers, the odd promotion, and an account disabled now and then
    for (const g of groups) {
      const set = membership.get(g);
      for (let k = 0; k < 2; k++) {
        if (rand() < 0.35) set.add(people[Math.floor(rand() * people.length)].id);
        if (rand() < 0.3 && set.size) set.delete([...set][Math.floor(rand() * set.size)]);
      }
    }
    if (rand() < 0.15) { const p = people[Math.floor(rand() * people.length)]; p.title = `Senior ${p.title.replace(/^Senior /, '')}`; }
    if (rand() < 0.08) people[Math.floor(rand() * people.length)].enabled = false;
    if (d < from) continue;

    const date = ymd(d);
    const snap = {
      version: 1, date, takenAt: new Date(`${date}T00:10:${pad(Math.floor(rand() * 50))}`).toISOString(),
      computer: 'SAMPLE-DATA', runAs: 'sample-data.js',
      groups: defs.map(({ name, source, entraId }) => ({
        name, found: true, error: null, ...(source === 'entra' ? { source, entraId } : {}),
        // Cato reports how many ZTNA licences were bought and allocated; allocated runs a little ahead of eligible users
        ...(source === 'cato' ? { source, licences: { total: 250, used: Math.min(250, membership.get(name).size + 3) } } : {}),
        members: [...membership.get(name)].map(id => ({ ...people.find(p => p.id === id) })),
      })),
    };
    // A member from another domain and a mail contact, so those rows show up in the reports
    snap.groups[0]?.members.push({ id: 'S-1-5-21-1111111111-2222222222-3333333333-1105', kind: 'external',
      username: 'PARTNER\\j.doe', name: 'PARTNER\\j.doe', email: '', title: '', department: '', enabled: null });
    snap.groups[1]?.members.push({ id: '00000000-0000-4000-9000-000000000001', kind: 'contact', username: '',
      name: 'Agency Designer (contact)', email: 'designer@agency.example.invalid', title: 'Contractor', department: 'Marketing', enabled: null });
    out.push(snap);
  }
  return out;
}

function writeSnapshot(dir, snap) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${snap.date}_${snap.takenAt.slice(11, 19).replace(/:/g, '')}_sample.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

module.exports = { generate, writeSnapshot };

if (require.main === module) {
  if (process.env.APP_CONFIG) process.loadEnvFile(process.env.APP_CONFIG);
  process.env.TZ = process.env.APP_TZ || 'Europe/London';
  const { DATA_DIR } = require('../lib/db');
  const { monitoredGroups, INCOMING } = require('../lib/snapshots');
  if (fs.existsSync(path.join(DATA_DIR, 'PRODUCTION'))) { console.error('Refusing: this DATA_DIR is marked PRODUCTION.'); process.exit(1); }
  const days = Number(process.argv[2]) || 120;
  const snaps = generate({ groups: monitoredGroups(), days });
  for (const s of snaps) writeSnapshot(INCOMING, s);
  console.log(`Wrote ${snaps.length} sample snapshots to ${INCOMING}. Start (or wait for) the app to import them.`);
}
