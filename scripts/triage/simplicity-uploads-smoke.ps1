# Triage smoke for the simplicity-uploads lane. Runs ON WINDOWS in CI.
#
# Starts the standalone server that the installer ships (.next/standalone),
# with a fresh DATA_DIR, then POSTs a TXT, a PDF and a PNG to /api/uploads
# using the Transformers embedding provider the server auto-registers.
# Nothing here touches publik; no token or key is read or printed.
$ErrorActionPreference = 'Stop'

$root = $PWD
$standalone = Join-Path $root '.next\standalone'
if (!(Test-Path (Join-Path $standalone 'server.js'))) { throw 'standalone server missing - run yarn build:desktop first' }

$data = Join-Path $env:RUNNER_TEMP 'simplicity-data'
New-Item -ItemType Directory -Force (Join-Path $data 'data') | Out-Null
Copy-Item -Recurse -Force (Join-Path $root 'drizzle') (Join-Path $data 'drizzle')

$env:DATA_DIR = $data
$env:PORT = '3117'
$env:HOSTNAME = '127.0.0.1'
$env:NODE_ENV = 'production'

$serverOut = Join-Path $root 'server.log'
$serverErr = Join-Path $root 'server.err.log'
$server = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory $standalone `
  -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -NoNewWindow

$log = Join-Path $root 'upload-smoke.log'
function Note($text) { $text | Tee-Object -FilePath $log -Append }

$providers = $null
foreach ($i in 1..90) {
  try { $providers = Invoke-RestMethod 'http://127.0.0.1:3117/api/providers' -TimeoutSec 5; break } catch { Start-Sleep -Seconds 2 }
}
if (-not $providers) { Stop-Process -Id $server.Id -Force; throw 'server did not come up on 127.0.0.1:3117' }

$t = $providers.providers | Where-Object { $_.type -eq 'transformers' } | Select-Object -First 1
if (-not $t) { Stop-Process -Id $server.Id -Force; throw 'no transformers provider registered' }
$id = $t.id
$model = $t.embeddingModels[0].key
Note "transformers provider $id model $model"

function Up($file) {
  $t0 = Get-Date
  $out = & curl.exe -s --max-time 900 -w "`nHTTP %{http_code}" -F "files=@$file" -F "embedding_model_provider_id=$id" -F "embedding_model_key=$model" http://127.0.0.1:3117/api/uploads
  $secs = [int]((Get-Date) - $t0).TotalSeconds
  Note "--- $file ($secs s) ---"
  Note ($out -join "`n")
  $lines = ($out -join "`n") -split "`n"
  return $lines[-1].Trim()
}

$fx = Join-Path $root 'scripts\triage\fixtures'
$txt = Up (Join-Path $fx 'notes.txt')
$pdf = Up (Join-Path $fx 'notes.pdf')
$png = Up (Join-Path $fx 'pic.png')

Stop-Process -Id $server.Id -Force
Start-Sleep -Seconds 2
Note '=== server.log ==='
if (Test-Path $serverOut) { Get-Content $serverOut | Tee-Object -FilePath $log -Append | Out-Null }
Note '=== server.err.log ==='
if (Test-Path $serverErr) { Get-Content $serverErr | Tee-Object -FilePath $log -Append | Out-Null }
Note "RESULT txt=$txt pdf=$pdf png=$png"

if ($txt -ne 'HTTP 200') { throw "txt upload did not return 200: $txt" }
if ($pdf -ne 'HTTP 200') { throw "pdf upload did not return 200: $pdf" }
if ($png -ne 'HTTP 500') { throw "png upload did not return 500 as the current code does: $png" }
Write-Host 'upload smoke matches the expected current behaviour (txt 200, pdf 200, png 500)'
