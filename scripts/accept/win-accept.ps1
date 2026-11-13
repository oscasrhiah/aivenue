# Windows acceptance of one candidate's packages: portable and installer (current user, silent, into a temp folder),
# each started with its own empty AIVENUE_HOME and checked by capabilities-check.mjs (next to this script) for the
# expected version and commit; then the installer's own uninstaller. The per-machine install in
# C:\Program Files\Aivenue is hashed before and after and never touched.
#   pwsh win-accept.ps1 -Kit <folder with the two .exe> -Out <results folder> -Version <expected version> -Commit <full sha>
param([Parameter(Mandatory)][string]$Kit, [Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Commit)
$ErrorActionPreference = 'Stop'
$check = Join-Path $PSScriptRoot 'capabilities-check.mjs'
$work = Join-Path $env:TEMP ('aivenue-win-accept-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work, $Out | Out-Null
$log = Join-Path $Out 'win-accept.log'
function Say($m) { $m | Tee-Object -FilePath $log -Append | Write-Host }
function MachineState {
  $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -EA SilentlyContinue | Where-Object { $_.DisplayName -like '*Aivenue*' } | ForEach-Object { "$($_.PSChildName)=$($_.DisplayName)" }
  $h = Get-FileHash 'C:\Program Files\Aivenue\Aivenue.exe', 'C:\Program Files\Aivenue\resources\app.asar' | ForEach-Object { $_.Hash.Substring(0, 16) }
  "$($reg -join ',') exe=$($h[0]) asar=$($h[1])"
}
function UserEntries { @(Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -EA SilentlyContinue | Where-Object { $_.DisplayName -like '*Aivenue*' }) }
function StopOurs($prefix) {
  # Only the copies under test: never the per-machine install.
  for ($i = 0; $i -lt 10; $i++) {
    $p = @(Get-Process -EA SilentlyContinue | Where-Object { $_.Path -and $_.Path -notlike 'C:\Program Files\Aivenue\*' -and ($_.ProcessName -like 'Aivenue*') })
    if (-not $p.Count) { return 0 }
    $p | Stop-Process -Force -EA SilentlyContinue
    Start-Sleep -Milliseconds 700
  }
  return @(Get-Process -EA SilentlyContinue | Where-Object { $_.Path -and $_.Path -notlike 'C:\Program Files\Aivenue\*' -and ($_.ProcessName -like 'Aivenue*') }).Count
}
function Launch($exe, $name, $port) {
  $data = Join-Path $work "home-$name"
  New-Item -ItemType Directory -Force $data | Out-Null
  $env:AIVENUE_HOME = $data
  $env:WANT_DATA_DIR = $data
  $env:WANT_VERSION = $Version
  Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port" | Out-Null
  $r = & node $check $port $Commit $Out $name 2>&1
  $code = $LASTEXITCODE
  $r | ForEach-Object { Say $_ }
  Remove-Item Env:AIVENUE_HOME, Env:WANT_DATA_DIR, Env:WANT_VERSION
  $left = StopOurs | Select-Object -Last 1
  Say "  $(if ($left -eq 0) { 'PASS' } else { 'FAIL' })  ${name}: app closed, $left process(es) left"
  $files = @(Get-ChildItem -Recurse -File $data -EA SilentlyContinue).Count
  Say "        ${name}: AIVENUE_HOME $data now holds $files file(s)"
  return $code
}

$before = MachineState
Say "Per-machine install before: $before"
Say "Current-user Aivenue entries before: $((UserEntries).Count)"
$fails = 0

Say '=== Portable'
if ((Launch (Join-Path $Kit "Aivenue-$Version-portable.exe") 'portable' 9333) -ne 0) { $fails++ }

Say '=== Installer (current user, silent)'
$inst = Join-Path $work 'installed-app'
$p = Start-Process -FilePath (Join-Path $Kit "Aivenue-Setup-$Version.exe") -ArgumentList '/S', '/currentuser', "/D=$inst" -Wait -PassThru
Say "  $(if ($p.ExitCode -eq 0 -and (Test-Path (Join-Path $inst 'Aivenue.exe'))) { 'PASS' } else { $fails++; 'FAIL' })  install exit $($p.ExitCode), Aivenue.exe in $inst"
$entries = UserEntries
Say "        current-user entries: $($entries.Count) ($(($entries | ForEach-Object { "$($_.DisplayName) at $($_.InstallLocation)" }) -join '; '))"
Say "        per-machine after install: $(MachineState)"
if (Test-Path (Join-Path $inst 'Aivenue.exe')) {
  if ((Launch (Join-Path $inst 'Aivenue.exe') 'installer' 9334) -ne 0) { $fails++ }
  $un = Get-ChildItem $inst -Filter 'Uninstall*.exe' | Select-Object -First 1
  $q = Start-Process -FilePath $un.FullName -ArgumentList '/S', '/currentuser' -Wait -PassThru
  for ($i = 0; $i -lt 60 -and (Test-Path (Join-Path $inst 'Aivenue.exe')); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 2
  $desk = Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Aivenue.lnk')
  $menu = Test-Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'Aivenue.lnk')
  $gone = -not (Test-Path (Join-Path $inst 'Aivenue.exe'))
  $ue = (UserEntries).Count
  Say "  $(if ($q.ExitCode -eq 0 -and $gone -and $ue -eq 0 -and -not $desk -and -not $menu) { 'PASS' } else { $fails++; 'FAIL' })  uninstall exit $($q.ExitCode); program removed $gone; current-user entries $ue; desktop shortcut $desk; Start menu shortcut $menu"
}
$after = MachineState
Say "  $(if ($after -eq $before) { 'PASS' } else { $fails++; 'FAIL' })  per-machine install unchanged: $after"
Say "Summary: $fails failed"
Remove-Item -Recurse -Force $work -EA SilentlyContinue
exit $fails
