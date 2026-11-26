'use strict';

const state = { me: null, meta: null };
const view = document.getElementById('view');

// ── Utilities ────────────────────────────────────────────────────────────────

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(url, opts);
  if (res.status === 401) { location.href = '/login'; throw new Error('Your session has ended - please sign in again'); }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 8000 : 4000);
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = d => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtDayMonth = d => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const fmtDateTime = iso => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const monthName = m => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const num = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-GB'));
const signed = n => (n === null || n === undefined ? '—' : n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');
// Same wording as the Excel reports (lib/reports.js)
const statusText = m => (m.kind === 'contact' ? 'Contact (no account)' : m.kind === 'external' ? 'Account in another domain'
  : m.enabled === false ? 'Disabled' : 'Enabled');

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { page: path || 'dashboard', params: new URLSearchParams(query) };
}
function setQuery(page, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  const hash = `#/${page}${q ? `?${q}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
// Downloads go through a normal link so the browser handles the file; the server logs who downloaded what
function download(url) {
  const a = document.createElement('a');
  a.href = url;
  document.body.append(a);
  a.click();
  a.remove();
}

// A group as people know it: the friendly name, with the real AD/Entra group it looks up underneath
const groupCell = (name, label) => (label ? `${esc(label)}<div class="sub-name">${esc(name)}</div>` : esc(name));
const groupTitle = name => state.meta.groups.find(g => g.name === name)?.label || name;
const SOURCE_NAMES = { ad: 'AD', entra: 'Entra ID', cato: 'Cato' };
const entraBadge = g => (g.source === 'entra' ? ' <span class="badge">Entra</span>' : g.source === 'cato' ? ' <span class="badge">Cato</span>' : '');
// Licence totals a vendor reports for a group (Cato ZTNA): "412 of 500 allocated", or "500 purchased"
const hasLicences = g => g.licenceTotal !== null && g.licenceTotal !== undefined;
const licenceText = g => (!hasLicences(g) ? '—' : g.licenceUsed === null || g.licenceUsed === undefined
  ? `${num(g.licenceTotal)} purchased` : `${num(g.licenceUsed)} of ${num(g.licenceTotal)} allocated`);

const snapshotBadge = s => {
  if (!s) return '';
  if (s.status === 'complete' && !s.late) return '<span class="badge"><span class="dot" style="background:var(--good)"></span>Complete</span>';
  if (s.status === 'complete') return '<span class="badge warn"><span class="status-icon">!</span>Complete, taken late</span>';
  if (s.status === 'partial') return '<span class="badge warn"><span class="status-icon">!</span>Partial: some groups failed</span>';
  return '<span class="badge crit"><span class="status-icon">✕</span>Failed</span>';
};

const alertBox = (kind, html) => `<div class="alert ${kind}"><span class="icon">${kind === 'crit' ? '✕' : kind === 'warn' ? '!' : 'i'}</span><div>${html}</div></div>`;

// ── Sparkline (single series; hover shows date and count) ────────────────────

function sparkline(series) {
  if (series.length < 2) return '<p class="muted" style="font-size:12px;margin:6px 0 0">Trend appears after two snapshots.</p>';
  const counts = series.map(p => p.count);
  let lo = Math.min(...counts), hi = Math.max(...counts);
  if (hi === lo) { lo -= 1; hi += 1; }
  const W = 200, H = 40;
  const x = i => (i / (series.length - 1)) * W;
  const y = c => H - 2 - ((c - lo) / (hi - lo)) * (H - 4);
  const pts = series.map((p, i) => `${x(i).toFixed(2)},${y(p.count).toFixed(2)}`);
  const data = esc(JSON.stringify(series.map(p => [p.date, p.count])));
  return `<div class="spark-wrap" data-series="${data}" data-lo="${lo}" data-hi="${hi}">
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polygon class="area" points="0,${H} ${pts.join(' ')} ${W},${H}"></polygon>
      <polyline class="line" points="${pts.join(' ')}"></polyline>
    </svg></div>`;
}

function wireSparklines(root) {
  const tip = document.getElementById('tooltip');
  for (const wrap of root.querySelectorAll('.spark-wrap')) {
    const series = JSON.parse(wrap.dataset.series);
    const lo = Number(wrap.dataset.lo), hi = Number(wrap.dataset.hi);
    const cursor = Object.assign(document.createElement('div'), { className: 'cursor hidden' });
    const marker = Object.assign(document.createElement('div'), { className: 'marker hidden' });
    wrap.append(cursor, marker);
    const hide = () => { cursor.classList.add('hidden'); marker.classList.add('hidden'); tip.classList.add('hidden'); };
    wrap.addEventListener('mousemove', e => {
      const svg = wrap.querySelector('svg').getBoundingClientRect();
      const i = Math.max(0, Math.min(series.length - 1, Math.round(((e.clientX - svg.left) / svg.width) * (series.length - 1))));
      const [date, count] = series[i];
      const px = (i / (series.length - 1)) * svg.width;
      const py = 6 + (svg.height - 6) * (1 - (2 + ((count - lo) / (hi - lo)) * 36) / 40);
      cursor.style.left = `${px}px`;
      marker.style.left = `${px}px`;
      marker.style.top = `${py}px`;
      cursor.classList.remove('hidden');
      marker.classList.remove('hidden');
      tip.innerHTML = `${esc(fmtDate(date))}<br><strong>${num(count)}</strong> members`;
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tw - 8)}px`;
      tip.style.top = `${e.clientY - 48}px`;
    });
    wrap.addEventListener('mouseleave', hide);
  }
}

// ── Dashboard ────────────────────────────────────────────────────────────────

async function renderDashboard() {
  const d = await api('GET', '/api/dashboard');
  const isAdmin = state.me.role === 'admin';
  if (!d.latest) {
    view.innerHTML = `<div class="page-head"><div><h1>Dashboard</h1></div></div>
      ${alertBox('info', `No snapshots yet. The first one is taken at 00:10 tonight${isAdmin ? ', or take one now from <a href="#/admin?tab=snapshots">Admin</a>' : ''}.`)}`;
    return;
  }
  const L = d.latest;
  const alerts = [];
  if (L.date !== state.meta.today) {
    alerts.push(alertBox(d.missing.includes(state.meta.today) ? 'crit' : 'info',
      `The latest snapshot is from ${esc(fmtDate(L.date))}${d.missing.includes(state.meta.today) ? `. Today's 00:10 snapshot hasn't arrived${isAdmin ? ': check Admin › Snapshots' : '; IT have been told on the Admin page'}.` : '.'}`));
  }
  if (L.status !== 'complete') {
    alerts.push(alertBox('warn', 'Some groups could not be read in the latest snapshot. Their tiles show the problem instead of a count.'));
  }
  const otherMissing = d.missing.filter(m => m !== state.meta.today);
  if (otherMissing.length) {
    alerts.push(alertBox('warn', `No snapshot for ${otherMissing.length} day${otherMissing.length === 1 ? '' : 's'} in the last 30: ${otherMissing.map(m => esc(fmtDayMonth(m))).join(', ')}. Reports for those days use the snapshot before.`));
  }
  const monthLabel = d.monthStart ? fmtDayMonth(d.monthStart) : null;
  const total = d.groups.reduce((n, g) => n + (g.count || 0), 0);
  const licenceCol = d.groups.some(hasLicences);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Snapshot of ${esc(fmtDate(L.date))}, taken at ${esc(fmtTime(L.takenAt))} ${snapshotBadge(L)}</p></div>
      <div class="actions">
        <a class="btn" href="#/members">See members</a>
        <a class="btn primary" href="#/month-end">Month-end report</a>
      </div>
    </div>
    ${alerts.join('')}
    <div class="hero-row">
      <div class="tile"><div class="label">People in at least one group</div><div class="value">${num(d.people)}</div>
        <div class="sub">Each person counted once</div></div>
      <div class="tile"><div class="label">Licence assignments</div><div class="value">${num(total)}</div>
        <div class="sub">Members across all ${d.groups.length} groups</div></div>
      ${catoWidget(d.groups.find(g => g.source === 'cato'), monthLabel)}
    </div>
    <div class="group-tiles">
      ${d.groups.map(g => `
        <a class="tile group-tile" href="${groupHref(g)}" title="See the members of ${esc(g.label || g.name)}">
          <div class="label"><span>${esc(g.label || g.name)}${entraBadge(g)}${g.label ? `<div class="sub-name">${esc(g.name)}</div>` : ''}</span></div>
          ${g.count === null
            ? `<div class="problem"><span class="badge crit"><span class="status-icon">✕</span>Not read</span>${esc(g.problem || '')}</div>`
            : `<div class="value">${num(g.count)}</div>
               ${hasLicences(g) ? `<div class="sub">Licences: ${licenceText(g)}, as ${esc(SOURCE_NAMES[g.source] || g.source)} reports</div>` : ''}
               <div class="deltas">
                 <span>${signed(g.sinceYesterday)} since yesterday</span>
                 ${monthLabel ? `<span>${signed(g.sinceMonthStart)} since ${esc(monthLabel)}</span>` : ''}
               </div>
               ${sparkline(g.series)}`}
        </a>`).join('')}
    </div>
    <div class="card">
      <div class="card-head"><h2>All groups</h2><span class="muted">Same figures as the tiles</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Group</th><th class="num">Members</th><th class="num">Since yesterday</th>
          ${monthLabel ? `<th class="num">Since ${esc(monthLabel)}</th>` : ''}<th class="num">Disabled accounts</th>
          ${licenceCol ? '<th class="num" title="Allocated of purchased, as the vendor reports">Licences</th>' : ''}<th>Problem</th></tr></thead>
        <tbody>${d.groups.map(g => `
          <tr class="row-link" data-href="${esc(groupHref(g))}"><td>${groupCell(g.name, g.label)}${entraBadge(g)}</td><td class="num">${num(g.count)}</td>
            <td class="num">${signed(g.sinceYesterday)}</td>${monthLabel ? `<td class="num">${signed(g.sinceMonthStart)}</td>` : ''}
            <td class="num">${num(g.disabled)}</td>${licenceCol ? `<td class="num">${licenceText(g)}</td>` : ''}<td>${esc(g.problem || '')}</td></tr>`).join('')}
        </tbody>
      </table></div>
      <p class="count-note">Disabled accounts are members whose account is disabled but who are still in the group (or, for Cato, still licensed).</p>
    </div>`;
  wireSparklines(view);
  view.querySelectorAll('tr[data-href]').forEach(tr => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}

// The Cato group opens its own page (users and month-to-month change); other groups open Members on a date
const groupHref = g => (g.source === 'cato' ? '#/cato' : `#/members?group=${encodeURIComponent(g.name)}`);

// Dashboard widget: the number of Cato ZTNA users now, linking to the Cato page
function catoWidget(g, monthLabel) {
  if (!g) return '';
  const notes = g.count === null ? [g.problem || 'Not read in the latest snapshot']
    : [hasLicences(g) ? `Licences: ${licenceText(g)}` : null,
      monthLabel && g.sinceMonthStart !== null ? `${signed(g.sinceMonthStart)} since ${monthLabel}` : null].filter(Boolean);
  return `<a class="tile" href="#/cato" title="See the Cato ZTNA users and the change month to month">
    <div class="label">${esc(g.label || 'Cato ZTNA users')} <span class="badge">Cato</span></div>
    <div class="value">${g.count === null ? '—' : num(g.count)}</div>
    <div class="sub">${notes.map(esc).join(' · ') || 'Users holding a remote access licence'}</div></a>`;
}

// ── Cato ZTNA users ──────────────────────────────────────────────────────────

const catoBasis = m => (m.basis === 'month-end' ? `Month end: snapshot of ${fmtDate(m.date)}`
  : m.basis === 'month-to-date' ? `So far this month: snapshot of ${fmtDate(m.date)}` : `Last snapshot in the month: ${fmtDate(m.date)}`);
const changeCell = (n, sign) => (n === null ? '—' : n ? `${sign}${num(n)}` : '0');

async function renderCato(params) {
  let r;
  try {
    r = await api('GET', `/api/cato${params.get('month') ? `?month=${encodeURIComponent(params.get('month'))}` : ''}`);
  } catch (err) {
    view.innerHTML = `<div class="page-head"><div><h1>Cato ZTNA users</h1></div></div>${alertBox(err.status === 404 ? 'info' : 'crit', esc(err.message))}`;
    return;
  }
  const title = r.group.label || r.group.name;
  const head = `<div class="page-head"><div><h1>${esc(title)} <span class="badge">Cato</span></h1>
    <p>Users holding a Cato ZTNA (remote access) licence, and how the number changes from month to month.</p></div>`;
  const off = r.group.monitored ? '' : alertBox('warn', 'Cato is switched off, so no new snapshots include it. This is its history.');
  if (!r.selected) {
    view.innerHTML = `${head}</div>${off}${alertBox('info', `No snapshot includes Cato yet. It's read with the daily snapshot at 00:10${state.me.role === 'admin' ? ', or take one now from <a href="#/admin?tab=snapshots">Admin</a>' : ''}.`)}`;
    return;
  }
  const sel = r.selected;
  const changes = [...sel.joined.map(m => ({ ...m, change: 'Joined' })), ...sel.left.map(m => ({ ...m, change: 'Left' }))];
  view.innerHTML = `${head}
      <div class="actions"><button id="dl-csv" class="btn" type="button">Download CSV</button>
        <button id="dl-xlsx" class="btn primary" type="button">Download Excel</button></div></div>
    ${off}
    <div class="filters">
      <div class="field"><label for="f-month">Month</label><select id="f-month">${r.months.map(m =>
        `<option value="${m.month}" ${m.month === sel.month ? 'selected' : ''}>${esc(monthName(m.month))}${m.basis === 'month-to-date' ? ' (to date)' : ''}</option>`).join('')}</select></div>
    </div>
    ${alertBox(sel.basis === 'month-end' ? 'info' : 'warn', `${esc(catoBasis(sel))}.${sel.basis === 'month-to-date' ? ' The month isn\'t over yet.' : ''}`)}
    ${sel.problem ? alertBox('crit', `Cato couldn't be read in this snapshot: ${esc(sel.problem)}`) : ''}
    <div class="hero-row">
      <div class="tile"><div class="label">Users</div><div class="value">${num(sel.count)}</div>
        <div class="sub">Holding a ZTNA licence</div>${sparkline(r.series)}</div>
      <div class="tile"><div class="label">Change from the month before</div><div class="value">${sel.net === null ? '—' : signed(sel.net)}</div>
        <div class="sub">${sel.previousDate ? `${changeCell(sel.added, '+')} joined, ${changeCell(sel.removed, '−')} left since ${esc(fmtDate(sel.previousDate))}` : 'No earlier month to compare with'}</div></div>
      <div class="tile"><div class="label">Licences</div><div class="value">${hasLicences(sel) ? `${num(sel.licenceUsed)} / ${num(sel.licenceTotal)}` : '—'}</div>
        <div class="sub">${hasLicences(sel) ? 'Allocated of purchased, as Cato reports' : 'Cato\'s licence figures weren\'t read'}</div></div>
      <div class="tile"><div class="label">Disabled or locked</div><div class="value">${num(sel.disabled)}</div>
        <div class="sub">Users still holding a licence</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Month by month</h2><span class="muted">Users at each month end; click a month to see its users</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Month</th><th>Figures from</th><th class="num">Users</th><th class="num">Change</th><th class="num">Joined</th><th class="num">Left</th>
          <th class="num" title="Allocated of purchased, as Cato reports">Licences</th><th class="num">Disabled or locked</th><th>Problem</th></tr></thead>
        <tbody>${r.months.map(m => `<tr class="row-link${m.month === sel.month ? ' selected' : ''}" data-month="${m.month}">
          <td class="nowrap">${esc(monthName(m.month))}</td><td>${esc(catoBasis(m))}</td><td class="num">${num(m.count)}</td>
          <td class="num">${m.net === null ? '—' : signed(m.net)}</td><td class="num">${changeCell(m.added, '+')}</td><td class="num">${changeCell(m.removed, '−')}</td>
          <td class="num">${hasLicences(m) ? `${num(m.licenceUsed)} / ${num(m.licenceTotal)}` : '—'}</td><td class="num">${num(m.disabled)}</td>
          <td>${esc(m.problem || '')}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Joiners and leavers in ${esc(monthName(sel.month))}</h2>
        <span class="muted">${sel.previousDate ? `Compared with ${esc(fmtDate(sel.previousDate))}` : 'No earlier month to compare with'}</span></div>
      <div class="table-wrap"><table class="table"><thead>${memberHead({ withGroup: false, change: true })}</thead>
        <tbody>${memberRows(changes, { withGroup: false, change: true }) || `<tr><td colspan="6" class="muted">${sel.previousDate ? 'Nobody joined or left.' : '—'}</td></tr>`}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Users in ${esc(monthName(sel.month))}</h2><span class="muted" id="user-count"></span></div>
      <div class="filters"><div class="field grow"><label for="f-search">Search</label>
        <input id="f-search" type="search" placeholder="Name, email, job title, department…"></div></div>
      <div class="table-wrap"><table class="table"><thead>${memberHead({ withGroup: false })}</thead><tbody id="user-rows"></tbody></table></div>
    </div>`;
  const search = document.getElementById('f-search');
  const drawUsers = () => {
    const q = search.value.trim().toLowerCase();
    const rows = q ? sel.rows.filter(m => [m.name, m.email, m.username, m.title, m.department].some(v => String(v || '').toLowerCase().includes(q))) : sel.rows;
    document.getElementById('user-rows').innerHTML = memberRows(rows, { withGroup: false }) || '<tr><td colspan="5" class="muted">Nobody matches.</td></tr>';
    document.getElementById('user-count').textContent = q ? `${num(rows.length)} of ${num(sel.rows.length)} shown` : `${num(sel.rows.length)} users`;
  };
  search.addEventListener('input', drawUsers);
  drawUsers();
  wireSparklines(view);
  const pick = month => { location.hash = `#/cato?month=${month}`; };
  document.getElementById('f-month').addEventListener('change', e => pick(e.target.value));
  view.querySelectorAll('tr[data-month]').forEach(tr => tr.addEventListener('click', () => pick(tr.dataset.month)));
  document.getElementById('dl-csv').addEventListener('click', () => download(`/api/cato/users.csv?month=${sel.month}`));
  document.getElementById('dl-xlsx').addEventListener('click', () => download(`/api/cato.xlsx?month=${sel.month}`));
}

// ── Members on a date ────────────────────────────────────────────────────────

const groupOptions = (selected, allLabel = 'All groups') =>
  `<option value="">${allLabel}</option>${state.meta.groups.map(g => `<option value="${esc(g.name)}" ${g.name === selected ? 'selected' : ''}>${
    esc(g.label ? `${g.label} — ${g.name}` : g.name)}</option>`).join('')}`;

function memberRows(rows, { withGroup = true, change = false } = {}) {
  return rows.map(m => `<tr>
    ${withGroup ? `<td>${groupCell(m.group, m.groupLabel)}</td>` : ''}${change ? `<td>${m.change === 'Joined' ? '+ Joined' : '− Left'}</td>` : ''}
    <td>${esc(m.name)}</td><td>${esc(m.email)}</td><td>${esc(m.title)}</td><td>${esc(m.department)}</td>
    <td>${m.kind === 'user' && m.enabled === false ? '<span class="badge warn">Disabled</span>' : esc(statusText(m))}</td></tr>`).join('');
}
const memberHead = ({ withGroup = true, change = false } = {}) => `<tr>${withGroup ? '<th>Group</th>' : ''}${change ? '<th>Change</th>' : ''}
  <th>Name</th><th>Email</th><th>Job title</th><th>Department</th><th>Account status</th></tr>`;

async function renderMembers(params) {
  if (!state.meta.last) { view.innerHTML = `<h1>Members on a date</h1>${alertBox('info', 'No snapshots yet.')}`; return; }
  const date = params.get('date') || state.meta.last;
  const group = params.get('group') || '';
  view.innerHTML = `
    <div class="page-head"><div><h1>Members on a date</h1><p>Who was in the licence groups on any day since ${esc(fmtDate(state.meta.first))}.</p></div></div>
    <div class="filters">
      <div class="field"><label for="f-date">Date</label><input id="f-date" type="date" min="${state.meta.first}" max="${state.meta.today}" value="${date}"></div>
      <div class="field"><label for="f-group">Group</label><select id="f-group">${groupOptions(group)}</select></div>
      <div class="field grow"><label for="f-search">Search</label><input id="f-search" type="search" placeholder="Name, email, job title, department…"></div>
      <div class="field"><label>&nbsp;</label><button id="dl" class="btn primary" type="button">Download Excel</button></div>
    </div>
    <div id="result"><p class="loading">Loading…</p></div>`;
  const fDate = document.getElementById('f-date');
  const fGroup = document.getElementById('f-group');
  const fSearch = document.getElementById('f-search');
  const result = document.getElementById('result');
  let data = null;

  const draw = () => {
    const q = fSearch.value.trim().toLowerCase();
    const rows = q ? data.rows.filter(m => [m.name, m.email, m.title, m.department, m.group, m.groupLabel]
      .some(v => String(v || '').toLowerCase().includes(q))) : data.rows;
    const s = data.snapshot;
    const notes = [];
    if (s.date !== data.requestedDate) notes.push(alertBox('info', `There is no snapshot for ${esc(fmtDate(data.requestedDate))}, so this is the one before it, ${esc(fmtDate(s.date))}.`));
    const problems = data.groups.filter(g => g.problem);
    if (problems.length) notes.push(alertBox('warn', `Could not be read in this snapshot: ${problems.map(g => `${esc(g.label || g.name)} (${esc(g.problem)})`).join('; ')}.`));
    result.innerHTML = `${notes.join('')}
      <p class="count-note">Snapshot of ${esc(fmtDate(s.date))}, taken ${esc(fmtDateTime(s.takenAt))} ${snapshotBadge(s)}</p>
      ${fGroup.value ? '' : `<div class="card"><div class="card-head"><h2>Members per group</h2></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Group</th><th class="num">Members</th><th class="num">Disabled accounts</th></tr></thead>
        <tbody>${data.groups.map(g => `<tr class="row-link" data-group="${esc(g.name)}"><td>${groupCell(g.name, g.label)}</td>
          <td class="num">${g.problem ? '—' : num(g.count)}</td><td class="num">${g.problem ? '—' : num(g.disabled)}</td></tr>`).join('')}</tbody></table></div></div>`}
      <div class="card">
        <div class="card-head"><h2>${fGroup.value ? `${esc(groupTitle(fGroup.value))}${groupTitle(fGroup.value) !== fGroup.value
          ? ` <span class="muted" style="font-weight:400;font-size:13px">${esc(fGroup.value)}</span>` : ''}` : 'All members'}</h2>
          <span class="muted">${q ? `${num(rows.length)} of ${num(data.rows.length)} shown` : `${num(rows.length)} ${fGroup.value ? 'members' : 'memberships'}`}</span></div>
        <div class="table-wrap"><table class="table"><thead>${memberHead({ withGroup: !fGroup.value })}</thead>
          <tbody>${memberRows(rows, { withGroup: !fGroup.value }) || '<tr><td colspan="7" class="muted">Nobody matches.</td></tr>'}</tbody></table></div>
      </div>`;
    result.querySelectorAll('tr[data-group]').forEach(tr => tr.addEventListener('click', () => { fGroup.value = tr.dataset.group; load(); }));
  };
  const load = async () => {
    setQuery('members', { date: fDate.value, group: fGroup.value });
    result.innerHTML = '<p class="loading">Loading…</p>';
    try {
      data = await api('GET', `/api/members?${new URLSearchParams({ date: fDate.value, group: fGroup.value })}`);
      draw();
    } catch (err) { result.innerHTML = alertBox('crit', esc(err.message)); }
  };
  fDate.addEventListener('change', load);
  fGroup.addEventListener('change', load);
  fSearch.addEventListener('input', () => data && draw());
  document.getElementById('dl').addEventListener('click', () =>
    download(`/api/members.xlsx?${new URLSearchParams({ date: fDate.value, group: fGroup.value })}`));
  await load();
}

// ── Compare two dates ────────────────────────────────────────────────────────

async function renderCompare(params) {
  if (state.meta.dates.length < 2) { view.innerHTML = `<h1>Compare two dates</h1>${alertBox('info', 'Comparing needs at least two snapshots.')}`; return; }
  const to = params.get('to') || state.meta.last;
  const monthStart = `${to.slice(0, 7)}-01`;
  const from = params.get('from') || (monthStart < to && monthStart >= state.meta.first ? monthStart : state.meta.dates.at(-2));
  const group = params.get('group') || '';
  view.innerHTML = `
    <div class="page-head"><div><h1>Compare two dates</h1><p>Who joined and left each group between two days.</p></div></div>
    <div class="filters">
      <div class="field"><label for="f-from">From</label><input id="f-from" type="date" min="${state.meta.first}" max="${state.meta.today}" value="${from}"></div>
      <div class="field"><label for="f-to">To</label><input id="f-to" type="date" min="${state.meta.first}" max="${state.meta.today}" value="${to}"></div>
      <div class="field"><label for="f-group">Group</label><select id="f-group">${groupOptions(group)}</select></div>
      <div class="field"><label>&nbsp;</label><button id="dl" class="btn primary" type="button">Download Excel</button></div>
    </div>
    <div id="result"><p class="loading">Loading…</p></div>`;
  const f = id => document.getElementById(id);
  const result = f('result');
  const q = () => new URLSearchParams({ from: f('f-from').value, to: f('f-to').value, group: f('f-group').value });
  const load = async () => {
    setQuery('compare', Object.fromEntries(q()));
    result.innerHTML = '<p class="loading">Loading…</p>';
    try {
      const d = await api('GET', `/api/compare?${q()}`);
      const changes = d.groups.flatMap(g => [...g.added.map(m => ({ ...m, change: 'Joined' })), ...g.removed.map(m => ({ ...m, change: 'Left' }))]);
      const notes = [];
      if (d.from.date !== f('f-from').value) notes.push(`From uses the snapshot of ${esc(fmtDate(d.from.date))} (none on ${esc(fmtDate(f('f-from').value))}).`);
      if (d.to.date !== f('f-to').value) notes.push(`To uses the snapshot of ${esc(fmtDate(d.to.date))} (none on ${esc(fmtDate(f('f-to').value))}).`);
      result.innerHTML = `${notes.length ? alertBox('info', notes.join(' ')) : ''}
        <div class="card"><div class="card-head"><h2>Summary</h2><span class="muted">${esc(fmtDate(d.from.date))} → ${esc(fmtDate(d.to.date))}</span></div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Group</th><th class="num">${esc(fmtDayMonth(d.from.date))}</th>
            <th class="num">${esc(fmtDayMonth(d.to.date))}</th><th class="num">Joined</th><th class="num">Left</th></tr></thead>
          <tbody>${d.groups.map(g => `<tr><td>${groupCell(g.name, g.label)}</td><td class="num">${num(g.before)}</td><td class="num">${num(g.after)}</td>
            <td class="num">${g.added.length ? `+${num(g.added.length)}` : '0'}</td><td class="num">${g.removed.length ? `−${num(g.removed.length)}` : '0'}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><div class="card-head"><h2>Joiners and leavers</h2><span class="muted">${num(changes.length)}</span></div>
          <div class="table-wrap"><table class="table"><thead>${memberHead({ change: true })}</thead>
          <tbody>${memberRows(changes, { change: true }) || '<tr><td colspan="7" class="muted">No changes between these dates.</td></tr>'}</tbody></table></div></div>`;
    } catch (err) { result.innerHTML = alertBox('crit', esc(err.message)); }
  };
  ['f-from', 'f-to', 'f-group'].forEach(id => f(id).addEventListener('change', load));
  f('dl').addEventListener('click', () => download(`/api/compare.xlsx?${q()}`));
  await load();
}

// ── Month end ────────────────────────────────────────────────────────────────

const BASIS = {
  'month-end': s => `Month-end position: the 00:10 snapshot of ${esc(fmtDate(s.date))}, which shows membership at the end of the month.`,
  'month-to-date': s => `This month isn't over, so this uses the latest snapshot (${esc(fmtDate(s.date))}). The final report is ready after 00:10 on the 1st.`,
  'latest-in-month': s => `The snapshot for the 1st of the next month is missing, so this uses the last one taken in the month (${esc(fmtDate(s.date))}).`,
};

async function renderMonthEnd(params) {
  const months = state.meta.months;
  if (!months.length) { view.innerHTML = `<h1>Month-end report</h1>${alertBox('info', 'No snapshots yet.')}`; return; }
  // Default to the last finished month that has a report, otherwise the current one
  const thisMonth = state.meta.today.slice(0, 7);
  const month = params.get('month') || months.find(m => m < thisMonth) || months[0];
  view.innerHTML = `
    <div class="page-head"><div><h1>Month-end report</h1><p>Licence group members at the end of a month, as an Excel workbook.</p></div></div>
    <div class="filters">
      <div class="field"><label for="f-month">Month</label><select id="f-month">${months.map(m => `<option value="${m}" ${m === month ? 'selected' : ''}>${esc(monthName(m))}</option>`).join('')}</select></div>
      <div class="field"><label>&nbsp;</label><button id="dl" class="btn primary" type="button">Download Excel</button></div>
    </div>
    <div id="result"><p class="loading">Loading…</p></div>`;
  const fMonth = document.getElementById('f-month');
  const result = document.getElementById('result');
  const load = async () => {
    setQuery('month-end', { month: fMonth.value });
    result.innerHTML = '<p class="loading">Loading…</p>';
    try {
      const r = await api('GET', `/api/month-end?month=${fMonth.value}`);
      const total = r.groups.reduce((n, g) => n + (g.count || 0), 0);
      const licenceCol = r.groups.some(hasLicences);
      const kind = r.basis === 'month-end' ? 'info' : 'warn';
      result.innerHTML = `
        ${alertBox(kind, BASIS[r.basis](r.snapshot))}
        ${r.warnings.filter(w => !/^The month isn't over|^There is no snapshot for/.test(w)).map(w => alertBox('warn', esc(w))).join('')}
        <div class="card">
          <div class="card-head"><h2>${esc(monthName(r.month))}</h2><span class="muted">${r.previous ? `Joined and left compared with ${esc(fmtDate(r.previous.date))}` : ''}</span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Group</th><th class="num">Members</th><th class="num">Joined in month</th><th class="num">Left in month</th>
              <th class="num">Disabled accounts</th>${licenceCol ? '<th class="num" title="Allocated of purchased, as the vendor reports">Licences</th>' : ''}<th>Problem</th></tr></thead>
            <tbody>${r.groups.map(g => `<tr><td>${groupCell(g.name, g.label)}${entraBadge(g)}</td><td class="num">${g.problem ? '—' : num(g.count)}</td>
              <td class="num">${g.added === null ? '—' : g.added ? `+${num(g.added)}` : '0'}</td>
              <td class="num">${g.removed === null ? '—' : g.removed ? `−${num(g.removed)}` : '0'}</td>
              <td class="num">${g.problem ? '—' : num(g.disabled)}</td>${licenceCol ? `<td class="num">${licenceText(g)}</td>` : ''}<td>${esc(g.problem || '')}</td></tr>`).join('')}
              <tr><td><strong>Total (licence assignments)</strong></td><td class="num"><strong>${num(total)}</strong></td><td colspan="${licenceCol ? 5 : 4}"></td></tr>
            </tbody></table></div>
          <p class="count-note">The workbook has a summary sheet, every member in one sheet, the month's joiners and leavers, and one sheet per group.</p>
        </div>`;
    } catch (err) { result.innerHTML = alertBox('crit', esc(err.message)); }
  };
  fMonth.addEventListener('change', load);
  document.getElementById('dl').addEventListener('click', () => download(`/api/month-end.xlsx?month=${fMonth.value}`));
  await load();
}

// ── Admin ────────────────────────────────────────────────────────────────────

const ADMIN_TABS = { snapshots: 'Snapshots', groups: 'Groups', settings: 'Settings', activity: 'Activity' };

async function renderAdmin(params) {
  if (state.me.role !== 'admin') { view.innerHTML = alertBox('crit', 'Only IT admins can open Admin.'); return; }
  const tab = ADMIN_TABS[params.get('tab')] ? params.get('tab') : 'snapshots';
  view.innerHTML = `<div class="page-head"><div><h1>Admin</h1></div></div>
    <div class="tabs">${Object.entries(ADMIN_TABS).map(([k, v]) => `<a href="#/admin?tab=${k}" class="${k === tab ? 'active' : ''}">${v}</a>`).join('')}</div>
    <div id="tab"><p class="loading">Loading…</p></div>`;
  const el = document.getElementById('tab');
  await { snapshots: adminSnapshots, groups: adminGroups, settings: adminSettings, activity: adminActivity }[tab](el);
}

async function adminSnapshots(el) {
  const list = await api('GET', '/api/admin/snapshots');
  const today = list.find(s => s.date === state.meta.today);
  const canTake = !today || today.status !== 'complete';
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Daily snapshot</h2></div>
      <p>Taken every day at 00:10 by the <span class="mono">LicenceReporting snapshot</span> scheduled task on the server. If the server was off at
      00:10, it runs when the server starts. A group that can't be read is tried up to three times, 10 minutes apart, before the snapshot is saved.</p>
      <div class="actions"><button id="take" class="btn primary" type="button" ${canTake ? '' : 'disabled'}>Take snapshot now</button>
        <span class="muted">${canTake ? (today ? "Today's snapshot is incomplete, so it can be taken again." : 'There is no snapshot for today yet.') : "Today's snapshot is complete."}</span></div>
    </div>
    <div class="card"><div class="card-head"><h2>History</h2><span class="muted">${list.length} snapshot${list.length === 1 ? '' : 's'}</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>Taken</th><th>Status</th><th class="num">Groups</th><th class="num">Memberships</th><th>Problems</th><th>Requested by</th></tr></thead>
        <tbody>${list.map(s => `<tr><td class="nowrap">${esc(fmtDate(s.date))}</td><td class="nowrap">${esc(fmtDateTime(s.takenAt))}</td>
          <td>${snapshotBadge(s)}</td><td class="num">${num(s.groups)}</td><td class="num">${num(s.members)}</td>
          <td>${s.problems.map(p => `${esc(p.name)}: ${esc(p.error)}`).join('<br>')}</td><td>${esc(s.requestedBy || '')}</td></tr>`).join('')
          || '<tr><td colspan="7" class="muted">No snapshots yet.</td></tr>'}</tbody>
      </table></div></div>`;
  document.getElementById('take').addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/admin/snapshot-now');
      toast(r.mode === 'task' ? 'Snapshot started. It usually takes under a minute; this page refreshes when it arrives.'
        : `Sample snapshot taken (development)${r.cato === 'live' ? ', with the Cato group read from the real Cato API' : r.cato === 'sample' ? '; Cato isn\'t configured here, so its group is made up' : ''}.`);
      const started = Date.now();
      const poll = async () => {
        state.meta = await api('GET', '/api/meta');
        const fresh = (await api('GET', '/api/admin/snapshots')).find(s => s.date === state.meta.today);
        if ((fresh && Date.parse(fresh.importedAt) >= started - 5000) || Date.now() - started > 5 * 60000) {
          if (parseHash().page === 'admin') route();
          return;
        }
        setTimeout(poll, 5000);
      };
      setTimeout(poll, r.mode === 'task' ? 5000 : 0);
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  });
}

async function adminGroups(el) {
  const [groups, entra, labels, cato] = await Promise.all([api('GET', '/api/admin/groups'), api('GET', '/api/admin/entra-groups'),
    api('GET', '/api/admin/group-labels'), api('GET', '/api/admin/cato')]);
  const entraLines = list => list.map(g => `${g.name}  (${g.id})`).join('\n');
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Friendly names</h2><span class="muted">Shown in place of the group name, with the group underneath</span></div>
      <p>Give each group a name people recognise, e.g. "Microsoft 365 E3" for DL-M365-E3-License. Screens and Excel reports show the
      friendly name, and always say which AD or Entra group it looks up. Leave it blank to show the group name. Groups are still looked
      up by their real name, so this never changes what is counted.</p>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Group it looks up</th><th>Source</th><th style="width:45%">Friendly name</th></tr></thead>
        <tbody>${labels.map(g => `<tr><td class="mono">${esc(g.name)}</td><td>${esc(SOURCE_NAMES[g.source] || g.source)}</td>
          <td><input type="text" maxlength="80" data-label-id="${g.id}" value="${esc(g.label || '')}" aria-label="Friendly name for ${esc(g.name)}"></td></tr>`).join('')}
        </tbody></table></div>
      <div class="actions" style="margin-top:10px"><button id="save-labels" class="btn primary" type="button">Save friendly names</button></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>AD groups</h2></div>
      <p>One AD group name (pre-Windows 2000 name, as in the original script) per line. Changes apply from the next snapshot;
      history for removed groups is kept. Members of nested groups are included.</p>
      <div class="field"><label for="groups">AD groups</label><textarea id="groups" class="groups" spellcheck="false">${esc(groups.join('\n'))}</textarea></div>
      <div class="actions" style="margin-top:10px"><button id="save" class="btn primary" type="button">Save AD groups</button>
        <span class="muted">If a name is wrong, the next snapshot shows "Group not found in AD" for it.</span></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Entra groups</h2><span class="muted">Cloud groups, read through Microsoft Graph</span></div>
      <p>For groups that exist only in Entra ID. One group per line: its display name, or its object ID. Each one is looked up
      in Entra when you save, and kept by object ID, so renaming the group in Entra keeps its history. Members of nested groups
      are included. Groups synced from AD are better in the AD list.</p>
      ${entra.live ? '' : alertBox('warn', 'Entra is not connected here (development), so names are accepted without being checked.')}
      <div class="field"><label for="entra">Entra groups</label><textarea id="entra" class="groups" style="min-height:160px" spellcheck="false"
        placeholder="e.g. Licence - Microsoft 365 Copilot">${esc(entraLines(entra.groups))}</textarea></div>
      <div class="actions" style="margin-top:10px"><button id="save-entra" class="btn primary" type="button">Save Entra groups</button>
        <span class="muted">Needs the app's Graph permissions; if they're missing, saving says so.</span></div>
      <div id="entra-msg"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Cato ZTNA users</h2><span class="muted">Remote access licences, read through the Cato API</span></div>
      <p>When this is on, each snapshot lists the Cato users who hold a ZTNA (remote access) licence, as one more group, with
      the number of licences purchased and allocated. It shows in the dashboard and reports like any other group, and can have a
      friendly name. Switching it off keeps its history. The account ID and API key are entered under
      <a href="#/admin?tab=settings">Admin › Settings</a>, where you can also test the connection.</p>
      ${cato.keyError ? alertBox('crit', esc(cato.keyError))
        : cato.configured ? `<p class="muted">Account ${esc(cato.accountId)}${cato.source === 'app.env' ? ' (from app.env)' : ''}</p>`
          : alertBox('warn', 'Cato isn\'t set up yet: enter the account ID and API key under <a href="#/admin?tab=settings">Admin › Settings</a>. Until then, snapshots show the Cato group as not read.')}
      <div class="field"><label><input type="checkbox" id="cato-on" ${cato.enabled ? 'checked' : ''}> Include Cato ZTNA licence holders in snapshots</label></div>
      <div class="actions" style="margin-top:10px"><button id="save-cato" class="btn primary" type="button">Save</button>
        <span class="muted">Applies from the next snapshot.</span></div>
    </div>`;
  document.getElementById('save-labels').addEventListener('click', async () => {
    try {
      const body = [...el.querySelectorAll('[data-label-id]')].map(i => ({ id: Number(i.dataset.labelId), label: i.value }));
      await api('PUT', '/api/admin/group-labels', { labels: body });
      state.meta = await api('GET', '/api/meta');
      toast('Friendly names saved.');
    } catch (err) { toast(err.message, true); }
  });
  // Adding or removing groups changes the friendly-names table, so it is redrawn after either list is saved
  const redraw = () => adminGroups(el);
  document.getElementById('save').addEventListener('click', async () => {
    try {
      const saved = await api('PUT', '/api/admin/groups', { groups: document.getElementById('groups').value.split(/\r?\n/) });
      state.meta = await api('GET', '/api/meta');
      document.getElementById('groups').value = saved.join('\n');
      toast(`Saved ${saved.length} AD groups.`);
      redraw();
    } catch (err) { toast(err.message, true); }
  });
  document.getElementById('save-cato').addEventListener('click', async () => {
    try {
      const r = await api('PUT', '/api/admin/cato', { enabled: document.getElementById('cato-on').checked });
      state.meta = await api('GET', '/api/meta');
      toast(r.enabled ? 'Cato licences will be in the next snapshot.' : 'Cato licences switched off. Their history is kept.');
      redraw();
    } catch (err) { toast(err.message, true); }
  });
  document.getElementById('save-entra').addEventListener('click', async e => {
    const msg = document.getElementById('entra-msg');
    msg.innerHTML = '';
    e.target.disabled = true;
    try {
      const r = await api('PUT', '/api/admin/entra-groups', { lines: document.getElementById('entra').value.split(/\r?\n/) });
      state.meta = await api('GET', '/api/meta');
      document.getElementById('entra').value = entraLines(r.groups);
      if (r.warning) msg.innerHTML = alertBox('warn', esc(r.warning));
      toast(`Saved ${r.groups.length} Entra group${r.groups.length === 1 ? '' : 's'}.`);
      if (!r.warning) redraw();
    } catch (err) {
      msg.innerHTML = alertBox('crit', `Nothing was saved:<br>${esc(err.message).replace(/\n/g, '<br>')}`);
    } finally { e.target.disabled = false; }
  });
}

// What the Cato connection test found, as one line
function catoTestText(r) {
  const lic = r.licences
    ? `${num(r.licences.total)} ZTNA licences purchased${r.licences.used === null ? '' : `, ${num(r.licences.used)} allocated`}${r.licences.available === null ? '' : `, ${num(r.licences.available)} available`}.`
    : `Licence totals not read${r.licenceError ? `: ${esc(r.licenceError)}` : ''}.`;
  return `Connected. ${num(r.licensed)} of ${num(r.users)} Cato users hold a licence${r.disabledLicensed ? ` (${num(r.disabledLicensed)} of them disabled or locked)` : ''}; ${num(r.withEntraId)} are linked to Entra, so they are matched to the same person in AD and Entra groups. ${lic}`;
}

function catoSettingsCard(c) {
  const status = c.keyError ? alertBox('crit', esc(c.keyError))
    : c.source === 'settings' ? `<p class="muted">Saved${c.updatedBy ? ` by ${esc(c.updatedBy)}` : ''}${c.updatedAt ? ` on ${esc(fmtDateTime(c.updatedAt))}` : ''}.${c.keySaved ? ' The API key is stored encrypted and is never shown again.' : ''}</p>`
      : c.source === 'app.env' ? alertBox('info', 'These come from the server\'s app.env at the moment. Saving here replaces them; app.env is then ignored for Cato.')
        : '';
  return `
    <div class="card">
      <div class="card-head"><h2>Cato API</h2><span class="muted">For the Cato ZTNA licence holders (Admin › Groups)</span></div>
      <p>Make a <strong>View</strong> (read-only) API key in the Cato Management Application under Resources › API Keys, and enter it
      here with the account ID. If the key only allows certain addresses, add this server's outbound internet address.</p>
      ${status}
      <div class="filters">
        <div class="field"><label for="cato-account">Account ID</label>
          <input id="cato-account" type="text" autocomplete="off" spellcheck="false" maxlength="40" value="${esc(c.accountId || '')}" style="width:180px"></div>
        <div class="field grow"><label for="cato-key">API key</label>
          <input id="cato-key" type="password" autocomplete="new-password" spellcheck="false" maxlength="512"
            placeholder="${c.source === 'settings' && c.keySaved && !c.keyError ? 'Saved (hidden). Leave blank to keep it, or paste a new key' : 'Paste the API key'}"></div>
      </div>
      <div class="actions" style="margin-top:10px">
        <button id="cato-save" class="btn primary" type="button">Save</button>
        <button id="cato-test" class="btn" type="button" ${c.configured ? '' : 'disabled'}>Test connection</button>
        ${c.source === 'settings' ? '<button id="cato-remove" class="btn ghost" type="button">Remove</button>' : ''}
      </div>
      <div id="cato-msg"></div>
    </div>`;
}

async function adminSettings(el) {
  const [s, cato] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/cato')]);
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Retention</h2></div>
      <p>Snapshots hold names, email addresses, job titles and departments. Choose how long to keep them; older snapshots are deleted
      after each day's snapshot. The agreed period is ${s.defaultMonths} months (${s.defaultMonths / 12} years); 0 keeps everything.</p>
      <div class="filters"><div class="field"><label for="ret">Keep snapshots for (months)</label>
        <input id="ret" type="text" inputmode="numeric" value="${s.retentionMonths}" style="width:120px"></div>
        <div class="field"><label>&nbsp;</label><button id="save" class="btn primary" type="button">Save</button></div></div>
    </div>
    ${catoSettingsCard(cato)}`;
  const catoMsg = () => document.getElementById('cato-msg');
  document.getElementById('cato-save').addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const keyInput = document.getElementById('cato-key');
      await api('PUT', '/api/admin/cato-settings', { accountId: document.getElementById('cato-account').value, apiKey: keyInput.value });
      keyInput.value = '';
      toast('Cato settings saved.');
      await adminSettings(el);
    } catch (err) {
      catoMsg().innerHTML = alertBox('crit', esc(err.message));
      e.target.disabled = false;
    }
  });
  document.getElementById('cato-test').addEventListener('click', async e => {
    catoMsg().innerHTML = '<p class="loading">Reading Cato…</p>';
    e.target.disabled = true;
    try {
      catoMsg().innerHTML = alertBox('info', catoTestText(await api('POST', '/api/admin/cato/test')));
    } catch (err) {
      catoMsg().innerHTML = alertBox('crit', esc(err.message));
    } finally { e.target.disabled = false; }
  });
  document.getElementById('cato-remove')?.addEventListener('click', async () => {
    if (!confirm('Remove the Cato account ID and API key from the app? Cato snapshots stop until they are entered again (or set in app.env).')) return;
    try {
      await api('DELETE', '/api/admin/cato-settings');
      toast('Cato settings removed.');
      await adminSettings(el);
    } catch (err) { toast(err.message, true); }
  });
  const save = async confirmDelete => {
    try {
      const r = await api('PUT', '/api/admin/settings', { retentionMonths: Number(document.getElementById('ret').value), confirmDelete });
      toast(`Saved.${r.deleted ? ` ${r.deleted} old snapshot(s) deleted.` : ''}`);
    } catch (err) {
      if (err.status === 409 && err.data?.confirmDelete && confirm(`${err.message}\n\nThis can't be undone.`)) return save(err.data.confirmDelete);
      if (err.status !== 409) toast(err.message, true);
    }
  };
  document.getElementById('save').addEventListener('click', () => save());
}

async function adminActivity(el) {
  const rows = await api('GET', '/api/admin/activity');
  el.innerHTML = `<div class="card"><div class="card-head"><h2>Activity</h2><span class="muted">Latest 500: sign-ins, downloads, changes and snapshots</span></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td class="nowrap">${esc(fmtDateTime(r.at))}</td><td>${esc(r.who)}</td><td>${esc(r.action)}</td><td>${esc(r.detail || '')}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
}

// ── Shell ────────────────────────────────────────────────────────────────────

const PAGES = { dashboard: renderDashboard, members: renderMembers, compare: renderCompare, 'month-end': renderMonthEnd, cato: renderCato, admin: renderAdmin };

async function route() {
  const { page, params } = parseHash();
  const render = PAGES[page] || renderDashboard;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (PAGES[page] ? page : 'dashboard')));
  document.getElementById('tooltip').classList.add('hidden');
  view.innerHTML = '<p class="loading">Loading…</p>';
  try {
    state.meta = await api('GET', '/api/meta');
    document.querySelectorAll('.cato-only').forEach(el => el.classList.toggle('hidden', !state.meta.cato));
    await render(params);
  } catch (err) {
    view.innerHTML = alertBox('crit', esc(err.message));
  }
}

function setThemeLabel() {
  document.getElementById('theme-toggle').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
}

(async () => {
  state.me = await api('GET', '/api/me');
  document.getElementById('user-name').textContent = `${state.me.name}${state.me.role === 'admin' ? ' (Admin)' : ''}`;
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', state.me.role !== 'admin'));
  if (state.me.authMode === 'dev') document.getElementById('dev-banner').classList.remove('hidden');
  if (state.me.appEnv) {
    const b = document.getElementById('env-banner');
    b.textContent = state.me.appEnv;
    b.classList.remove('hidden');
  }
  setThemeLabel();
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setThemeLabel();
  });
  document.getElementById('logout').addEventListener('click', async () => {
    const r = await api('POST', '/auth/logout');
    location.href = r?.logoutUrl || '/login';
  });
  window.addEventListener('hashchange', route);
  route();
})();
