'use strict';
// Cato Networks (SASE / SD-WAN) API, read-only: who holds a ZTNA (remote access, formerly SDP) user licence, and how
// many licences the account has. Uses Cato's GraphQL API with an API key. Nothing here changes anything in Cato.
//
// Settings: the Cato account ID and API key are entered in Admin › Settings (the key is stored encrypted; see
// lib/cato-settings.js). A View (read-only) key made in the Cato Management Application (Resources › API Keys) is
// enough. If nothing is saved there, app.env's CATO_ACCOUNT_ID and CATO_API_KEY are used instead. CATO_API_URL in
// app.env overrides the GraphQL endpoint (default below). The key is never logged or shown.
//
// Who counts as licensed: users with hasRemoteAccessEligibility ("eligible for licensed remote access"), from
// user(accountId).userList, which lists every user in the account with their email and status. The licence totals
// come from licensing.licensingInfo, which Cato marks as beta, so the users are still read if the totals fail.
const DEFAULT_URL = 'https://api.catonetworks.com/api/v1/graphql2';
const PAGE_SIZE = 100;
const MAX_PAGES = 500;   // 50,000 users: far more than the account has; stops a paging fault looping for ever

const USERS_QUERY = `query licenceReportingUsers($accountId: ID!, $input: UserListInput!) {
  user(accountId: $accountId) {
    userList(input: $input) {
      items { id displayName email firstName lastName userPrincipalName userStatus hasRemoteAccessEligibility department jobTitle objectId }
      pageInfo { total }
    }
  }
}`;

const LICENCE_QUERY = `query licenceReportingLicences($accountId: ID!) {
  licensing(accountId: $accountId) {
    licensingInfo {
      globalLicenseAllocations { ztnaUsers { total allocated available } }
      ztnaUsers { sku status total expirationDate }
    }
  }
}`;

// { apiKey, accountId, url, source: 'settings' | 'app.env' | null, keyError }. What is saved in Admin › Settings wins
// as a whole; app.env is only used when nothing is saved there. `saved` is lib/cato-settings.js stored() (tests pass it).
function settings(env = process.env, saved = require('./cato-settings').stored()) {
  const url = env.CATO_API_URL || DEFAULT_URL;
  if (saved?.saved) return { apiKey: saved.apiKey, accountId: saved.accountId, url, source: 'settings', keyError: saved.keyError };
  const apiKey = env.CATO_API_KEY || '';
  const accountId = env.CATO_ACCOUNT_ID || '';
  return { apiKey, accountId, url, source: apiKey || accountId ? 'app.env' : null, keyError: null };
}
const isConfigured = (env = process.env, saved = undefined) => {
  const s = settings(env, saved);
  return Boolean(s.apiKey && s.accountId);
};

const NOT_CONFIGURED = 'Cato is not set up: enter the Cato account ID and API key in Admin › Settings.';
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

// deps let tests supply fetch and settings without a real Cato account
function client({ fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), env = process.env, saved = undefined } = {}) {
  const { apiKey, accountId, url, keyError } = settings(env, saved);
  if (keyError) throw fail(keyError);
  if (!apiKey || !accountId) throw fail(NOT_CONFIGURED);

  // One GraphQL request. Throttling and passing faults are waited out and tried again, up to 5 times. Errors never
  // carry the API key: it is only ever in the request header.
  async function query(text, variables) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query: text, variables }),
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        if (attempt < 5) { await sleep(2 ** attempt * 1000); continue; }
        throw fail(`Could not reach the Cato API (${err.cause?.code || err.name || 'network error'}). Check the server can reach ${new URL(url).host} on 443.`);
      }
      const body = await res.json().catch(() => null);
      const messages = (body?.errors || []).map(e => String(e?.message || '')).filter(Boolean);
      const throttled = res.status === 429 || messages.some(m => /rate limit|too many requests/i.test(m));
      if ((throttled || res.status >= 500) && attempt < 5) {
        const wait = Number(res.headers?.get?.('retry-after')) || 2 ** attempt * 5;
        await sleep(Math.min(wait, 120) * 1000);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw fail(`The Cato API refused the API key (HTTP ${res.status}). Check the key in Admin › Settings is current and allowed from this server's address.`);
      }
      if (!res.ok) throw fail(`Cato API: HTTP ${res.status}${messages.length ? ` - ${messages.join('; ')}` : ''}`);
      if (messages.length) {
        const denied = messages.some(m => /permission|not authori[sz]ed|access denied/i.test(m));
        throw fail(`Cato API: ${messages.join('; ').slice(0, 500)}${denied ? ' (check the API key\'s permissions and the account ID)' : ''}`,
          { partialData: body?.data ?? null });
      }
      if (!body || typeof body !== 'object' || !body.data) throw fail('Cato API: the reply had no data');
      return body.data;
    }
  }

  // Every user in the account, a page at a time
  async function allUsers() {
    const users = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await query(USERS_QUERY, { accountId, input: { paging: { from: users.length, limit: PAGE_SIZE } } });
      const list = data?.user?.userList;
      if (!list || !Array.isArray(list.items)) throw fail('Cato API: the user list was missing from the reply');
      users.push(...list.items);
      const total = Number(list.pageInfo?.total);
      if (!list.items.length || (Number.isFinite(total) && users.length >= total)) return users;
    }
    throw fail(`Cato API: stopped after ${MAX_PAGES} pages of users; the paging may be faulty`);
  }

  // Users holding a ZTNA licence (eligible for licensed remote access)
  async function licensedUsers() {
    return (await allUsers()).filter(u => u && u.hasRemoteAccessEligibility === true);
  }

  // ZTNA licence totals: { total, used, available, licences: [{ sku, status, total, expirationDate }] }, or null if the
  // account reports none. `used` is what Cato counts as allocated, which can differ from the number of eligible users.
  async function ztnaLicences() {
    const info = (await query(LICENCE_QUERY, { accountId }))?.licensing?.licensingInfo;
    if (!info) throw fail('Cato API: no licensing information in the reply');
    const licences = (info.ztnaUsers || []).filter(Boolean).map(l => ({
      sku: l.sku || '', status: l.status || '', total: Number.isInteger(l.total) ? l.total : null, expirationDate: l.expirationDate || null,
    }));
    const alloc = info.globalLicenseAllocations?.ztnaUsers;
    const activeTotal = licences.filter(l => l.status === 'ACTIVE' && l.total !== null).reduce((n, l) => n + l.total, 0);
    const total = Number.isInteger(alloc?.total) ? alloc.total : licences.length ? activeTotal : null;
    if (total === null) return null;
    return {
      total,
      used: Number.isInteger(alloc?.allocated) ? alloc.allocated : null,
      available: Number.isInteger(alloc?.available) ? alloc.available : null,
      licences,
    };
  }

  return { query, allUsers, licensedUsers, ztnaLicences };
}

module.exports = { client, isConfigured, settings, DEFAULT_URL, NOT_CONFIGURED, USERS_QUERY, LICENCE_QUERY };
