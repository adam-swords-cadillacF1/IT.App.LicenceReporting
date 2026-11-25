# Licence Reporting

Takes a snapshot of the licence groups every day at 00:10, so you can report on who was in them at any time. It covers AD groups and Entra ID (cloud-only) groups.

- **Dashboard:** members in each group now, the change since yesterday and since the start of the month, a 90-day trend line per group, and the number of disabled accounts still in each group.
- **Month-end report:** an Excel workbook for any month. It has a summary, every member on one sheet, the month's joiners and leavers, and one sheet per group.
- **Members on a date:** who was in each group on any day since the first snapshot, on screen or as Excel.
- **Compare two dates:** who joined and left each group between two days.

Every member row shows **name, email, job title, department and account status**. The status is Enabled or Disabled. For members with no account in this domain, it says "Contact (no account)" or "Account in another domain".

It replaces `1 Month End report for licesening.ps1`, and is a separate app from User Onboarding so Finance can be given access to this app only.

## How it works

```
00:10 daily   Scheduled task "LicenceReporting snapshot" (SYSTEM)
              └─ snapshot\Take-Snapshot.ps1
                   reads DATA_DIR\groups.json            (the group list, written by the app)
                   reads AD: one query per group, nested members included
                   reads Entra groups through Microsoft Graph (snapshot\entra-groups.js, app certificate)
                   writes DATA_DIR\snapshots\incoming\<date>_<time>.json
within 30 s   The app imports the file into DATA_DIR\licences.db and moves it to snapshots\processed (kept 30 days)
```

- **One snapshot per date.** If a group can't be read (for example a domain controller error), the script tries it again, up to three times and 10 minutes apart. A group that doesn't exist isn't retried. A snapshot where a group still failed is saved as **partial**. Later in the day the snapshot can be taken again with **Admin › Snapshots › Take snapshot now**, which starts the same task. A complete snapshot is never replaced.
- **Missed run:** if the server was off at 00:10, the task runs when the server starts. Snapshots taken after 01:00 are marked **late**. Days with no snapshot are listed on the dashboard, and reports for those days use the snapshot from the day before.
- **Month end:** the 00:10 snapshot on the 1st shows who was in the groups at the end of the previous month, so it is that month's month-end snapshot. During the month, the report uses the latest snapshot and says "to date". If the 1st is missing, it uses the last snapshot taken in the month and says so.
- **Joiners and leavers** are matched on the AD object (objectGUID), so a change of job title or email isn't counted as someone leaving and joining.
- **Storage:** each person's details are stored once per distinct set of values, and each day stores only who was in which group. 120 days of sample data for 13 groups is about 2.3 MB.

### Entra groups

Admin › Groups has a second list for groups that exist only in Entra ID. Enter a display name or an object ID, one per line. Each one is looked up in Entra when you save, and if any can't be found, nothing is saved.

- **Stored by object ID,** so renaming a group in Entra keeps its history, and the next snapshot picks up the new name.
- **Nested members are included** (Graph `transitiveMembers`). Users and mail contacts are listed; devices and service principals are left out because they don't hold licences.
- **The same person is counted once across AD and Entra.** For users synced from AD, `onPremisesImmutableId` is turned back into their AD objectGUID, so someone in an AD group and an Entra group is one person in "People in at least one group".
- **Synced groups are flagged when you save.** Synced groups are better in the AD list, which also sees nested AD groups. A name already used by an AD group is refused.
- **Reading the groups:** `Take-Snapshot.ps1` runs `entra-groups.js` with the app's own Node.js and `app.env`. It signs in to Graph with the app's certificate, so no other secret is stored. Graph errors are retried like domain controller errors. The data goes through files rather than the console, so accented names survive Windows PowerShell 5.1.
- **Permissions:** the app registration needs these **Application** permissions (not Delegated), with admin consent:
  - `GroupMember.Read.All`, to find groups and list their members;
  - `User.Read.All`, for job title, department and whether the account is enabled.

  If they're missing, saving the Entra list says so, and so does the snapshot log.

### Compared with the old script

- One LDAP query per group, using the in-chain matching rule `1.2.840.113556.1.4.1941`. It returns every nested member with their details. The old script made a separate `Get-ADUser` call for each member, so this is much faster, and it isn't limited to 5,000 members as `Get-ADGroupMember` is through AD Web Services.
- Contacts and members from other domains are listed, not skipped.
- The old script saved `AllGroups-Merged.csv` in the same folder it merged from. Each later run merged the previous merged file too, so rows were duplicated.

## Access

Access is set by the app roles on the Entra app registration. Assign people or groups to the enterprise app.

| Role | For | Can |
|---|---|---|
| `Viewer` | Finance | Dashboard, all reports, Excel downloads |
| `Admin` | IT | Everything a Viewer can, plus Admin: group list, snapshot history, Take snapshot now, retention, activity log |

Anyone without one of these roles can't sign in. The server checks the role on every Admin request. The activity log records sign-ins, every download (who, which report, which dates), group list changes, retention changes and every snapshot.

## Run it locally

```bash
cd ~/dev/LicenceReportingApp
npm run sample-data      # 120 days of made-up snapshots (fictional people) into ./data
npm start                # http://localhost:3003
```

Locally the app uses a development sign-in: choose Admin or Viewer, with no password. In that mode it only listens on `127.0.0.1`. Here, **Take snapshot now** adds a made-up snapshot for today, because there is no AD to read. `sample-data.js` refuses to run against a data folder containing a `PRODUCTION` file. Install-App.ps1 creates that file on the server.

```bash
npm test                 # unit tests, plus API tests against a real server on a throwaway data folder
```

## Configuration

