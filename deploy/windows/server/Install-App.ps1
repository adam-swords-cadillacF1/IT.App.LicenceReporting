<#
  Runs ON THE SERVER. Called by Update-App.ps1 on the first deploy, or rerun by deploy.ps1 -Install.
  1. Checks Node.js 24+ and that the port is free
  2. Locks the settings/data folder to SYSTEM and Administrators
  3. Creates app.env from the example the first time, and stops so you can fill it in
  4. Installs and starts the Windows Service
  5. Opens the port in Windows Firewall, but only when sign-in is set to Entra ID
  6. Installs the daily 00:10 snapshot task (Install-SnapshotTask.ps1)
#>
param(
    [string] $AppPath     = 'C:\Apps\LicenceReportingApp',
    [string] $ConfigRoot  = 'C:\ProgramData\LicenceReportingApp',
    [string] $ServiceName = 'LicenceReportingApp'
)

$ErrorActionPreference = 'Stop'

$nodeVersion = if (Get-Command node -ErrorAction SilentlyContinue) { node --version } else { $null }
if (-not $nodeVersion -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 24) {
    throw "Node.js 24 or later is required on the server (found: $(if ($nodeVersion) { $nodeVersion } else { 'none' }))."
}
Write-Host "    Node.js $nodeVersion" -ForegroundColor Gray

foreach ($dir in @($ConfigRoot, "$ConfigRoot\data", "$ConfigRoot\certs", "$ConfigRoot\backups", "$ConfigRoot\incoming")) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
}
# SID S-1-5-32-544 is the local Administrators group, whatever the server's language
# Subfolders inherit this; the drop folder keeps its deploy-user grant from Enable-SmbDeploy.ps1
icacls $ConfigRoot /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /Q | Out-Null
Write-Host "    $ConfigRoot locked to SYSTEM and Administrators." -ForegroundColor Gray
# The snapshot task runs Take-Snapshot.ps1 from the app folder as SYSTEM, so nobody else may change it
icacls $AppPath /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /Q | Out-Null
Write-Host "    $AppPath locked to SYSTEM and Administrators." -ForegroundColor Gray

$envFile = "$ConfigRoot\app.env"
if (-not (Test-Path $envFile)) {
    Copy-Item "$AppPath\deploy\windows\app.env.example" $envFile
    # New-EntraCertificate.ps1 may have run before app.env existed: take the thumbprint from the certificate it saved
    $cer = "$ConfigRoot\certs\entra-cert.cer"
    if (Test-Path $cer) {
        $sha256 = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($cer)) | ForEach-Object { $_.ToString('X2') })
        (Get-Content $envFile) -replace '^\s*ENTRA_CERT_THUMBPRINT\s*=.*$', "ENTRA_CERT_THUMBPRINT=$sha256" | Set-Content $envFile -Encoding ascii
        Write-Host "    ENTRA_CERT_THUMBPRINT filled in from $cer" -ForegroundColor Gray
    }
    Write-Host "`n[ACTION] Created $envFile from the example." -ForegroundColor Yellow
    Write-Host "         Fill it in (Entra IDs and certificate), put the certificates in" -ForegroundColor Yellow
    Write-Host "         $ConfigRoot\certs, then run: deploy.ps1 -Install" -ForegroundColor Yellow
    return
}
$settings = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } | ForEach-Object { $settings[$Matches[1]] = $Matches[2].Trim() }
$authMode = if ($settings['AUTH_MODE']) { $settings['AUTH_MODE'] } else { 'dev' }
$port = if ($settings['PORT']) { [int]$settings['PORT'] } else { 3003 }

# The session secret only has to be long and random, so create it rather than asking for one
if (-not $settings['SESSION_SECRET']) {
    $bytes = New-Object byte[] 48
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    $lines = Get-Content $envFile
    if ($lines -match '^\s*SESSION_SECRET\s*=') { $lines = $lines -replace '^\s*SESSION_SECRET\s*=.*$', "SESSION_SECRET=$secret" }
    else { $lines += "SESSION_SECRET=$secret" }
    Set-Content -Path $envFile -Value $lines -Encoding ascii
    Write-Host "    Generated SESSION_SECRET in app.env." -ForegroundColor Gray
}

