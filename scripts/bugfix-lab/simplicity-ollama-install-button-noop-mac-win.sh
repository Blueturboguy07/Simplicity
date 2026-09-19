#!/bin/bash
# Runs INSIDE the bugfix-lab GitHub Actions job (macos-latest, no pre-existing
# Ollama). Drives the real onboarding UI exactly as a reader would: opens the
# app fresh, waits for "Choose a provider", clicks Install on the Ollama row,
# and checks whether a failed install is surfaced (inline banner / toast) or
# silent (bug present).
#
# Forcing function: DATA_DIR/bin is pre-created as a plain FILE, not a
# directory. downloadBinary()'s own first statement -- fs.mkdirSync(dir,
# {recursive:true}) -- then throws a real, synchronous EEXIST before any
# network call. This is a deterministic, fast, real failure of the same
# "the local install path is unusable" shape a locked-down data directory
# would produce; it exercises the real catch block / SSE error frame /
# React state, not a source-level tautology. On this fresh runner
# findBinary()'s `which ollama` and its hardcoded fallback paths
# (/usr/local/bin/ollama, /opt/homebrew/bin/ollama, ...) all genuinely miss,
# so nothing here can accidentally reach a real Ollama daemon.
set -euo pipefail

PORT=3131
LOG_DEV="$RUNNER_TEMP/dev-server.log"
LOG_JSON="$RUNNER_TEMP/check-result.json"

echo "== commit under test =="
git log -1 --format='%H %ci %s'

echo "== confirm no Ollama pre-installed on this runner =="
which ollama 2>&1 && { echo "UNEXPECTED: ollama found on PATH"; exit 2; } || echo "ollama not on PATH (expected, fresh runner)"
for p in /usr/local/bin/ollama /opt/homebrew/bin/ollama "$HOME/.local/bin/ollama" /Applications/Ollama.app/Contents/Resources/ollama; do
  if [ -e "$p" ]; then echo "UNEXPECTED: $p exists"; exit 2; fi
done
echo "confirmed clean"

echo "== forcing device: bin as a file, not a directory =="
rm -rf bin
: > bin
ls -la bin

echo "== starting dev server on :$PORT =="
npm run dev -- -p "$PORT" >"$LOG_DEV" 2>&1 &
DEV_PID=$!
echo "dev server pid: $DEV_PID"

cleanup() { kill -9 "$DEV_PID" 2>/dev/null || true; }
trap cleanup EXIT

READY=0
for i in $(seq 1 60); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "dev server never became ready -- log:"
  cat "$LOG_DEV"
  echo "BUGFIX_LAB_RESULT=ORACLE_COULD_NOT_RUN"
  exit 2
fi
echo "-- dev server ready --"
grep -E "migrations|Ready" "$LOG_DEV" | tail -10 || true

echo "== driving the UI with headless Chromium =="
ORACLE_URL="http://localhost:$PORT/" ORACLE_TIMEOUT_MS=45000 \
  node scripts/bugfix-lab/check-install-button.mjs | tee "$LOG_JSON"

echo "== dev server log (last 30 lines) =="
tail -30 "$LOG_DEV" || true

echo "== interpreting result =="
python3 - "$LOG_JSON" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    r = json.load(f)

if r.get("error"):
    print(f"ORACLE COULD NOT RUN: {r['error']}")
    print("BUGFIX_LAB_RESULT=ORACLE_COULD_NOT_RUN")
    sys.exit(2)
if not (r.get("reachedProviderScreen") and r.get("clickedInstall") and r.get("buttonReverted")):
    print(f"ORACLE COULD NOT RUN: incomplete run -- {r}")
    print("BUGFIX_LAB_RESULT=ORACLE_COULD_NOT_RUN")
    sys.exit(2)

visible = r.get("bannerPresent") or r.get("toastPresent")
if visible:
    print(f"BUG ABSENT: install failed but was surfaced -- banner={r.get('bannerPresent')} "
          f"({r.get('bannerText')!r}) toast={r.get('toastPresent')} ({r.get('toastText')!r})")
    print("BUGFIX_LAB_RESULT=BUGFIX_LAB_ABSENT")
    sys.exit(0)
else:
    print("BUG PRESENT: install failed, button reverted to idle 'Install', "
          "no banner and no toast anywhere in the DOM -- silent revert.")
    print("BUGFIX_LAB_RESULT=BUGFIX_LAB_PRESENT")
    sys.exit(1)
PYEOF
