# First model load on Windows (v0.1.6). Runs ON WINDOWS in CI
# (windows-installer.yml, job model-load-race) against the standalone server
# the installer ships, with a fresh DATA_DIR, so the upload downloads the
# embedding model and loads it right away.
#
# v0.1.5 failed that first load 1 time in 11 on Windows runners (run
# 41408225083): 500 "Upload failed: Load model from ...\model.onnx
# failed:system error number 13", and the uploads right after it failed the
# same way. transformers.js does not wait for the model file's write handle
# to close before onnxruntime opens the file.
#
# -Mode probe  makes the race happen every time (hold-model-file.cjs keeps the
#              write handle open) and checks:
#              A) handle held 3 s: the upload still returns 200;
#              B) handle held 40 s (longer than all retries): the upload
#                 returns 500 with the plain message and no path, and the
#                 next upload after the handle closes returns 200.
# -Mode stress repeats the real first load -Rounds times, each with a new
#              DATA_DIR and a new server process, and counts failures.
# Nothing here touches publik; no token or key is read or printed.
param(
  [ValidateSet('node', 'electron')][string]$Runtime = 'node',
  [ValidateSet('probe', 'stress')][string]$Mode = 'probe',
  [int]$Rounds = 8
)
$ErrorActionPreference = 'Stop'

$root = $PWD
$standalone = Join-Path $root '.next\standalone'
if (!(Test-Path (Join-Path $standalone 'server.js'))) { throw 'standalone server missing - run yarn build:desktop first' }

$exe = 'node'
if ($Runtime -eq 'electron') {
  $exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
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

function Start-Server([string]$tag, [int]$holdMs) {
  $data = Join-Path $env:RUNNER_TEMP "simplicity-race-$Runtime-$tag"
  if (Test-Path $data) { Remove-Item -Recurse -Force $data }
  New-Item -ItemType Directory -Force (Join-Path $data 'data') | Out-Null
  Copy-Item -Recurse -Force (Join-Path $root 'drizzle') (Join-Path $data 'drizzle')
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

if ($Mode -eq 'probe') {
  # A) write handle held 3 s after the download.
  $s = Start-Server 'hold3' 3000
  $a = Up $s $notes
  Stop-Server $s
  $errA = Read-Shared $s.err
  $heldA = (CountOf $errA '[ci-hold] holding') -ge 1
  $retriesA = CountOf $errA 'Embedding model file busy'
  Note "PROBE-A runtime=$Runtime hold=3000ms code=$($a.code) secs=$($a.secs) held=$heldA busyRetries=$retriesA body=$($a.body)"

  # B) write handle held 40 s: longer than every retry together.
  $s = Start-Server 'hold40' 40000
  $b1 = Up $s $notes
  $released = $false
  foreach ($i in 1..90) {
    if ((CountOf (Read-Shared $s.err) '[ci-hold] released') -ge 1) { $released = $true; break }
    Start-Sleep -Seconds 1
  }
  $b2 = Up $s $notes
  Stop-Server $s
  $errB = Read-Shared $s.err
  $heldB = (CountOf $errB '[ci-hold] holding') -ge 1
  $retriesB = CountOf $errB 'Embedding model file busy'
  Note "PROBE-B runtime=$Runtime hold=40000ms first: code=$($b1.code) secs=$($b1.secs) body=$($b1.body)"
  Note "PROBE-B runtime=$Runtime after release=$released next: code=$($b2.code) secs=$($b2.secs) held=$heldB busyRetries=$retriesB"

  Note '=== server-race hold3 err ==='
  Note $errA
  Note '=== server-race hold40 err ==='
  Note $errB

  $failures = @()
  if (-not $heldA -or -not $heldB) { $failures += 'probe did not engage (no [ci-hold] holding line)' }
  if ($a.code -ne 'HTTP 200') { $failures += "A: upload with the model file held 3 s returned $($a.code), not 200" }
  if ($retriesA -lt 1) { $failures += 'A: no busy retry logged - the race was not hit' }
  if ($b1.code -ne 'HTTP 500') { $failures += "B: upload with the model file held 40 s returned $($b1.code), not 500" }
  $b1msg = $null
  try { $b1msg = ($b1.body | ConvertFrom-Json).message } catch { }
  if ($b1msg -ne $plain) { $failures += "B: message is not the plain one: $($b1.body)" }
  if ($b1.body -match 'model\.onnx|Load model|system error|simplicity-race') { $failures += 'B: message shows the raw error or path' }
  if (-not $released) { $failures += 'B: hold was never released' }
  if ($b2.code -ne 'HTTP 200') { $failures += "B: next upload after the handle closed returned $($b2.code), not 200" }
  Note "RESULT mode=probe runtime=$Runtime A=$($a.code) B1=$($b1.code) B2=$($b2.code) failures=$($failures.Count)"
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
    $busy = CountOf $err 'Embedding model file busy'
    $recovered += $busy
    $is13 = $u.body -match 'system error number 13'
    if ($u.code -eq 'HTTP 200') { $ok++ } else { $fail++; if ($is13) { $fail13++ } }
    Note "STRESS-ROUND runtime=$Runtime round=$r code=$($u.code) secs=$($u.secs) busyRetries=$busy body=$($u.body)"
    if ($u.code -ne 'HTTP 200' -or $busy -gt 0) { Note $err }
    Remove-Item -Recurse -Force $s.data -ErrorAction SilentlyContinue
  }
  Note "RESULT mode=stress runtime=$Runtime rounds=$Rounds ok=$ok fail=$fail fail13=$fail13 busyRetriesRecovered=$recovered"
  if ($fail -gt 0) { throw "$fail of $Rounds first loads failed ($fail13 with system error number 13)" }
  Write-Host "first-load stress OK on $Runtime ($Rounds of $Rounds)"
}
