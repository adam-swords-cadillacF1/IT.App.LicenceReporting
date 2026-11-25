<#
  Runs ON THE SERVER. Called by Install-App.ps1 (first deploy, or deploy.ps1 -Install); safe to rerun.
  Installs the "LicenceReporting snapshot" scheduled task: every day at 00:10, as SYSTEM, it runs
  snapshot\Take-Snapshot.ps1, which reads the licence groups from AD and hands the snapshot to the app.

  - Runs as SYSTEM, so no password is stored. On a domain-joined server SYSTEM reads AD as the computer
    account, which (like any domain account) can read group members, names, email, job title and department.
    If your AD restricts that, use -RunAsUser with a read-only service account (it asks for the password).
  - StartWhenAvailable: if the server was off at 00:10, the task runs as soon as it is back.
  - Retries for groups that fail are inside the script (Task Scheduler's own retry ignores exit codes).
  - The app's "Take snapshot now" button starts this same task.
#>
param(
    [string] $AppPath  = 'C:\Apps\LicenceReportingApp',
    [string] $DataDir  = 'C:\ProgramData\LicenceReportingApp\data',
    [string] $TaskName = 'LicenceReporting snapshot',
    [string] $At       = '00:10',
    [string] $Server,                 # optional: a specific domain controller
    [string] $RunAsUser               # optional: DOMAIN\account instead of SYSTEM
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $AppPath 'snapshot\Take-Snapshot.ps1'
if (-not (Test-Path $script)) { throw "Missing $script" }

if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
    throw 'The ActiveDirectory PowerShell module is not installed. Install it with: Install-WindowsFeature RSAT-AD-PowerShell'
}
$tz = (Get-TimeZone).Id
if ($tz -ne 'GMT Standard Time') {
    Write-Host "[WARN] This server's time zone is '$tz', so 00:10 is 00:10 in that zone, not UK time." -ForegroundColor Yellow
}

$arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$script`" -DataDir `"$DataDir`""
if ($Server) { $arguments += " -Server `"$Server`"" }
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $AppPath
$trigger  = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

if ($RunAsUser) {
    $cred = Get-Credential -UserName $RunAsUser -Message "Password for $RunAsUser (runs the daily snapshot)"
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
    $who = $RunAsUser
} else {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    $who = 'SYSTEM'
}
Write-Host "    Scheduled task '$TaskName': daily at $At as $who ($tz)." -ForegroundColor Gray
Write-Host "    Snapshot log: $DataDir\logs\snapshot-<date>.log" -ForegroundColor Gray
