# Which processes a Windows acceptance run may stop: only the ones it started itself (the process it launched and
# everything descended from it), and of those only the ones running from a folder the run owns. A user's own Aivenue
# (installed per machine or per user, or a portable copy anywhere) is never selected, even with the same name.
# Dot-sourced by win-accept.ps1; scripts/test-accept.mjs drives it with stand-in processes.

function Test-Under([string]$Path, [string[]]$Folders) {
  if (-not $Path) { return $false }
  $full = [IO.Path]::GetFullPath($Path)
  foreach ($f in $Folders) {
    if (-not $f) { continue }
    $d = [IO.Path]::GetFullPath($f).TrimEnd('\') + '\'
    if ($full.StartsWith($d, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# The process IDs in the tree of $Known: those processes and everything descended from them, by parent PID. Only
# processes started at or after $Since count, so a PID the system gave to something else later is not followed. A
# parent that has ended still leads to its children (they keep its PID as their parent).
function Get-TreeIds([int[]]$Known, [datetime]$Since) {
  $all = @(Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $_.CreationDate -ge $Since })
  $ids = [System.Collections.Generic.List[int]]::new()
  foreach ($k in $Known) { if (-not $ids.Contains($k)) { $ids.Add($k) } }
  for ($i = 0; $i -lt $ids.Count; $i++) {
    foreach ($c in $all) {
      if ($c.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) }
    }
  }
  return , $ids
}

# The live processes of that tree that run from one of $Allowed (and never from the per-machine install).
function Select-Ours([int[]]$Known, [datetime]$Since, [string[]]$Allowed) {
  $ids = Get-TreeIds $Known $Since
  @(Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object {
      $ids.Contains([int]$_.ProcessId) -and $_.CreationDate -ge $Since -and (Test-Under $_.ExecutablePath $Allowed) -and
      -not (Test-Under $_.ExecutablePath @("$env:ProgramFiles\Aivenue"))
    } | ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Path = $_.ExecutablePath } })
}

# Stops what Select-Ours finds for the launched process $Root, until none is left (a closing app may still start a
# helper); remembers every PID it saw, so the children of a process it stopped are still found. Returns how many are
# left.
function Stop-Ours([int]$Root, [datetime]$Since, [string[]]$Allowed) {
  $known = [System.Collections.Generic.List[int]]::new()
  $known.Add($Root)
  for ($i = 0; $i -lt 10; $i++) {
    foreach ($id in (Get-TreeIds $known.ToArray() $Since)) { if (-not $known.Contains($id)) { $known.Add($id) } }
    $p = @(Select-Ours $known.ToArray() $Since $Allowed)
    if (-not $p.Count) { return 0 }
    $p | ForEach-Object { Stop-Process -Id $_.Id -Force -EA SilentlyContinue }
    Start-Sleep -Milliseconds 700
  }
  return @(Select-Ours $known.ToArray() $Since $Allowed).Count
}
