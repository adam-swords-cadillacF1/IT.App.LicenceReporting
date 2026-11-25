<#
  Runs ON THE SERVER, started by the deploy scheduled task (see Enable-SmbDeploy.ps1). Not normally run by hand.
  Stops the service, backs up the code and database, swaps in the uploaded package and starts it again.
  The first time (no service yet) it hands over to Install-App.ps1.
#>
param(
    [Parameter(Mandatory)] [string] $Package,
    [string] $AppPath     = 'C:\Apps\LicenceReportingApp',
    [string] $ConfigRoot  = 'C:\ProgramData\LicenceReportingApp',
    [string] $ServiceName = 'LicenceReportingApp',
    [int]    $KeepBackups = 10
)

$ErrorActionPreference = 'Stop'
$staging = "$ConfigRoot\staging"

Write-Host "==> Unpacking $(Split-Path $Package -Leaf)..." -ForegroundColor Cyan
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
tar -xzf $Package -C $staging
if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$staging\server.js")) { throw "Package did not unpack correctly." }

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

Write-Host "==> Stopping service and backing up..." -ForegroundColor Cyan
# Stopped first so the SQLite database is complete on disk before it is copied
if ($service -and $service.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
$backup = Join-Path "$ConfigRoot\backups" (Get-Date -Format 'yyyy-MM-dd_HH-mm-ss')
if (Test-Path $AppPath)           { robocopy $AppPath "$backup\app" /E /XD node_modules daemon /NFL /NDL /NJH /NJS /NP | Out-Null }
if (Test-Path "$ConfigRoot\data") { robocopy "$ConfigRoot\data" "$backup\data" /E /NFL /NDL /NJH /NJS /NP | Out-Null }
Get-ChildItem "$ConfigRoot\backups" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -Skip $KeepBackups | Remove-Item -Recurse -Force
Write-Host "    Backup: $backup" -ForegroundColor Gray

Write-Host "==> Installing new version to $AppPath..." -ForegroundColor Cyan
# /MIR removes files that are no longer in the package; daemon holds the service wrapper, so keep it
robocopy $staging $AppPath /MIR /XD daemon /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit $LASTEXITCODE). Restore from $backup if needed." }
Remove-Item $staging -Recurse -Force
Remove-Item $Package -Force

if (-not $service) {
    Write-Host "==> First install: setting up the service..." -ForegroundColor Cyan
    & "$AppPath\deploy\windows\server\Install-App.ps1" -AppPath $AppPath -ConfigRoot $ConfigRoot -ServiceName $ServiceName
    return
}

Start-Service -Name $ServiceName
Start-Sleep -Seconds 3
$status = (Get-Service -Name $ServiceName).Status
if ($status -ne 'Running') { throw "Service '$ServiceName' is $status. Logs: $AppPath\daemon\*.log" }
Write-Host "    Service '$ServiceName' is running." -ForegroundColor Green
