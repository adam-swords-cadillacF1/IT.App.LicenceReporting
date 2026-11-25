<#
  Takes one snapshot of the licence groups (AD, and Entra cloud groups) and hands it to the Licence Reporting app.
  Runs ON THE SERVER as the "LicenceReporting snapshot" scheduled task (daily at 00:10, as SYSTEM),
  installed by deploy/windows/server/Install-SnapshotTask.ps1. The app's "Take snapshot now" button
  starts the same task.

  - Reads the group list from <DataDir>\groups.json (the app writes it whenever IT changes the list)
  - For each group, finds every member, including members of nested groups: users (name, email, job
    title, department, username, enabled), mail contacts, and members from other domains (shown by
    account name; their details are not readable from this domain)
  - Entra (cloud) groups are read through Microsoft Graph by entra-groups.js (next to this script), run with
    the app's Node.js and settings, signing in with the app's certificate
  - Writes <DataDir>\snapshots\incoming\<date>_<time>.json, which the app imports within 30 seconds
  - A group that can't be read (e.g. a domain controller error) is tried again, up to -Attempts times,
    -RetryMinutes apart, before the snapshot is written. A group that doesn't exist isn't retried.
  - Exits 1 if any group still could not be read (shown in the app as a partial snapshot)

  Only reads AD; never changes it. Works in Windows PowerShell 5.1 with the ActiveDirectory (RSAT) module.

  Compared with "1 Month End report for licesening.ps1": one LDAP query per group (the in-chain matching
  rule) returns every nested member with their details, instead of Get-ADGroupMember -Recursive plus a
  Get-ADUser per person. It is much faster and isn't limited to 5,000 members by AD Web Services.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $DataDir,
    [string] $Server,                       # a domain controller; default is the computer's own domain
    [int]    $Attempts = 3,
    [int]    $RetryMinutes = 10,
    [switch] $SkipModuleImport              # tests supply their own Get-ADGroup, Get-ADUser and Get-ADObject
)

$ErrorActionPreference = 'Stop'
$logDir   = Join-Path $DataDir 'logs'
$incoming = Join-Path $DataDir 'snapshots\incoming'
$request  = Join-Path $DataDir 'snapshots\request.json'
foreach ($dir in @($logDir, $incoming)) { if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null } }

$started = Get-Date
$logFile = Join-Path $logDir ("snapshot-{0}.log" -f $started.ToString('yyyy-MM-dd'))
function Write-Log([string] $Message) {
    $line = '{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    Write-Host $line
}

# Escapes a value for use inside an LDAP filter (RFC 4515)
function ConvertTo-LdapFilterValue([string] $Value) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '\'      { [void]$sb.Append('\5c') }
            '*'      { [void]$sb.Append('\2a') }
            '('      { [void]$sb.Append('\28') }
            ')'      { [void]$sb.Append('\29') }
            ([char]0) { [void]$sb.Append('\00') }
            default  { [void]$sb.Append($ch) }
        }
    }
    $sb.ToString()
}

function Get-Text($Value) { if ($null -eq $Value) { '' } else { ([string]$Value).Trim() } }

# Parses JSON of any size into dictionaries. Windows PowerShell 5.1's ConvertFrom-Json can refuse very large
# documents, and dictionaries can have keys removed before the snapshot is written.
function ConvertFrom-JsonText([string] $Text) {
    if ($PSVersionTable.PSVersion.Major -ge 6) { return ($Text | ConvertFrom-Json -AsHashtable) }
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = [int]::MaxValue
    return $serializer.DeserializeObject($Text)
}

