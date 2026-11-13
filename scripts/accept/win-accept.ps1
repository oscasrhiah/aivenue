# Windows acceptance of one candidate's packages: portable and installer (current user, silent, into a temp folder),
# each started with its own empty AIVENUE_HOME and checked by capabilities-check.mjs (next to this script) for the
# expected version and commit; then the installer's own uninstaller.
# The user's own Aivenue is left alone: the per-machine install in C:\Program Files\Aivenue is hashed before and after
# and never touched; only the processes this script started are stopped (win-procs.ps1: the launched process and its
# descendants, running from this run's folders), never others with the same name; and the installer test does not
# run when a current-user Aivenue is already installed or an Aivenue.lnk is already on the Desktop or in the Start
# menu (win-guards.ps1: a silent current-user install would replace them, and its uninstall delete them).
#   pwsh win-accept.ps1 -Kit <folder with the two .exe> -Out <results folder> -Version <expected version> -Commit <full sha>
param([Parameter(Mandatory)][string]$Kit, [Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Commit)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'win-procs.ps1')
. (Join-Path $PSScriptRoot 'win-guards.ps1')
$check = Join-Path $PSScriptRoot 'capabilities-check.mjs'
$work = Join-Path $env:TEMP ('aivenue-win-accept-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work, $Out | Out-Null
$log = Join-Path $Out 'win-accept.log'
function Say($m) { $m | Tee-Object -FilePath $log -Append | Write-Host }
function MachineState {
  $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -EA SilentlyContinue | Where-Object { $_.DisplayName -like '*Aivenue*' } | ForEach-Object { "$($_.PSChildName)=$($_.DisplayName)" }
  $files = 'C:\Program Files\Aivenue\Aivenue.exe', 'C:\Program Files\Aivenue\resources\app.asar'
  if (-not (Test-Path $files[0])) { return "$($reg -join ',') (no per-machine install)" }
  $h = Get-FileHash $files | ForEach-Object { $_.Hash.Substring(0, 16) }
  "$($reg -join ',') exe=$($h[0]) asar=$($h[1])"
}
function Launch($exe, $name, $port, [string[]]$allowed) {
  $data = Join-Path $work "home-$name"
  New-Item -ItemType Directory -Force $data | Out-Null
  $env:AIVENUE_HOME = $data
  $env:WANT_DATA_DIR = $data
  $env:WANT_VERSION = $Version
  # A second of slack: the process's own start time is what is compared.
  $since = (Get-Date).AddSeconds(-1)
  $proc = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port" -PassThru
  $r = & node $check $port $Commit $Out $name 2>&1
  $code = $LASTEXITCODE
  $r | ForEach-Object { Say $_ }
  Remove-Item Env:AIVENUE_HOME, Env:WANT_DATA_DIR, Env:WANT_VERSION
  $left = Stop-Ours $proc.Id $since $allowed | Select-Object -Last 1
  Say "  $(if ($left -eq 0) { 'PASS' } else { 'FAIL' })  ${name}: app closed (only what this run started, PID $($proc.Id) and its descendants), $left process(es) left"
  $files = @(Get-ChildItem -Recurse -File $data -EA SilentlyContinue).Count
  Say "        ${name}: AIVENUE_HOME $data now holds $files file(s)"
  return $code
}

$before = MachineState
Say "Per-machine install before: $before"
Say "Current-user Aivenue entries before: $((Get-UserEntries).Count)"
$blockers = Get-InstallBlockers
$fails = 0

Say '=== Portable'
# The launcher runs from the kit and unpacks the app under %TEMP%.
if ((Launch (Join-Path $Kit "Aivenue-$Version-portable.exe") 'portable' 9333 @($Kit, $env:TEMP)) -ne 0) { $fails++ }

Say '=== Installer (current user, silent)'
if ($blockers.Count) {
  # The user's own entry or shortcuts would be replaced by the install, then removed by the uninstall: not tested.
  $fails++
  Say "  FAIL  installer not tested, so nothing of the user's is replaced or deleted: $($blockers -join '; ')"
} else {
  $inst = Join-Path $work 'installed-app'
  $p = Start-Process -FilePath (Join-Path $Kit "Aivenue-Setup-$Version.exe") -ArgumentList '/S', '/currentuser', "/D=$inst" -Wait -PassThru
  Say "  $(if ($p.ExitCode -eq 0 -and (Test-Path (Join-Path $inst 'Aivenue.exe'))) { 'PASS' } else { $fails++; 'FAIL' })  install exit $($p.ExitCode), Aivenue.exe in $inst"
  $entries = Get-UserEntries
  Say "        current-user entries: $($entries.Count) ($(($entries | ForEach-Object { "$($_.DisplayName) at $($_.InstallLocation)" }) -join '; '))"
  Say "        per-machine after install: $(MachineState)"
  if (Test-Path (Join-Path $inst 'Aivenue.exe')) {
    if ((Launch (Join-Path $inst 'Aivenue.exe') 'installer' 9334 @($inst)) -ne 0) { $fails++ }
    $un = Get-ChildItem $inst -Filter 'Uninstall*.exe' | Select-Object -First 1
    $q = Start-Process -FilePath $un.FullName -ArgumentList '/S', '/currentuser' -Wait -PassThru
    for ($i = 0; $i -lt 60 -and (Test-Path (Join-Path $inst 'Aivenue.exe')); $i++) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
    # None of them was there before (else the test would not have run): the uninstall must leave none.
    $desk, $menu = Get-ShortcutPaths | ForEach-Object { Test-Path -LiteralPath $_ }
    $gone = -not (Test-Path (Join-Path $inst 'Aivenue.exe'))
    $ue = (Get-UserEntries).Count
    Say "  $(if ($q.ExitCode -eq 0 -and $gone -and $ue -eq 0 -and -not $desk -and -not $menu) { 'PASS' } else { $fails++; 'FAIL' })  uninstall exit $($q.ExitCode); program removed $gone; current-user entries $ue; desktop shortcut $desk; Start menu shortcut $menu"
  }
}
$after = MachineState
Say "  $(if ($after -eq $before) { 'PASS' } else { $fails++; 'FAIL' })  per-machine install unchanged: $after"
Say "Summary: $fails failed"
Remove-Item -Recurse -Force $work -EA SilentlyContinue
exit $fails
