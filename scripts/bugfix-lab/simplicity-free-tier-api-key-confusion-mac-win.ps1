<#
  bugfix-lab repro script — cluster simplicity-free-tier-api-key-confusion-mac-win
  (break ee8a15fb-c190-ff70-768f-9e40f1ccc678)

  Question this answers, on a clean Windows machine that has never had Ollama
  (exactly the state a new Simplicity user is in):

      The onboarding "Choose a provider" screen shows an Ollama row badged
      "Free" whose blurb reads "Free - runs on your computer. No account, no
      key, nothing to pay.", with an Install button. If the user clicks that
      button and nothing else, do they end up with a working free provider?

  It drives the app's OWN endpoint, the one ProviderPicker.install() posts to:

      src/components/Setup/ProviderPicker.tsx
        const res = await fetch('/api/local-runtime/ollama', { method: 'POST',
          ... body: JSON.stringify({ tier }) });
        ... if (ev.phase === 'error') throw new Error(ev.message);
            if (ev.phase === 'done')  { setProviders(...); 'Local AI is ready.' }

  So the ndjson this script captures is byte-for-byte what the running UI
  consumes: a {"phase":"done"} event is the user seeing "Local AI is ready."
  and a connected provider; a {"phase":"error"} event is the red panel the
  Aug 10 fix added, with the user still holding zero working providers.

  Exit codes (the oracle contract):
    1 = bug PRESENT  (the free path did not complete)
    0 = bug ABSENT   (the free path completed with no key and no manual work)
    2 = could not run (toolchain failed, or the runner was not in the
        no-Ollama state this scenario requires)
#>

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Say($m) { Write-Host "[bugfix-lab] $m" }

Say "commit  : $(git rev-parse HEAD)"
Say "os      : $([System.Environment]::OSVersion.VersionString)"
Say "node    : $(node --version)"
Say "cwd     : $(Get-Location)"

# ---------------------------------------------------------------- precondition
# A fresh user has no Ollama. If the runner happens to ship one, findBinary()
# would short-circuit the download entirely and this scenario would not be the
# reporters'. Prove the state rather than assume it.
$onPath = & cmd /c "where ollama" 2>&1
Say "where ollama -> $onPath"
$hasPath = ($LASTEXITCODE -eq 0)

$cands = @(
  (Join-Path $PWD 'bin\ollama.exe'),
  "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
  "$env:ProgramFiles\Ollama\ollama.exe"
)
$hasCand = $false
foreach ($c in $cands) {
  $e = Test-Path $c
  Say "exists $c -> $e"
  if ($e) { $hasCand = $true }
}

$serving = $false
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 4 -UseBasicParsing
  $serving = $true
  Say "port 11434 -> HTTP $($r.StatusCode) (something is already serving!)"
} catch {
  Say "port 11434 -> nothing answering (expected on a fresh machine)"
}

if ($hasPath -or $hasCand -or $serving) {
  Say "BUGFIX_LAB_INDETERMINATE: this runner already has Ollama; not the fresh-user state"
  exit 2
}

# ---------------------------------------------------------------- toolchain
if (-not (Get-Command yarn -ErrorAction SilentlyContinue)) {
  Say "installing yarn"
  & cmd /c "npm.cmd install -g yarn" 2>&1 | Out-String | Write-Host
}
Say "yarn    : $(& cmd /c 'yarn.cmd --version' 2>&1)"

Say "yarn install (this is the guide's own 'Install dependencies' step)"
& cmd /c "yarn.cmd install --frozen-lockfile" 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) {
  Say "BUGFIX_LAB_INDETERMINATE: yarn install failed ($LASTEXITCODE)"
  exit 2
}

# ConfigManager writes data/config.json but never creates the directory.
New-Item -ItemType Directory -Force -Path (Join-Path $PWD 'data') | Out-Null

# ---------------------------------------------------------------- run the app
Say "starting the app's server (next dev on :3000)"
$dev = Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', 'yarn.cmd dev -p 3000 > dev.log 2>&1' `
  -PassThru -WindowStyle Hidden

$ready = $false
for ($i = 0; $i -lt 300; $i++) {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $ready) {
  Say "BUGFIX_LAB_INDETERMINATE: server never came up"
  if (Test-Path dev.log) { Get-Content dev.log -Tail 60 | Write-Host }
  if ($dev -and -not $dev.HasExited) { Stop-Process -Id $dev.Id -Force }
  exit 2
}
Say "server is up"

# The app's own view of this machine (GET half of the same route) — this is
# what tells the UI whether there is anything to connect to yet.
$status = & curl.exe -s --max-time 300 'http://127.0.0.1:3000/api/local-runtime/ollama'
Say "GET /api/local-runtime/ollama -> $status"

# ---------------------------------------------------------------- the click
Say "POST /api/local-runtime/ollama {tier:fast}  <-- the Ollama row's Install button"
$stream = & curl.exe -s --no-buffer --max-time 1800 `
  -X POST -H 'Content-Type: application/json' `
  -d '{\"tier\":\"fast\"}' `
  'http://127.0.0.1:3000/api/local-runtime/ollama'
$streamText = ($stream | Out-String)
Say "--- install stream (ndjson, verbatim) ---"
Write-Host $streamText
Say "--- end stream ---"
Set-Content -Path 'install-stream.ndjson' -Value $streamText

if (Test-Path dev.log) {
  Say "--- server log tail ---"
  Get-Content dev.log -Tail 40 | Write-Host
}

# Did the user end up with a connected provider? Ask the app, not the stream.
$providers = & curl.exe -s --max-time 120 'http://127.0.0.1:3000/api/providers'
Say "GET /api/providers after the click -> $providers"

if ($dev -and -not $dev.HasExited) { Stop-Process -Id $dev.Id -Force }

# ---------------------------------------------------------------- verdict
$hasOllamaProvider = ($providers -match '"type"\s*:\s*"ollama"')

if ($streamText -match '"phase"\s*:\s*"done"' -and $hasOllamaProvider) {
  Say "the free path completed: the app reports a connected ollama provider"
  Say "BUGFIX_LAB_ABSENT"
  exit 0
}

if ($streamText -match '"phase"\s*:\s*"error"') {
  $msg = ([regex]::Match($streamText, '"message"\s*:\s*"([^"]*)"')).Groups[1].Value
  Say "the free path FAILED. The red panel under the Ollama row reads:"
  Say "    $msg"
  Say "providers connected after clicking the free option: ollama present = $hasOllamaProvider"
  Say "BUGFIX_LAB_PRESENT"
  exit 1
}

Say "BUGFIX_LAB_INDETERMINATE: neither a done nor an error event was streamed"
exit 2
