'use strict';
// Microsoft Graph, app-only (client credentials), using the same app registration and certificate as sign-in.
// Needs these APPLICATION permissions on the app registration, with admin consent:
//   GroupMember.Read.All - find groups and list their (nested) members
//   User.Read.All        - members' job title, department and whether the account is enabled
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_FIELDS = 'id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled,onPremisesImmutableId';

const PERMISSION_HINT = 'Check the app registration has the APPLICATION permissions GroupMember.Read.All and User.Read.All, with admin consent.';

// deps lets tests supply fetch and the token without Entra
function client({ fetchImpl = globalThis.fetch, getToken, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!getToken) {
    const entra = require('./entra');
    if (!entra.configured) throw new Error('Entra is not configured (ENTRA_TENANT_ID, ENTRA_CLIENT_ID and the certificate in app.env).');
    getToken = async () => (await entra.msal.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] })).accessToken;
  }

  async function get(url) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(url.startsWith('http') ? url : `${GRAPH}${url}`, {
        headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) return res.json();
      // Throttled or a passing fault: wait (as Graph asks) and try again, up to 5 times
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(Math.min(wait, 60) * 1000);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      const code = body?.error?.code || res.status;
      const message = body?.error?.message || res.statusText;
      const err = new Error(res.status === 403 || code === 'Authorization_RequestDenied'
        ? `Microsoft Graph refused access (${code}). ${PERMISSION_HINT}` : `Microsoft Graph: ${code} - ${message}`);
      err.status = res.status;
      throw err;
    }
  }

  async function getAll(url) {
    const items = [];
    for (let next = url; next;) {
      const page = await get(next);
      items.push(...(page.value || []));
      next = page['@odata.nextLink'] || null;
    }
    return items;
  }

  // A line from Admin › Groups: an object ID, or a display name that must match exactly one group
  async function findGroup(text) {
    const value = String(text).trim();
    const fields = '$select=id,displayName,onPremisesSyncEnabled';
    if (GUID_RE.test(value)) {
      try { return await get(`/groups/${value}?${fields}`); } catch (err) {
        if (err.status === 404) throw new Error(`No Entra group with object ID ${value}`);
        throw err;
      }
    }
    const matches = await getAll(`/groups?$filter=displayName eq '${value.replace(/'/g, "''")}'&${fields}`);
    if (!matches.length) throw new Error(`No Entra group called "${value}"`);
    if (matches.length > 1) throw new Error(`${matches.length} Entra groups are called "${value}". Use the object ID of the right one.`);
    return matches[0];
  }

  // Everyone in the group, including members of nested groups: users and mail contacts
  async function groupMembers(id) {
    const objects = await getAll(`/groups/${id}/transitiveMembers?$select=${USER_FIELDS}&$top=999`);
    const members = [];
    for (const o of objects) {
      if (o['@odata.type'] === '#microsoft.graph.user') {
        members.push({
          id: adGuidFromImmutableId(o.onPremisesImmutableId) || o.id,
          kind: 'user',
          username: o.userPrincipalName || '',
          name: o.displayName || o.userPrincipalName || '',
          email: o.mail || '',
          title: o.jobTitle || '',
          department: o.department || '',
          enabled: o.accountEnabled !== false,
        });
      } else if (o['@odata.type'] === '#microsoft.graph.orgContact') {
        members.push({ id: o.id, kind: 'contact', username: '', name: o.displayName || '', email: o.mail || '',
          title: o.jobTitle || '', department: o.department || '', enabled: null });
      }
      // Devices, service principals and nested groups themselves don't hold licences, so they're left out
    }
    return members;
  }

  return { get, getAll, findGroup, groupMembers };
}

// For users synced from AD, onPremisesImmutableId is the AD objectGUID in base64. Turning it back into the
// GUID means the same person in an AD group and an Entra group is recognised as one person.
function adGuidFromImmutableId(immutableId) {
  if (!immutableId) return null;
  const b = Buffer.from(immutableId, 'base64');
  if (b.length !== 16) return null;
  const hex = [...b].map(x => x.toString(16).padStart(2, '0'));
  // .NET GUID byte order: the first three groups are little-endian
  return [
    [3, 2, 1, 0].map(i => hex[i]).join(''),
    [5, 4].map(i => hex[i]).join(''),
    [7, 6].map(i => hex[i]).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

module.exports = { client, adGuidFromImmutableId, GUID_RE, PERMISSION_HINT };
