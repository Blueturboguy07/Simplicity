# First model load on Windows (v0.1.6). Runs ON WINDOWS in CI
# (windows-installer.yml, job model-load-race) against the standalone server
# the installer ships, with a fresh DATA_DIR, so the upload downloads the
# embedding model and loads it right away.
#
# v0.1.5 failed that first load 1 time in 11 on Windows runners (run
# 41408225083): 500 "Upload failed: Load model from ...\model.onnx
# failed:system error number 13", and the uploads right after it failed the
# same way. transformers.js did not wait for the model file's write handle to
# close before onnxruntime opened the file "deny others write". v0.1.6 gives
# onnxruntime the model as bytes, read by Node, so onnxruntime never opens it.
#
# -Mode probe  makes the race happen every time (hold-model-file.cjs keeps a
#              second handle open on model.onnx) and checks:
#              A) fresh install, a write handle on the new model file for 3 s:
#                 the first upload returns 200;
#              C) model already downloaded, a write handle on it for 40 s from
#                 server start: the upload returns 200;
#              B) model already downloaded, this script holds it with .NET
#                 FileShare.None (no other open works) during the upload: the
#                 upload returns 500 with the plain message and no path after
#                 all retries, and the next upload after the handle closes
#                 returns 200.
# -Mode stress repeats the real first load -Rounds times, each with a new
#              DATA_DIR and a new server process, then starts the server once
#              more on the same DATA_DIR and uploads again (model from disk),
#              and counts failures.
# Nothing here touches publik; no token or key is read or printed.
param(
  [ValidateSet('node', 'electron')][string]$Runtime = 'node',
  [ValidateSet('probe', 'stress')][string]$Mode = 'probe',
  [int]$Rounds = 8
)
$ErrorActionPreference = 'Stop'

$root = $PWD
$standalone = if ($env:SIMPLICITY_CI_STANDALONE) { $env:SIMPLICITY_CI_STANDALONE } else { Join-Path $root '.next\standalone' }
$drizzleSrc = if ($env:SIMPLICITY_CI_DRIZZLE) { $env:SIMPLICITY_CI_DRIZZLE } else { Join-Path $root 'drizzle' }
if (!(Test-Path (Join-Path $standalone 'server.js'))) { throw 'standalone server missing - run yarn build:desktop first' }

$exe = 'node'
if ($Runtime -eq 'electron') {
  $exe = if ($env:SIMPLICITY_CI_ELECTRON_EXE) { $env:SIMPLICITY_CI_ELECTRON_EXE } else { Join-Path $root 'node_modules\electron\dist\electron.exe' }
  if (!(Test-Path $exe)) { & node (Join-Path $root 'node_modules\electron\install.js') }
  if (!(Test-Path $exe)) { throw "electron binary missing at $exe" }
}
$port = if ($Runtime -eq 'electron') { '3128' } else { '3127' }
$base = "http://127.0.0.1:$port"
$hold = (Join-Path $root 'scripts\ci\hold-model-file.cjs') -replace '\\', '/'
$plain = 'Simplicity could not load its file model. Try the upload again.'

$log = Join-Path $root "model-load-race-$Mode-$Runtime.log"
function Note($text) { Write-Host $text; Add-Content -Path $log -Value $text }