$dataDir = if ($settings['DATA_DIR']) { $settings['DATA_DIR'] } else { "$ConfigRoot\data" }
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }
# Marks the real data folder, so scripts/sample-data.js refuses to write made-up snapshots into it
Set-Content -Path (Join-Path $dataDir 'PRODUCTION') -Value 'Production data. Do not run scripts/sample-data.js here.'

# Check everything Entra sign-in needs up front, and list all of it at once
if ($authMode -eq 'entra') {
    $missing = @(@('APP_URL', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID') | Where-Object { -not $settings[$_] })
    $hasCert = $settings['ENTRA_CERT_KEY_PATH'] -and $settings['ENTRA_CERT_THUMBPRINT']
    if (-not $hasCert -and -not $settings['ENTRA_CLIENT_SECRET']) {
        $missing += 'ENTRA_CERT_KEY_PATH + ENTRA_CERT_THUMBPRINT (or ENTRA_CLIENT_SECRET)'
    }
    if ($hasCert -and -not (Test-Path $settings['ENTRA_CERT_KEY_PATH'])) {
        $missing += "the Entra key file at $($settings['ENTRA_CERT_KEY_PATH'])"
    }
    if ($settings['APP_URL'] -match '^https://' -and -not $settings['TRUST_PROXY'] -and -not $settings['TLS_PFX_PATH'] -and -not $settings['TLS_CERT_PATH']) {
        $missing += 'TRUST_PROXY (behind the reverse proxy) or TLS_PFX_PATH'
    }
    if ($missing) {
        throw "app.env is missing: $($missing -join '; '). Fill these in at $envFile, then run deploy.ps1 -Install again."
    }
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
    $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($inUse) {
        $owner = (Get-Process -Id $inUse[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
        throw "Port $port is already in use by '$owner'. Pick another PORT in app.env."
    }
    Push-Location $AppPath
    $env:APP_CONFIG = $envFile
    $env:SERVICE_NAME = $ServiceName
    $env:SERVICE_PORT = $port
    node deploy\windows\install-service.js
    Pop-Location
    Start-Sleep -Seconds 5
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) { throw "Service '$ServiceName' was not created. Check the output above." }
} else {
    Write-Host "    Service '$ServiceName' already exists - restarting it." -ForegroundColor Yellow
    Restart-Service -Name $ServiceName -Force
}
# Get-Service also matches the display name, but Set-Service needs the real one (e.g. licencereportingapp.exe)
try { Set-Service -Name $service.Name -StartupType Automatic -ErrorAction Stop } catch {
    Write-Host "[WARN] Could not confirm Automatic startup: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Dev sign-in has no password and only listens on the server itself, so don't open the firewall for it
# FIREWALL_ALLOW_FROM limits who can reach the port, e.g. only the reverse proxy
$ruleName = "Licence Reporting (TCP $port)"
$allowFrom = if ($settings['FIREWALL_ALLOW_FROM']) { $settings['FIREWALL_ALLOW_FROM'] -split '\s*,\s*' } else { @('Any') }
if ($authMode -eq 'entra') {
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        Set-NetFirewallRule -DisplayName $ruleName -RemoteAddress $allowFrom -Profile Domain -Enabled True
    } else {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow `
            -Profile Domain -RemoteAddress $allowFrom | Out-Null
    }
    Write-Host "    Firewall: TCP $port open to $($allowFrom -join ', ') (Domain profile)." -ForegroundColor Gray
} else {
    Write-Host "[WARN] AUTH_MODE is '$authMode' - firewall left closed. Set AUTH_MODE=entra and run deploy.ps1 -Install." -ForegroundColor Yellow
}

& "$AppPath\deploy\windows\server\Install-SnapshotTask.ps1" -AppPath $AppPath -DataDir $dataDir

Start-Sleep -Seconds 3
$service.Refresh()
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($service.Status -eq 'Running' -and $listening) {
    Write-Host "    Service '$ServiceName' is running and listening on port $port." -ForegroundColor Green
} else {
    throw "Service status: $($service.Status); listening on $port`: $([bool]$listening). Logs: $AppPath\daemon\*.log, or Event Viewer > Application."
}