Settings come from environment variables. On the server they are in `C:\ProgramData\LicenceReportingApp\app.env`; see [deploy/windows/app.env.example](deploy/windows/app.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3003` | Port to listen on. UserAccountApp uses 3000, ChangeManagementApp 3001 and its dev copy 3002 |
| `AUTH_MODE` | `dev` | `dev` (choose a role, no password, localhost only) or `entra` |
| `APP_URL` | `http://localhost:3003` | Address users browse to; used for the sign-in redirect |
| `APP_TZ` | `Europe/London` | Time zone for snapshot dates, "late" and month ends |
| `DATA_DIR` | `./data` | Database, group list, incoming snapshots, logs. **Keep it out of OneDrive.** |
| `SESSION_SECRET` | generated | Install-App.ps1 generates one |
| `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` | unset | App registration for sign-in |
| `ENTRA_CERT_KEY_PATH` / `ENTRA_CERT_THUMBPRINT` | unset | Certificate credential (preferred) |
| `ENTRA_CLIENT_SECRET` | unset | Only if no certificate |
| `SNAPSHOT_TASK` | `LicenceReporting snapshot` | The scheduled task that Take snapshot now starts |
| `TRUST_PROXY` | unset | The reverse proxy's address, e.g. `10.1.0.233` |
| `FIREWALL_ALLOW_FROM` | any | Server install only: who can reach `PORT` |
| `TLS_PFX_PATH` etc. | unset | Serve HTTPS directly instead of behind the proxy |

Retention is set in **Admin › Settings**. It defaults to **36 months (3 years)**, as agreed. Snapshots older than that are deleted after each day's snapshot. If a change would delete snapshots, the app asks you to confirm the number first.

## Server setup (one time)

Same server and deployment method as ChangeManagementApp: **sl-pvs-appl16**, deployed from the Mac over SMB.

1. **Entra app registration** (for example "Licence Reporting"), single tenant:
   - **Authentication** › Add a platform › **Web**. Redirect URIs:
     - `https://licencereporting.hermes.uk.net/auth/callback` (sign-in)
     - `https://licencereporting.hermes.uk.net/login` (where people land after signing out)
   - Leave the implicit grant boxes (access and ID tokens) unticked.
   - **App roles** › Create app role, twice. Allowed member types: Users/Groups.
     - Display name `Admin`, value **`Admin`**, description "IT: group list, snapshots, retention, activity log"
     - Display name `Viewer`, value **`Viewer`**, description "Finance: dashboard and reports"
   - **API permissions:** Microsoft Graph delegated `openid`, `profile`, `email` (and the default `User.Read`) for sign-in. For Entra groups, also add the **Application** permissions `GroupMember.Read.All` and `User.Read.All`, then click **Grant admin consent**.
   - **Enterprise application** › Properties › *Assignment required* = **Yes**. Under *Users and groups*, assign the Finance group to **Viewer** and IT to **Admin**.
   - Note the **Directory (tenant) ID** and **Application (client) ID** for app.env.
2. **DNS and proxy:** `licencereporting.hermes.uk.net` → Nginx Proxy Manager on sl-pvs-dock02 → `sl-pvs-appl16:3003`, with `X-Forwarded-Proto` set.
3. **On the server** (elevated PowerShell): Node.js 24+, and the AD module (`Install-WindowsFeature RSAT-AD-PowerShell`, already there for UserAccountApp). Copy `deploy/windows/server/Enable-SmbDeploy.ps1` to the server and run `.\Enable-SmbDeploy.ps1 -DeployUsers 'HERMES\your.name'`.
4. **First deploy and settings:**
   1. From the Mac, run `pwsh deploy/windows/deploy.ps1`. This first deploy creates `C:\ProgramData\LicenceReportingApp\app.env` and stops.
   2. On the server, run `C:\Apps\LicenceReportingApp\deploy\windows\server\New-EntraCertificate.ps1` in an elevated PowerShell. It makes the sign-in certificate on the server, keeps the private key in `C:\ProgramData\LicenceReportingApp\certs`, and fills in the certificate settings in app.env.
   3. Upload the `entra-cert.cer` it creates to the app registration under **Certificates & secrets › Certificates**. It's valid for 2 years; before it expires, rerun the script with `-Force` and upload the new one.
   4. Check that app.env has `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`. They come pre-filled from app.env.example.
   5. From the Mac, run `pwsh deploy/windows/deploy.ps1 -Install`. That installs the Windows service, opens the firewall to the proxy only, and installs the 00:10 snapshot task.
5. Sign in, open **Admin › Snapshots** and click **Take snapshot now** to get the first snapshot straight away. Check the counts against the old script.

The snapshot task runs as **SYSTEM**, so no password is stored. On a domain-joined server, SYSTEM reads AD as the computer account, which can read group members and these user attributes by default. If any group or attribute comes back empty because of restricted AD permissions, rerun `Install-SnapshotTask.ps1 -RunAsUser HERMES\<read-only account>`. Install-App.ps1 locks the app folder to SYSTEM and Administrators, because the task runs a script from it as SYSTEM.

## Operations

- **Snapshot log:** `C:\ProgramData\LicenceReportingApp\data\logs\snapshot-<date>.log` (kept 90 days). This lists each group's member count, or the error for that group.
- **App log:** `C:\Apps\LicenceReportingApp\daemon\*.log`.
- **Rejected snapshot files** go to `data\snapshots\rejected`, and the reason is in the activity log.
- **Backups:** every deploy stops the service and copies the app and `data` to `C:\ProgramData\LicenceReportingApp\backups` (the last 10 are kept).
- **Changing the group list:** Admin › Groups. The change applies from the next snapshot, and history for removed groups is kept. A misspelt name shows as "Group not found in AD" in the next snapshot.
