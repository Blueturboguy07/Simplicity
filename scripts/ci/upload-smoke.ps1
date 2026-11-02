# Upload smoke for /api/uploads. Runs ON WINDOWS in CI (windows-installer.yml,
# job upload-smoke) against the standalone server the installer ships.
#
# Starts .next/standalone with a fresh DATA_DIR, then POSTs a TXT, a PDF and a
# PNG using the Transformers embedding provider the server auto-registers.
# Expected: txt 200, pdf 200, png 415 with a message that names the file and
# the accepted types. Before the fix (v0.1.3) the PNG returned 500
# {"message":"An error has occurred."} — run 41374712334 on
# triage/simplicity-uploads recorded that.
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
# Write-Host + Add-Content, not Tee-Object: Tee-Object also emits to the
# pipeline, and a function's pipeline output becomes its return value.
function Note($text) { Write-Host $text; Add-Content -Path $log -Value $text }

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

# Returns "<body>|HTTP <code>"; the body is one JSON line.
function Up($file) {
  $t0 = Get-Date
  $out = & curl.exe -s --max-time 900 -w "`nHTTP %{http_code}" -F "files=@$file" -F "embedding_model_provider_id=$id" -F "embedding_model_key=$model" http://127.0.0.1:3117/api/uploads
  $secs = [int]((Get-Date) - $t0).TotalSeconds
  Note "--- $file ($secs s) ---"
  Note ($out -join "`n")
  $lines = ($out -join "`n") -split "`n"
  return @{ body = ($lines[0..($lines.Length - 2)] -join "`n"); code = $lines[-1].Trim() }
}

$fx = Join-Path $root 'scripts\ci\fixtures'
$txt = Up (Join-Path $fx 'notes.txt')
$pdf = Up (Join-Path $fx 'notes.pdf')
$png = Up (Join-Path $fx 'pic.png')

Stop-Process -Id $server.Id -Force
Start-Sleep -Seconds 2
Note '=== server.log ==='
if (Test-Path $serverOut) { Get-Content $serverOut | Tee-Object -FilePath $log -Append | Out-Null }
Note '=== server.err.log ==='
if (Test-Path $serverErr) { Get-Content $serverErr | Tee-Object -FilePath $log -Append | Out-Null }
Note "RESULT txt=$($txt.code) pdf=$($pdf.code) png=$($png.code)"

if ($txt.code -ne 'HTTP 200') { throw "txt upload did not return 200: $($txt.code)" }
if ($pdf.code -ne 'HTTP 200') { throw "pdf upload did not return 200: $($pdf.code)" }
if ($png.code -ne 'HTTP 415') { throw "png upload did not return 415: $($png.code)" }
$expected = 'pic.png: images are not supported yet. Upload a PDF, DOCX or TXT.'
if (-not $png.body.Contains($expected)) { throw "png 415 body does not carry the expected message: $($png.body)" }
Write-Host 'upload smoke OK (txt 200, pdf 200, png 415 with the accepted-types message)'
