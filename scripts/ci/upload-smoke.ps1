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
#
# -Runtime electron runs the same server.js with Electron's own binary as
# node (ELECTRON_RUN_AS_NODE), which is what the installed app does. The
# 1.12.3 smoke on a Mac showed crashes that only happen there: one large
# onnxruntime allocation traps (SIGTRAP) under Electron, so an upload of a
# long file, or a big embedding model, killed the server while plain node
# answered 200. The long-file upload below covers that, and the cache check
# covers models being written into the app folder instead of DATA_DIR.
param([ValidateSet('node', 'electron')][string]$Runtime = 'node')
$ErrorActionPreference = 'Stop'

$root = $PWD
$standalone = if ($env:SIMPLICITY_CI_STANDALONE) { $env:SIMPLICITY_CI_STANDALONE } else { Join-Path $root '.next\standalone' }
$drizzleSrc = if ($env:SIMPLICITY_CI_DRIZZLE) { $env:SIMPLICITY_CI_DRIZZLE } else { Join-Path $root 'drizzle' }
if (!(Test-Path (Join-Path $standalone 'server.js'))) { throw 'standalone server missing - run yarn build:desktop first' }

$data = Join-Path $env:RUNNER_TEMP "simplicity-data-$Runtime"
New-Item -ItemType Directory -Force (Join-Path $data 'data') | Out-Null
Copy-Item -Recurse -Force $drizzleSrc (Join-Path $data 'drizzle')

$port = if ($Runtime -eq 'electron') { '3118' } else { '3117' }
$base = "http://127.0.0.1:$port"
$env:DATA_DIR = $data
$env:PORT = $port
$env:HOSTNAME = '127.0.0.1'
$env:NODE_ENV = 'production'

$exe = 'node'
if ($Runtime -eq 'electron') {
  $exe = if ($env:SIMPLICITY_CI_ELECTRON_EXE) { $env:SIMPLICITY_CI_ELECTRON_EXE } else { Join-Path $root 'node_modules\electron\dist\electron.exe' }
  # yarn install leaves the binary out here (electron-builder fetches its
  # own copy), so fetch the exact version from package.json the same way
  # electron's postinstall does.
  if (!(Test-Path $exe)) { & node (Join-Path $root 'node_modules\electron\install.js') }
  if (!(Test-Path $exe)) { throw "electron binary missing at $exe" }
  $env:ELECTRON_RUN_AS_NODE = '1'
}

$serverOut = Join-Path $root "server-$Runtime.log"
$serverErr = Join-Path $root "server-$Runtime.err.log"
$server = Start-Process -FilePath $exe -ArgumentList 'server.js' -WorkingDirectory $standalone `
  -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -NoNewWindow

$log = Join-Path $root "upload-smoke-$Runtime.log"

# Write-Host + Add-Content, not Tee-Object: Tee-Object also emits to the
# pipeline, and a function's pipeline output becomes its return value.
function Note($text) { Write-Host $text; Add-Content -Path $log -Value $text }

Note "runtime $Runtime ($exe)"
$providers = $null
foreach ($i in 1..90) {
  try { $providers = Invoke-RestMethod "$base/api/providers" -TimeoutSec 5; break } catch { Start-Sleep -Seconds 2 }
}
if (-not $providers) { Stop-Process -Id $server.Id -Force; throw "server did not come up on $base" }

$t = $providers.providers | Where-Object { $_.type -eq 'transformers' } | Select-Object -First 1
if (-not $t) { Stop-Process -Id $server.Id -Force; throw 'no transformers provider registered' }
$id = $t.id
$model = $t.embeddingModels[0].key
Note "transformers provider $id model $model"

# Returns "<body>|HTTP <code>"; the body is one JSON line.
function Up($file) {
  $t0 = Get-Date
  $out = & curl.exe -s --max-time 900 -w "`nHTTP %{http_code}" -F "files=@$file" -F "embedding_model_provider_id=$id" -F "embedding_model_key=$model" "$base/api/uploads"
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

# A long file: ~200 chunks. Before 1.12.4 they went to onnxruntime in one
# call, which crashed the server under Electron at ~100 chunks.
$long = Join-Path $env:RUNNER_TEMP "long-$Runtime.txt"
$para = ('The lighthouse keeper counted 212 steps every morning and wrote the weather in a blue notebook. ' * 25)
$sb = New-Object System.Text.StringBuilder
foreach ($i in 1..200) { [void]$sb.AppendLine("Section $i. $para") }
[void]$sb.AppendLine('The code word is MARIGOLD-5519.')
[System.IO.File]::WriteAllText($long, $sb.ToString())
$big = Up $long
$alive = -not $server.HasExited
Note "server alive after the long upload: $alive"

# Models must land in DATA_DIR\models, never in the app's own folder.
$cacheInData = Test-Path (Join-Path $data 'models\Xenova\all-MiniLM-L6-v2')
$cacheInApp = Test-Path (Join-Path $standalone 'node_modules\@huggingface\transformers\.cache')
Note "model cache in DATA_DIR\models: $cacheInData; in the app folder: $cacheInApp"

if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
Start-Sleep -Seconds 2
Note '=== server.log ==='
if (Test-Path $serverOut) { Get-Content $serverOut | Tee-Object -FilePath $log -Append | Out-Null }
Note '=== server.err.log ==='
if (Test-Path $serverErr) { Get-Content $serverErr | Tee-Object -FilePath $log -Append | Out-Null }
Note "RESULT runtime=$Runtime txt=$($txt.code) pdf=$($pdf.code) png=$($png.code) long=$($big.code)"

if ($txt.code -ne 'HTTP 200') { throw "txt upload did not return 200: $($txt.code)" }
if ($pdf.code -ne 'HTTP 200') { throw "pdf upload did not return 200: $($pdf.code)" }
if ($png.code -ne 'HTTP 415') { throw "png upload did not return 415: $($png.code)" }
$expected = 'pic.png: images are not supported yet. Upload a PDF, DOCX or TXT.'
if (-not $png.body.Contains($expected)) { throw "png 415 body does not carry the expected message: $($png.body)" }
if ($big.code -ne 'HTTP 200') { throw "long txt upload did not return 200: $($big.code)" }
if (-not $alive) { throw 'server died during the long upload' }
if (-not $cacheInData) { throw 'embedding model was not cached in DATA_DIR\models' }
if ($cacheInApp) { throw 'embedding model was written into the app folder (.next\standalone)' }
Write-Host "upload smoke OK on $Runtime (txt 200, pdf 200, png 415 with the accepted-types message, long txt 200, cache in DATA_DIR)"

