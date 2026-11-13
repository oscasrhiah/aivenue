# What would keep the Windows installer test from running without touching the user's own Aivenue: a silent
# current-user install writes the current user's uninstall entry and the shortcuts Desktop\Aivenue.lnk and
# Start menu\Programs\Aivenue.lnk (electron-builder's NSIS defaults), replacing any the user has; its uninstall then
# deletes them. So when any of these is already there, the installer is not tested at all.
# Dot-sourced by win-accept.ps1; scripts/test-accept.mjs drives it with made-up folders.

function Get-UserEntries {
  @(Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -EA SilentlyContinue | Where-Object { $_.DisplayName -like '*Aivenue*' })
}

# The shortcuts the installer makes for the current user.
function Get-ShortcutPaths([string]$Desktop = [Environment]::GetFolderPath('Desktop'), [string]$Programs = [Environment]::GetFolderPath('Programs')) {
  @((Join-Path $Desktop 'Aivenue.lnk'), (Join-Path $Programs 'Aivenue.lnk'))
}

# Why the installer test must not run here (nothing: it may).
function Get-InstallBlockers([int]$Entries = (Get-UserEntries).Count, [string[]]$Shortcuts = (Get-ShortcutPaths)) {
  $why = @()
  if ($Entries -gt 0) { $why += "a current-user Aivenue is already installed ($Entries uninstall entr$(if ($Entries -eq 1) { 'y' } else { 'ies' }))" }
  foreach ($s in $Shortcuts) { if (Test-Path -LiteralPath $s) { $why += "a shortcut $s already exists (the install would replace it and the uninstall delete it)" } }
  return , $why
}
