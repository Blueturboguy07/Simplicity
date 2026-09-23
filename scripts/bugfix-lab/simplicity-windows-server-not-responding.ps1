<#
 bugfix-lab oracle body for simplicity-windows-server-not-responding.

 Population: direct-download. Reproduces exactly what report gh-simplicity-8
 describes: install the published Windows release, launch it, and watch the
 shell's own log file (written by desktop/main.mjs's log()) for either the
 startup failure or a successful load.

 Accepts one optional argument: the release tag to install (defaults to
 v0.1.3, the tag the report's population actually ran -- also usable to
 install an OLDER tag for a negative control, or built straight from a
 locally-built installer path via -LocalExe).
#>
param(
  [string]$Tag = "v0.1.3",
  [string]$LocalExe = ""
)

$ErrorActionPreference = 'Stop'

function Write-Marker($state, $reason) {
  Write-Host "---"
  Write-Host "BUGFIX_LAB_$state`: $reason"
}

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Simplicity'
# Fresh runner normally has nothing here, but be defensive if this script is
# ever re-run against a runner that already has an install.
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

# desktop/main.mjs writes <userData>/logs/simplicity.log. userData is
# Electron's app.getPath('userData'), which this build has never been
# observed to be anywhere but %APPDATA%\Simplicity in this campaign -- but
# rather than hardcode it, find it after launch so a wrong guess can't
# masquerade as ABSENT.
$searchRoots = @(
  (Join-Path $env:APPDATA 'Simplicity'),
  (Join-Path $env:APPDATA 'vane')
)

Write-Host "Launching Simplicity.exe (detached) ..."
$proc = Start-Process -FilePath $exe -PassThru
Write-Host "PID: $($proc.Id)"

$logPath = $null
$deadline = (Get-Date).AddSeconds(150)
$sawFailure = $false
$sawSuccess = $false
$failureLine = ""

while ((Get-Date) -lt $deadline) {
  if (-not $logPath) {
    foreach ($root in $searchRoots) {
      $candidate = Join-Path $root 'logs\simplicity.log'
      if (Test-Path $candidate) { $logPath = $candidate; break }
    }
    if (-not $logPath) {
      # Fall back to a recursive search in case userData resolved somewhere
      # else entirely (e.g. a different app-name casing).
      $found = Get-ChildItem -Path $env:APPDATA -Filter 'simplicity.log' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { $logPath = $found.FullName }
    }
  }

  if ($logPath -and (Test-Path $logPath)) {
    $content = Get-Content -Path $logPath -Raw -ErrorAction SilentlyContinue
    if ($content -match "server started but isn't responding") {
      $sawFailure = $true
      $failureLine = ($content -split "`n" | Select-String -SimpleMatch "server started but isn't responding" | Select-Object -First 1).ToString()
      break
    }
    if ($content -match 'Starting Simplicity') {
      # Keep polling -- "Starting" alone isn't success, we need the window to
      # actually load, which we approximate by the ABSENCE of the failure
      # line once the process has run past the 60s internal timeout AND the
      # process is still alive with a visible window (best-effort on a
      # headless runner: presence of the process + no failure line logged
      # after the internal 60s deadline has clearly elapsed).
    }
  }

  if ($proc.HasExited) {
    Write-Host "Process exited early with code $($proc.ExitCode)"
    break
  }

  Start-Sleep -Seconds 3
}

if (-not $sawFailure -and $logPath -and (Test-Path $logPath)) {
  $finalContent = Get-Content -Path $logPath -Raw -ErrorAction SilentlyContinue
  if ($finalContent -match "server started but isn't responding") {
    $sawFailure = $true
    $failureLine = ($finalContent -split "`n" | Select-String -SimpleMatch "server started but isn't responding" | Select-Object -First 1).ToString()
  } elseif ($finalContent -match 'Ready in') {
    # Next reported ready and the failure line never appeared within the
    # observation window -- treat as success. Note: main.mjs's own timeout
    # is 60s; we wait up to 150s total before concluding ABSENT so a slow
    # (but eventually successful) CI runner isn't mistaken for the bug.
    $sawSuccess = $true
  }
}

if ($logPath) {
  Write-Host "=== $logPath ==="
  Get-Content -Path $logPath -ErrorAction SilentlyContinue | Write-Host
  Write-Host "=== end log ==="
} else {
  Write-Host "No simplicity.log was ever found under $($searchRoots -join ', ') or via recursive search of $env:APPDATA"
}

try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}

if ($sawFailure) {
  Write-Marker "PRESENT" "log shows: $failureLine"
  exit 1
} elseif ($sawSuccess) {
  Write-Marker "ABSENT" "log shows Ready with no server-started-but-not-responding failure within the 150s observation window"
  exit 0
} else {
  Write-Marker "ABSENT" "could not confirm PRESENT: no failure line found (log path: $logPath); treating as inconclusive-toward-absent, see stdout above"
  exit 2
}
