#Requires -RunAsAdministrator
<#
  One-time setup ON THE SERVER (run in an elevated PowerShell over RDP or the console).
  Lets deploy.ps1 deploy from a Mac or PC over SMB, which needs no extra firewall rules.

    .\Enable-SmbDeploy.ps1 -DeployUsers 'HERMES\adam.swords'                 # a domain account (recommended)
    .\Enable-SmbDeploy.ps1 -DeployUsers 'HERMES\adam.swords','HERMES\someone.else'

  - Creates the drop folder C:\ProgramData\LicenceReportingApp\incoming
  - Shares it as \\<server>\LicenceReportingDeploy (SMB encryption required), writable by -DeployUsers only
  - Installs a scheduled task (SYSTEM, every minute) that runs each uploaded deploy and writes the log back

  Accounts are granted by name: Windows strips admin rights from local accounts signing in over the
  network, so membership of Administrators alone would not allow access.
#>
param(
    [Parameter(Mandatory)] [string[]] $DeployUsers,   # domain accounts; local admin accounts are often blocked over the network
    [string]   $ConfigRoot  = 'C:\ProgramData\LicenceReportingApp',
    [string]   $ShareName   = 'LicenceReportingDeploy',
    [string]   $AppPath     = 'C:\Apps\LicenceReportingApp',
    [string]   $ServiceName = 'LicenceReportingApp'
)

$ErrorActionPreference = 'Stop'
$incoming = "$ConfigRoot\incoming"
$bin      = "$ConfigRoot\bin"
$watcher  = "$bin\Watch-Incoming.ps1"

# 1. Folders. ConfigRoot is SYSTEM and Administrators only; deploy users get Modify on the drop folder only.
foreach ($dir in @($ConfigRoot, $incoming, "$incoming\results", $bin)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
}
icacls $ConfigRoot /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /Q | Out-Null
foreach ($user in $DeployUsers) {
    icacls $incoming /grant "${user}:(OI)(CI)M" /Q | Out-Null
}
Write-Host "==> Drop folder: $incoming (Modify for $($DeployUsers -join ', '))" -ForegroundColor Cyan

# 2. Share, encrypted, for the deploy users only
$share = Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue
if ($share -and $share.Path -ne $incoming) { throw "A share called $ShareName already exists for $($share.Path)." }
if (-not $share) {
    New-SmbShare -Name $ShareName -Path $incoming -ChangeAccess $DeployUsers -EncryptData $true `
        -FolderEnumerationMode AccessBased -Description 'Licence Reporting deploy drop folder' | Out-Null
} else {
    Get-SmbShareAccess -Name $ShareName | Where-Object { $_.AccountName -notin $DeployUsers } |
        ForEach-Object { Revoke-SmbShareAccess -Name $ShareName -AccountName $_.AccountName -Force | Out-Null }
    foreach ($user in $DeployUsers) { Grant-SmbShareAccess -Name $ShareName -AccountName $user -AccessRight Change -Force | Out-Null }
    Set-SmbShare -Name $ShareName -EncryptData $true -Force
}
Write-Host "==> Share: \\$env:COMPUTERNAME\$ShareName (encrypted)" -ForegroundColor Cyan

# 3. Watcher script. Lives outside the drop folder so deploy users can't change it.
@'
# Runs every minute as SYSTEM (scheduled task "<service> deploy"). Installed by Enable-SmbDeploy.ps1.
# For each <id>.ready file in the drop folder: runs the deploy or install it asks for, and writes
# results\<id>.log and results\<id>.done for deploy.ps1 to read back.
# The app folder and service come from the task, not the request, so each share only deploys its own copy.
param(
    [string] $ConfigRoot  = 'C:\ProgramData\LicenceReportingApp',
    [string] $AppPath     = 'C:\Apps\LicenceReportingApp',
    [string] $ServiceName = 'LicenceReportingApp'
)
$ErrorActionPreference = 'Stop'
$incoming = "$ConfigRoot\incoming"
$results  = "$incoming\results"

foreach ($marker in Get-ChildItem "$incoming\*.ready" -File | Sort-Object Name) {
    $id = $marker.BaseName
    if ($id -notmatch '^[A-Za-z0-9-]+$') { Remove-Item $marker.FullName -Force; continue }
    $raw = Get-Content $marker.FullName -Raw
    Remove-Item $marker.FullName -Force   # claim it so the next run doesn't pick it up again
    $work = "$incoming\$id"
    $log  = "$results\$id.log"
    try { $request = $raw | ConvertFrom-Json } catch {
        "[ERROR] Unreadable request: $($_.Exception.Message)" | Out-File $log -Encoding utf8
        @{ ok = $false; exitCode = -1; finished = (Get-Date).ToString('o') } | ConvertTo-Json | Out-File "$results\$id.done" -Encoding utf8
        continue
    }
    if ($request.action -eq 'install') {
        $script = "$AppPath\deploy\windows\server\Install-App.ps1"
        $scriptArgs = @('-AppPath', $AppPath, '-ConfigRoot', $ConfigRoot, '-ServiceName', $ServiceName)
    } else {
        $script = "$work\Update-App.ps1"
        $scriptArgs = @('-Package', "$work\package.tgz", '-AppPath', $AppPath, '-ConfigRoot', $ConfigRoot, '-ServiceName', $ServiceName)
    }

    $code = 1
    try {
        if (-not (Test-Path $script)) { throw "Missing $script" }
        # Separate process with redirected output, so stderr lines can't abort this script mid-deploy
        $argList = @('-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', "`"$script`"") + ($scriptArgs | ForEach-Object { "`"$_`"" })
        $proc = Start-Process powershell.exe -ArgumentList $argList -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $log -RedirectStandardError "$log.err"
        $code = $proc.ExitCode
        if ((Test-Path "$log.err") -and (Get-Item "$log.err").Length) { Get-Content "$log.err" | Out-File $log -Append -Encoding utf8 }
        Remove-Item "$log.err" -ErrorAction SilentlyContinue
    } catch {
        "[ERROR] $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
    }
    @{ ok = ($code -eq 0); exitCode = $code; finished = (Get-Date).ToString('o') } | ConvertTo-Json |
        Out-File "$results\$id.done" -Encoding utf8
    if (Test-Path $work) { Remove-Item $work -Recurse -Force }
}

# Tidy old results and abandoned uploads
Get-ChildItem $results -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item -Force
Get-ChildItem $incoming -Directory | Where-Object { $_.Name -ne 'results' -and $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
    Remove-Item -Recurse -Force
'@ | Set-Content -Path $watcher -Encoding utf8

# 4. Scheduled task: every minute, as SYSTEM, one run at a time
$taskName = "$ServiceName deploy"
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy RemoteSigned -File `"$watcher`" -ConfigRoot `"$ConfigRoot`" -AppPath `"$AppPath`" -ServiceName `"$ServiceName`""
$trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "==> Scheduled task '$taskName' checks the drop folder every minute." -ForegroundColor Cyan

Write-Host "`n==> SMB deploys are ready on \\$env:COMPUTERNAME\$ShareName." -ForegroundColor Green