# The server still has its log files open for writing.
function Read-Shared($path) {
  if (!(Test-Path $path)) { return '' }
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try { return (New-Object System.IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
}

function CountOf($text, $needle) { return ([regex]::Matches($text, [regex]::Escape($needle))).Count }

# $keep: start on the DATA_DIR of an earlier round as it is (model on disk).
function Start-Server([string]$tag, [int]$holdMs, [string]$keep = '') {
  $data = Join-Path $env:RUNNER_TEMP "simplicity-race-$Runtime-$tag"
  if ($keep) {
    $data = $keep
  } else {
    if (Test-Path $data) { Remove-Item -Recurse -Force $data }
    New-Item -ItemType Directory -Force (Join-Path $data 'data') | Out-Null
    Copy-Item -Recurse -Force $drizzleSrc (Join-Path $data 'drizzle')
  }
  $env:DATA_DIR = $data
  $env:PORT = $port
  $env:HOSTNAME = '127.0.0.1'
  $env:NODE_ENV = 'production'
  if ($Runtime -eq 'electron') { $env:ELECTRON_RUN_AS_NODE = '1' }
  if ($holdMs -gt 0) {
    $env:SIMPLICITY_CI_HOLD_MODEL_MS = "$holdMs"
    $env:NODE_OPTIONS = "--require $hold"
  }
  $out = Join-Path $root "server-race-$Runtime-$tag.log"
  $err = Join-Path $root "server-race-$Runtime-$tag.err.log"
  $p = Start-Process -FilePath $exe -ArgumentList 'server.js' -WorkingDirectory $standalone `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -NoNewWindow
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  Remove-Item Env:SIMPLICITY_CI_HOLD_MODEL_MS -ErrorAction SilentlyContinue

  $providers = $null
  foreach ($i in 1..120) {
    try { $providers = Invoke-RestMethod "$base/api/providers" -TimeoutSec 5; break } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $providers) { Stop-Process -Id $p.Id -Force; throw "server did not come up on $base" }
  $t = $providers.providers | Where-Object { $_.type -eq 'transformers' } | Select-Object -First 1
  if (-not $t) { Stop-Process -Id $p.Id -Force; throw 'no transformers provider registered' }
  return @{ proc = $p; err = $err; data = $data; id = $t.id; model = $t.embeddingModels[0].key }
}

function Stop-Server($s) {
  if (-not $s.proc.HasExited) { Stop-Process -Id $s.proc.Id -Force }
  $s.proc.WaitForExit(15000) | Out-Null
  Start-Sleep -Milliseconds 500
}

# Returns @{ code; body; secs }; the body is one JSON line.
function Up($s, $file) {
  $t0 = Get-Date
  $out = & curl.exe -s --max-time 300 -w "`nHTTP %{http_code}" -F "files=@$file" -F "embedding_model_provider_id=$($s.id)" -F "embedding_model_key=$($s.model)" "$base/api/uploads"
  $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $lines = ($out -join "`n") -split "`n"
  return @{ body = ($lines[0..($lines.Length - 2)] -join "`n"); code = $lines[-1].Trim(); secs = $secs }
}

$notes = Join-Path $root 'scripts\ci\fixtures\notes.txt'
Note "runtime $Runtime ($exe) mode $Mode"

function WaitReleased($s) {
  foreach ($i in 1..90) {
    if ((CountOf (Read-Shared $s.err) '[ci-hold] released') -ge 1) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function MsgOf($u) {
  try { return ($u.body | ConvertFrom-Json).message } catch { return $null }
}

if ($Mode -eq 'probe') {
  $failures = @()

  # A) fresh install: a write handle on model.onnx for 3 s from the moment
  #    the file exists (v0.1.5 failed here every time).
  $s = Start-Server 'hold3' 3000
  $a = Up $s $notes
  $released = WaitReleased $s
  Stop-Server $s
  $errA = Read-Shared $s.err
  $heldA = (CountOf $errA '[ci-hold] holding') -ge 1
  $retriesA = CountOf $errA 'Embedding model file busy'
  Note "PROBE-A runtime=$Runtime hold=write/3000ms code=$($a.code) secs=$($a.secs) held=$heldA busyRetries=$retriesA body=$($a.body)"
  if (-not $heldA) { $failures += 'A: probe did not engage (no [ci-hold] holding line)' }
  if ($a.code -ne 'HTTP 200') { $failures += "A: first upload with a write handle on the model file returned $($a.code), not 200" }
  $cached = $s.data

  # C) model on disk, a write handle on it for 40 s from server start.
  $s = Start-Server 'hold40w' 40000 $cached
  $c = Up $s $notes
  Stop-Server $s
  $errC = Read-Shared $s.err
  $heldC = (CountOf $errC '[ci-hold] holding') -ge 1
  $retriesC = CountOf $errC 'Embedding model file busy'
  Note "PROBE-C runtime=$Runtime hold=write/40000ms code=$($c.code) secs=$($c.secs) held=$heldC busyRetries=$retriesC body=$($c.body)"
  if (-not $heldC) { $failures += 'C: probe did not engage (no [ci-hold] holding line)' }
  if ($c.code -ne 'HTTP 200') { $failures += "C: upload with a write handle on the downloaded model returned $($c.code), not 200" }

  # B) model on disk, locked by this script (FileShare.None) during the
  #    upload: every try fails; after the handle closes the next upload works.
  $modelFile = Join-Path $cached 'models\Xenova\all-MiniLM-L6-v2\onnx\model.onnx'
  $s = Start-Server 'lock' 0 $cached
  $lock = [System.IO.File]::Open($modelFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
  $lockedNow = $false
  try { [System.IO.File]::Open($modelFile, 'Open', 'Read', 'ReadWrite, Delete').Close() } catch { $lockedNow = $true }
  $b1 = Up $s $notes
  $lock.Close()
  $b2 = Up $s $notes
  Stop-Server $s
  $errB = Read-Shared $s.err
  $retriesB = CountOf $errB 'Embedding model file busy'
  Note "PROBE-B runtime=$Runtime lock=FileShare.None lockedCheck=$lockedNow first: code=$($b1.code) secs=$($b1.secs) busyRetries=$retriesB body=$($b1.body)"
  Note "PROBE-B runtime=$Runtime after close next: code=$($b2.code) secs=$($b2.secs)"
  if (-not $lockedNow) { $failures += 'B: the FileShare.None lock did not block a shared read' }
  if ($b1.code -ne 'HTTP 500') { $failures += "B: upload with the model file locked returned $($b1.code), not 500" }
  if ((MsgOf $b1) -ne $plain) { $failures += "B: message is not the plain one: $($b1.body)" }
  if ($b1.body -match 'model\.onnx|Load model|system error|EBUSY|EACCES|EPERM|simplicity-race') { $failures += 'B: message shows the raw error or path' }
  if ($b2.code -ne 'HTTP 200') { $failures += "B: next upload after the lock closed returned $($b2.code), not 200" }

  Note '=== server-race hold3 err ==='
  Note $errA
  Note '=== server-race hold40w err ==='
  Note $errC
  Note '=== server-race lock err ==='
  Note $errB

  Note "RESULT mode=probe runtime=$Runtime A=$($a.code) C=$($c.code) B1=$($b1.code) B2=$($b2.code) failures=$($failures.Count)"
  Remove-Item -Recurse -Force $cached -ErrorAction SilentlyContinue
  if ($failures.Count -gt 0) { throw ($failures -join '; ') }
  Write-Host "model-load probe OK on $Runtime"
}
else {
  $ok = 0; $fail = 0; $fail13 = 0; $recovered = 0
  foreach ($r in 1..$Rounds) {
    $s = Start-Server "s$r" 0
    $u = Up $s $notes
    Stop-Server $s
    $err = Read-Shared $s.err
    # Second start on the same DATA_DIR: the model now comes from disk.
    $s2 = Start-Server "s${r}d" 0 $s.data
    $u2 = Up $s2 $notes
    Stop-Server $s2
    $err2 = Read-Shared $s2.err
    $busy = (CountOf $err 'Embedding model file busy') + (CountOf $err2 'Embedding model file busy')
    $recovered += $busy
    foreach ($x in @($u, $u2)) {
      if ($x.code -eq 'HTTP 200') { $ok++ } else { $fail++; if ($x.body -match 'system error number 13') { $fail13++ } }
    }
    Note "STRESS-ROUND runtime=$Runtime round=$r first=$($u.code) secs=$($u.secs) fromDisk=$($u2.code) secs=$($u2.secs) busyRetries=$busy body=$($u.body) | $($u2.body)"
    if ($u.code -ne 'HTTP 200' -or $u2.code -ne 'HTTP 200' -or $busy -gt 0) { Note $err; Note $err2 }
    Remove-Item -Recurse -Force $s.data -ErrorAction SilentlyContinue
  }
  $loads = 2 * $Rounds
  Note "RESULT mode=stress runtime=$Runtime rounds=$Rounds loads=$loads ok=$ok fail=$fail fail13=$fail13 busyRetriesRecovered=$recovered"
  if ($fail -gt 0) { throw "$fail of $loads model loads failed ($fail13 with system error number 13)" }
  Write-Host "first-load stress OK on $Runtime ($loads of $loads)"
}
