<#
 bugfix-lab oracle body for simplicity-windows-server-not-responding.

 Population: direct-download. Reproduces report gh-simplicity-8: install the
 published Windows release, launch it, and watch the shell's own log file
 (written by desktop/main.mjs's log()) for either the startup failure or a
 successful load.

 IMPORTANT: the reporter's log (issue body, verbatim) has NO SearXNG
 first-time-setup lines -- it starts directly at "Starting Simplicity...".
 A truly first launch on a fresh machine always prints those setup lines
 first (confirmed in run 1 of this oracle, 2026-09-23: ~48s of SearXNG
 download/unpack before "Starting Simplicity..." ever appears). So the
 reporter's failure happened on a launch where SearXNG was already
 provisioned, i.e. NOT the very first launch. To match that, this script
 launches the app TWICE: the first launch absorbs the one-time SearXNG setup
 (not scored), then the app is closed and relaunched, and only the SECOND
 launch's log segment (everything after the last "Starting Simplicity" line)
 is scored against the failure text.

 Accepts an optional release tag (defaults to v0.1.3, the tag report
 gh-simplicity-8's population actually ran -- also usable to install an
 OLDER tag for a negative control) or a local exe path.

 -StressCpu (default on): the first REPRODUCE attempt found the server
 answering isServing() well within the 60s internal timeout on a clean,
 idle windows-latest runner (both launches), and flagged "CPU/disk
 contention on the reporter's machine" as an unconfirmed hypothesis for why
 a single real user hit the 60s cliff and CI does not. This flag tests that
 hypothesis directly: it saturates every logical processor with background
 PowerShell jobs (tight busy-loops) for the duration of launch 2 only, to
 model a loaded end-user machine (AV scan, other apps, background updates)
 without touching the app itself. If the failure still never appears under
 real CPU starvation, that is much stronger evidence toward not_reproduced.
#>
param(
  [string]$Tag = "v0.1.3",
  [string]$LocalExe = "",
  [bool]$StressCpu = $true
)

$ErrorActionPreference = 'Stop'

function Write-Marker($state, $reason) {
  Write-Host "---"
  Write-Host "BUGFIX_LAB_$state`: $reason"
}

function Get-LastLaunchSegment($path) {
  if (-not (Test-Path $path)) { return $null }
  $content = Get-Content -Path $path -Raw -ErrorAction SilentlyContinue
  if (-not $content) { return $null }
  $idx = $content.LastIndexOf('Starting Simplicity')
  if ($idx -lt 0) { return $null }
  return $content.Substring($idx)
}

function Find-LogPath($searchRoots) {
  foreach ($root in $searchRoots) {
    $candidate = Join-Path $root 'logs\simplicity.log'
    if (Test-Path $candidate) { return $candidate }
  }
  $found = Get-ChildItem -Path $env:APPDATA -Filter 'simplicity.log' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Simplicity'
if (Test-Path $installDir) {
  $existingUn = Join-Path $installDir 'Uninstall Simplicity.exe'
  if (Test-Path $existingUn) {
    Start-Process -FilePath $existingUn -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 5
  }
}

if ($LocalExe -ne "") {
  $setup = $LocalExe
  if (!(Test-Path $setup)) { throw "LocalExe path does not exist: $setup" }
} else {
  $setup = Join-Path $env:RUNNER_TEMP 'Simplicity-Setup-Windows.exe'
  $url = "https://github.com/Blueturboguy07/Simplicity/releases/download/$Tag/Simplicity-Setup-Windows.exe"
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $setup -UseBasicParsing
}

if (!(Test-Path $setup)) { throw "installer was not found at $setup" }
Write-Host "Installer: $setup ($((Get-Item $setup).Length) bytes)"

Write-Host "Installing silently..."
Start-Process -FilePath $setup -ArgumentList '/S' -Wait

$exe = Join-Path $installDir 'Simplicity.exe'
if (!(Test-Path $exe)) { throw "Simplicity.exe missing after install -- installer itself is broken, not this cluster" }
Write-Host "Installed: $exe"

$searchRoots = @(
  (Join-Path $env:APPDATA 'Simplicity'),
  (Join-Path $env:APPDATA 'vane')
)

# ---- Launch 1: absorb the one-time SearXNG setup, not scored ----
Write-Host "=== Launch 1 (absorbs first-run SearXNG setup) ==="
$proc1 = Start-Process -FilePath $exe -PassThru
Write-Host "PID: $($proc1.Id)"

$logPath = $null
$deadline1 = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $deadline1) {
  if (-not $logPath) { $logPath = Find-LogPath $searchRoots }
  if ($logPath) {
    $seg = Get-LastLaunchSegment $logPath
    if ($seg -and ($seg -match "server started but isn't responding" -or $seg -match 'Ready in')) { break }
  }
  if ($proc1.HasExited) { Write-Host "Launch 1 process exited early with code $($proc1.ExitCode)"; break }
  Start-Sleep -Seconds 3
}

if ($logPath) {
  Write-Host "--- launch 1 segment so far ---"
  Get-LastLaunchSegment $logPath | Write-Host
  Write-Host "--- end launch 1 segment ---"
} else {
  Write-Host "No simplicity.log found yet after launch 1 (searched $($searchRoots -join ', ') and recursive $env:APPDATA)"
}

Write-Host "Closing launch 1..."
if (-not $proc1.HasExited) {
  try { $proc1.CloseMainWindow() | Out-Null } catch {}
  $closedDeadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $closedDeadline -and -not $proc1.HasExited) { Start-Sleep -Seconds 2 }
  if (-not $proc1.HasExited) {
    Write-Host "Graceful close did not exit in time -- force killing"
    try { Stop-Process -Id $proc1.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}
Start-Sleep -Seconds 5

# ---- Launch 2: this is what the oracle scores (matches the reporter's log shape) ----
$stressJobs = @()
if ($StressCpu) {
  $cpuCount = [Environment]::ProcessorCount
  Write-Host "=== Starting CPU stress: $cpuCount background busy-loop job(s) (ProcessorCount=$cpuCount) ==="
  for ($i = 0; $i -lt $cpuCount; $i++) {
    $stressJobs += Start-Job -ScriptBlock {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $x = 0.0
      # Runs until the parent stops the job (below); busy-loop pegs one core.
      while ($true) { $x = [Math]::Sqrt($x + 1.0) }
    }
  }
  Start-Sleep -Seconds 2
  Write-Host "Stress jobs running: $($stressJobs.Count)"
}

Write-Host "=== Launch 2 (scored) ==="
$proc2 = Start-Process -FilePath $exe -PassThru
Write-Host "PID: $($proc2.Id)"

$deadline2 = (Get-Date).AddSeconds(150)
$sawFailure = $false
$sawSuccess = $false
$failureLine = ""

while ((Get-Date) -lt $deadline2) {
  if (-not $logPath) { $logPath = Find-LogPath $searchRoots }
  if ($logPath) {
    $seg = Get-LastLaunchSegment $logPath
    if ($seg -match "server started but isn't responding") {
      $sawFailure = $true
      $failureLine = ($seg -split "`n" | Select-String -SimpleMatch "server started but isn't responding" | Select-Object -First 1).ToString()
      break
    }
  }
  if ($proc2.HasExited) { Write-Host "Launch 2 process exited early with code $($proc2.ExitCode)"; break }
  Start-Sleep -Seconds 3
}

$finalSeg = if ($logPath) { Get-LastLaunchSegment $logPath } else { $null }
if (-not $sawFailure -and $finalSeg) {
  if ($finalSeg -match "server started but isn't responding") {
    $sawFailure = $true
    $failureLine = ($finalSeg -split "`n" | Select-String -SimpleMatch "server started but isn't responding" | Select-Object -First 1).ToString()
  } elseif ($finalSeg -match 'Ready in') {
    $sawSuccess = $true
  }
}

if ($logPath) {
  Write-Host "=== $logPath (launch 2 segment) ==="
  Write-Host $finalSeg
  Write-Host "=== end log ==="
} else {
  Write-Host "No simplicity.log was ever found under $($searchRoots -join ', ') or via recursive search of $env:APPDATA"
}

try { Stop-Process -Id $proc2.Id -Force -ErrorAction SilentlyContinue } catch {}

if ($stressJobs.Count -gt 0) {
  Write-Host "=== Stopping CPU stress jobs ==="
  $stressJobs | Stop-Job -PassThru | Remove-Job -Force
}

if ($sawFailure) {
  Write-Marker "PRESENT" "launch 2 log shows: $failureLine"
  exit 1
} elseif ($sawSuccess) {
  Write-Marker "ABSENT" "launch 2 log shows Ready with no server-started-but-not-responding failure within the 150s observation window"
  exit 0
} else {
  Write-Marker "ABSENT" "could not confirm PRESENT on launch 2: no failure line found (log path: $logPath); treating as inconclusive-toward-absent, see stdout above"
  exit 2
}
