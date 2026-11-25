<#
  Deploys Licence Reporting to the Windows server over SMB. Runs on macOS (pwsh) or Windows.

    pwsh deploy/windows/deploy.ps1             # deploy main to production (test locally first: npm test, npm start)
    pwsh deploy/windows/deploy.ps1 -Install    # rerun first-time setup on the server (after filling in app.env)

  Production only takes main, committed and pushed, so what runs there is always what's in GitHub.

  Needs: Node.js 24 + npm with Artifactory access, and tar (built into macOS and Windows 10+).
  One-time: run server/Enable-SmbDeploy.ps1 on the server (see README).

  The package is copied to the server's drop folder share; a scheduled task on the server runs it
  within a minute and writes the log back, which this script waits for and prints.
  Packages are installed here from Artifactory (npm ci, locked by package-lock.json) and shipped with
  the code, so the server never needs registry access. The app has no native modules, so this is safe.
#>
[CmdletBinding(PositionalBinding = $false)]   # named parameters only, so a stray "- AppUrl" fails clearly
param(
    [ValidatePattern('^[A-Za-z0-9.-]+$')]
    [string] $Server    = 'sl-pvs-appl16.hermes.uk.net',                 # full name, so Kerberos can be used
    # Account granted on the share: DOMAIN\user for a domain account, or just a name for a local server account.
    # Domain accounts are recommended; servers often block local admin accounts from signing in over the network.
    [string] $User      = "HERMES\$([Environment]::UserName)",
    [ValidateSet('Prod')]   # there is no dev copy on the server yet; add one here and in Enable-SmbDeploy.ps1 if needed
    [string] $Environment = 'Prod',
    # Default to the chosen environment's values below
    [string] $ShareName,
    [string] $AppUrl,                                                      # same as APP_URL in app.env
    [string] $AppPath,
    [int]    $WaitMinutes = 10,
    [switch] $Install
)

$ErrorActionPreference = 'Stop'
$LocalPath = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path

$environments = @{
    Prod = @{ ShareName = 'LicenceReportingDeploy';     AppUrl = 'https://licencereporting.hermes.uk.net';     AppPath = 'C:\Apps\LicenceReportingApp' }
}
foreach ($name in 'ShareName', 'AppUrl', 'AppPath') {
    if (-not $PSBoundParameters.ContainsKey($name)) { Set-Variable $name $environments[$Environment][$name] }
}
$onWindows = $IsWindows -or $PSVersionTable.PSEdition -eq 'Desktop'
# HERMES\name is a domain account; a bare name is a local account on the server, whose "domain" is the server name
if ($User -match '^([^\\]+)\\(.+)$') { $domain = $Matches[1].ToUpper(); $account = $Matches[2] }
else { $domain = $Server.Split('.')[0].ToUpper(); $account = $User }

# Returns the local path of the share and whether we mounted it (so we unmount it afterwards)
function Open-Share {
    if ($onWindows) {
        $unc = "\\$Server\$ShareName"
        if (-not (Test-Path $unc)) {
            $cred = Get-Credential -UserName "$domain\$account" -Message "Password for $domain\$account"
            New-PSDrive -Name LRDeploy -PSProvider FileSystem -Root $unc -Credential $cred | Out-Null
        }
        return @{ Path = $unc; Mounted = $false }
    }
    # macOS: reuse an existing mount (e.g. from Finder), otherwise mount to a temporary folder
    $existing = mount | Select-String -Pattern "^//[^ ]*@$([regex]::Escape($Server.Split('.')[0]))(\.[^/ ]*)?/$ShareName on (.+) \(smbfs" |
        Select-Object -First 1
    if ($existing) { return @{ Path = $existing.Matches[0].Groups[2].Value; Mounted = $false } }
    $mnt = Join-Path ([IO.Path]::GetTempPath()) "lr-deploy-$PID"
    New-Item -ItemType Directory -Force -Path $mnt | Out-Null
    # Uses a Kerberos ticket if the Mac has one, otherwise asks for the password unless it is saved in
    # the Keychain (connect once in Finder and tick "Remember this password").
    Write-Host "    Mounting //$domain;$account@$Server/$ShareName" -ForegroundColor Gray
    mount_smbfs "//$domain;$account@$Server/$ShareName" $mnt
    if ($LASTEXITCODE -ne 0) { Remove-Item $mnt -ErrorAction SilentlyContinue; throw "Could not mount the deploy share." }
    return @{ Path = $mnt; Mounted = $true }
}

function Close-Share($share) {
    if ($share -and $share.Mounted) {
        umount $share.Path 2>$null
        Remove-Item $share.Path -ErrorAction SilentlyContinue
    }
    if (Get-PSDrive -Name LRDeploy -ErrorAction SilentlyContinue) { Remove-PSDrive -Name LRDeploy }
}