try {
    $AD = @{}
    if ($Server) { $AD.Server = $Server }

    $groupsFile = Join-Path $DataDir 'groups.json'
    if (-not (Test-Path $groupsFile)) { throw "No group list at $groupsFile. Start the app once so it writes the list." }
    $list = Get-Content $groupsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $groupNames = @($list.groups | Where-Object { $_ })
    $entraGroups = @($list.entraGroups | Where-Object { $_ -and $_.id })
    if (-not $groupNames.Count -and -not $entraGroups.Count) { throw "The group list in $groupsFile is empty." }
    if ($groupNames.Count -and -not $SkipModuleImport) { Import-Module ActiveDirectory -ErrorAction Stop }

    # "Take snapshot now" in the app leaves a note of who asked; only trust a recent one
    $requestedBy = $null
    if (Test-Path $request) {
        try {
            if ((Get-Item $request).LastWriteTime -gt (Get-Date).AddMinutes(-30)) {
                $requestedBy = [string](Get-Content $request -Raw -Encoding UTF8 | ConvertFrom-Json).requestedBy
            }
        } catch { }
        Remove-Item $request -Force -ErrorAction SilentlyContinue
    }

    $who = [Environment]::UserName
    try { $who = [Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { }
    Write-Log "Snapshot of $($groupNames.Count) AD and $($entraGroups.Count) Entra group(s) as $who$(if ($requestedBy) { ", requested by $requestedBy" })"
    $userProps = @('DisplayName', 'mail', 'Title', 'Department', 'Enabled', 'ObjectGUID', 'SamAccountName', 'GivenName', 'Surname')
    $contactProps = @('displayName', 'mail', 'title', 'department', 'objectGUID', 'name')

    function Read-Group([string] $name) {
        $entry = [ordered]@{ name = [string]$name; found = $false; error = $null; members = @() }
        try {
            $sam = ConvertTo-LdapFilterValue $name
            $group = @(Get-ADGroup -LDAPFilter "(sAMAccountName=$sam)" @AD)
            if (-not $group.Count) { throw "Group not found in AD" }
            $entry.found = $true
            $dn = ConvertTo-LdapFilterValue $group[0].DistinguishedName
            # 1.2.840.113556.1.4.1941 = LDAP_MATCHING_RULE_IN_CHAIN: direct and nested members in one query
            $inChain = "(memberOf:1.2.840.113556.1.4.1941:=$dn)"
            $members = New-Object System.Collections.ArrayList

            foreach ($u in @(Get-ADUser -LDAPFilter "(&(objectCategory=person)(objectClass=user)$inChain)" -Properties $userProps -ResultPageSize 500 @AD)) {
                $display = Get-Text $u.DisplayName
                if (-not $display) { $display = ((Get-Text $u.GivenName) + ' ' + (Get-Text $u.Surname)).Trim() }
                if (-not $display) { $display = Get-Text $u.SamAccountName }
                [void]$members.Add([ordered]@{
                    id = $u.ObjectGUID.ToString(); kind = 'user'; username = Get-Text $u.SamAccountName; name = $display
                    email = Get-Text $u.mail; title = Get-Text $u.Title; department = Get-Text $u.Department; enabled = [bool]$u.Enabled
                })
            }
            foreach ($c in @(Get-ADObject -LDAPFilter "(&(objectClass=contact)$inChain)" -Properties $contactProps -ResultPageSize 500 @AD)) {
                $display = Get-Text $c.displayName
                if (-not $display) { $display = Get-Text $c.name }
                [void]$members.Add([ordered]@{
                    id = $c.ObjectGUID.ToString(); kind = 'contact'; username = ''; name = $display
                    email = Get-Text $c.mail; title = Get-Text $c.title; department = Get-Text $c.department; enabled = $null
                })
            }
            # Members from other domains or forests appear as foreign security principals: name them by account
            foreach ($f in @(Get-ADObject -LDAPFilter "(&(objectClass=foreignSecurityPrincipal)$inChain)" -Properties objectSid -ResultPageSize 500 @AD)) {
                $sid = $f.objectSid.Value
                $account = $sid
                try { $account = $f.objectSid.Translate([Security.Principal.NTAccount]).Value } catch { }
                [void]$members.Add([ordered]@{
                    id = $sid; kind = 'external'; username = $account; name = $account
                    email = ''; title = ''; department = ''; enabled = $null
                })
            }
            $entry.members = @($members)
            Write-Log ("  {0}: {1} member(s)" -f $name, $members.Count)
        } catch {
            $entry.error = $_.Exception.Message
            $script:retry = $entry.found -or $entry.error -ne 'Group not found in AD'
            Write-Log ("  {0}: FAILED - {1}" -f $name, $_.Exception.Message)
        }
        $entry
    }

    # Entra groups, all in one run of entra-groups.js. Files carry the data both ways (see that script).
    function Read-EntraGroups($toRead) {
        $req = Join-Path $DataDir 'snapshots\entra-request.json'
        $res = Join-Path $DataDir 'snapshots\entra-result.json'
        Remove-Item $res -Force -ErrorAction SilentlyContinue
        $body = [ordered]@{ config = $list.config; groups = @($toRead | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name } }) }
        [IO.File]::WriteAllText($req, ($body | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
        $node = if ($list.node) { $list.node } else { 'node' }
        $problem = $null
        try {
            $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            & $node (Join-Path $PSScriptRoot 'entra-groups.js') $req $res 2>&1 | Out-Null
            $code = $LASTEXITCODE
            $ErrorActionPreference = $previous
            $parsed = if (Test-Path $res) { ConvertFrom-JsonText ([IO.File]::ReadAllText($res, [Text.Encoding]::UTF8)) } else { $null }
            if (-not $parsed) { $problem = "entra-groups.js wrote no result (exit $code)" }
            elseif ($parsed['error']) { $problem = [string]$parsed['error'] }
        } catch {
            $ErrorActionPreference = 'Stop'
            $problem = "Could not run entra-groups.js: $($_.Exception.Message)"
        } finally {
            Remove-Item $req, $res -Force -ErrorAction SilentlyContinue
        }
        $out = @{}
        foreach ($g in $toRead) {
            $entry = $null
            if (-not $problem) { $entry = @($parsed['groups']) | Where-Object { $_['entraId'] -eq $g.id } | Select-Object -First 1 }
            if (-not $entry) {
                $entry = [ordered]@{ name = [string]$g.name; source = 'entra'; entraId = [string]$g.id; found = $false
                    error = $(if ($problem) { $problem } else { 'No result for this group' }); members = @(); retry = $true }
            }
            if ($entry['error']) { Write-Log ("  {0} (Entra): FAILED - {1}" -f $g.name, $entry['error']) }
            else { Write-Log ("  {0} (Entra): {1} member(s)" -f $entry['name'], @($entry['members']).Count) }
            $out[[string]$g.id] = $entry
        }
        $out
    }

    $results = [ordered]@{}
    $entraResults = @{}
    $retryable = { param($e) $e['error'] -and $e['retry'] }
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $toRead = @($groupNames | Where-Object { -not $results.Contains($_) -or (& $retryable $results[$_]) })
        $entraToRead = @($entraGroups | Where-Object { -not $entraResults.ContainsKey([string]$_.id) -or (& $retryable $entraResults[[string]$_.id]) })
        if (-not $toRead.Count -and -not $entraToRead.Count) { break }
        if ($attempt -gt 1) {
            Write-Log "Trying $($toRead.Count + $entraToRead.Count) group(s) again in $RetryMinutes minute(s) (attempt $attempt of $Attempts)"
            Start-Sleep -Seconds ($RetryMinutes * 60)
        }
        foreach ($name in $toRead) {
            $script:retry = $false
            $entry = Read-Group $name
            $entry.retry = $script:retry
            $results[$name] = $entry
        }
        if ($entraToRead.Count) {
            $read = Read-EntraGroups $entraToRead
            foreach ($id in $read.Keys) { $entraResults[$id] = $read[$id] }
        }
    }
    $groups = @()
    $failures = 0
    $ordered = @($groupNames | ForEach-Object { $results[$_] }) + @($entraGroups | ForEach-Object { $entraResults[[string]$_.id] })
    foreach ($entry in $ordered) {
        $entry.Remove('retry')
        if ($entry['error']) { $failures++ }
        $groups += ,$entry
    }

    $date = $started.ToString('yyyy-MM-dd')
    $snapshot = [ordered]@{
        version     = 1
        date        = $date
        takenAt     = $started.ToString('o')
        requestedBy = $requestedBy
        computer    = $env:COMPUTERNAME
        runAs       = $who
        groups      = $groups
    }
    $json = $snapshot | ConvertTo-Json -Depth 8 -Compress
    # Written under a temporary name, then renamed, so the app never reads a half-written file
    $final = Join-Path $incoming ("{0}_{1}.json" -f $date, $started.ToString('HHmmss'))
    [IO.File]::WriteAllText("$final.tmp", $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -Path "$final.tmp" -Destination $final -Force
    Write-Log "Wrote $final ($([math]::Round($json.Length / 1KB)) KB) in $([math]::Round(((Get-Date) - $started).TotalSeconds))s; $failures group(s) failed"

    # Keep 90 days of logs
    Get-ChildItem $logDir -Filter 'snapshot-*.log' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-90) | Remove-Item -Force
    if ($failures) { exit 1 }
    exit 0
} catch {
    Write-Log "Snapshot FAILED: $($_.Exception.Message)"
    exit 2
}