foreach ($tool in @('tar', 'npm', 'git') + $(if ($onWindows) { @() } else { @('mount_smbfs') })) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "'$tool' was not found on this machine." }
}

# What is being deployed, and for production, that it has been through main and is in GitHub
$branch = git -C $LocalPath rev-parse --abbrev-ref HEAD
$commit = git -C $LocalPath rev-parse --short HEAD
$dirty  = @(git -C $LocalPath status --porcelain -- . | Where-Object { $_ -notmatch '\.DS_Store$' })
if ($Environment -eq 'Prod' -and -not $Install) {
    if ($branch -ne 'main') { throw "Production deploys come from main, but this is '$branch'. Merge it into main first." }
    if ($dirty) { throw "There are uncommitted changes, so production would get code that isn't in Git:`n$($dirty -join "`n")" }
    git -C $LocalPath fetch --quiet origin main
    if ($LASTEXITCODE -ne 0) { throw "Could not check GitHub (git fetch failed)." }
    if ((git -C $LocalPath rev-parse HEAD) -ne (git -C $LocalPath rev-parse origin/main)) {
        throw "Local main is not the same as GitHub's. Push (or pull) first, so production matches GitHub."
    }
}
Write-Host "==> $($Environment.ToUpper()): $branch @ $commit$(if ($dirty) { ' plus uncommitted changes' }) -> $AppUrl" -ForegroundColor Magenta

$id  = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + (Get-Random -Maximum 9999)
$pkg = Join-Path ([IO.Path]::GetTempPath()) "licencereportingapp-$id.tgz"

if (-not $Install) {
    Write-Host "==> Installing packages locally from Artifactory (npm ci)..." -ForegroundColor Cyan
    Push-Location $LocalPath
    try { npm ci --omit=dev; if ($LASTEXITCODE -ne 0) { throw "npm ci failed." } } finally { Pop-Location }

    Write-Host "==> Packaging..." -ForegroundColor Cyan
    $env:COPYFILE_DISABLE = '1'   # stop macOS tar adding ._ metadata files
    tar -czf $pkg -C $LocalPath --exclude './.git' --exclude './data' --exclude './daemon' --exclude './.env' --exclude '*.log' --exclude '.DS_Store' .
    if ($LASTEXITCODE -ne 0) { throw "tar failed." }
    Write-Host "    $([math]::Round((Get-Item $pkg).Length / 1MB, 1)) MB" -ForegroundColor Gray
}

$share = $null
try {
    Write-Host "==> Connecting to \\$Server\$ShareName..." -ForegroundColor Cyan
    $share = Open-Share
    $drop = $share.Path

    if (-not $Install) {
        Write-Host "==> Uploading..." -ForegroundColor Cyan
        $work = Join-Path $drop $id
        New-Item -ItemType Directory -Path $work | Out-Null
        Copy-Item $pkg (Join-Path $work 'package.tgz')
        Copy-Item (Join-Path $LocalPath 'deploy/windows/server/Update-App.ps1') $work
    }

    # Written under a temporary name and renamed, so the server never sees a half-written request
    $request = @{ action = $(if ($Install) { 'install' } else { 'deploy' }); appPath = $AppPath } | ConvertTo-Json
    Set-Content -Path (Join-Path $drop "$id.tmp") -Value $request
    Move-Item (Join-Path $drop "$id.tmp") (Join-Path $drop "$id.ready")

    Write-Host "==> Waiting for the server to run it (checks every minute)..." -ForegroundColor Cyan
    $done = Join-Path $drop "results/$id.done"
    $deadline = (Get-Date).AddMinutes($WaitMinutes)
    while (-not (Test-Path $done)) {
        if ((Get-Date) -gt $deadline) {
            throw "No result after $WaitMinutes minutes. Check the 'LicenceReportingApp deploy' scheduled task on $Server."
        }
        Start-Sleep -Seconds 5
    }
    Start-Sleep -Seconds 1
    $log = Join-Path $drop "results/$id.log"
    if (Test-Path $log) { Get-Content $log | ForEach-Object { Write-Host "    | $_" } }
    $result = Get-Content $done -Raw | ConvertFrom-Json
    if (-not $result.ok) { throw "The server reported a failure (exit $($result.exitCode)). See the log above." }
} finally {
    Close-Share $share
    Remove-Item $pkg -ErrorAction SilentlyContinue
}

# Checked from this machine, through the real certificate, as a user would reach it
try {
    $res = Invoke-WebRequest "$AppUrl/login" -UseBasicParsing -TimeoutSec 15
    Write-Host "    $AppUrl/login responded $($res.StatusCode)." -ForegroundColor Green
} catch {
    Write-Host "[WARN] Could not reach $AppUrl/login from here: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`n==> $(if ($Install) { 'Setup' } else { 'Deploy' }) complete: $AppUrl`n" -ForegroundColor Green
