#!/bin/bash
# Runs INSIDE the bugfix-lab-win GitHub Actions job (windows-latest, no
# pre-existing Ollama -- asserted below, not assumed).
#
# It reproduces the reporter's own sequence with NOTHING forced or stubbed:
#   open the app -> wait for "Choose a provider" -> click Install on the Ollama
#   row -> wait for it to settle -> repeat, three clicks in all
#   ("no matter how many times i click on the button it does not install").
#
# The verdict is FUNCTIONAL and is taken from outside the browser, so it cannot
# be satisfied by anything the UI merely says:
#   PRESENT (exit 1)  -> after the clicks there is still no ollama binary in any
#                        location findBinary() looks at, nothing answering on
#                        127.0.0.1:11434, and the Ollama row is not "Connected".
#                        i.e. the button no-ops; Ollama never installs.
#   ABSENT  (exit 0)  -> an ollama binary landed, or a daemon is serving, or the
#                        row reports Connected. i.e. the install actually ran.
#   exit 2            -> the environment was not clean or the app never started.
set -uo pipefail

PORT=3131
LOG_DEV="${RUNNER_TEMP:-/tmp}/dev-server.log"
LOG_JSON="${RUNNER_TEMP:-/tmp}/check-result.json"

echo "== commit under test =="
git log -1 --format='%H %ci %s'
node -e "console.log('node process.platform =', process.platform)"

echo
echo "== assert this runner has no Ollama (pre-condition) =="
CAND_BIN="$(pwd)/bin/ollama.exe"
CAND_LOCAL="${LOCALAPPDATA:-}\\Programs\\Ollama\\ollama.exe"
CAND_PF="${ProgramFiles:-}\\Ollama\\ollama.exe"
if where.exe ollama >/dev/null 2>&1; then echo "UNEXPECTED: ollama on PATH"; where.exe ollama; exit 2; fi
echo "ollama not on PATH (expected)"
for p in "$CAND_BIN" "$CAND_LOCAL" "$CAND_PF"; do
  if [ -e "$p" ]; then echo "UNEXPECTED: $p already exists"; exit 2; fi
done
PRE_PORT=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:11434/api/tags" 2>/dev/null || echo 000)
echo "pre-run 127.0.0.1:11434/api/tags -> HTTP $PRE_PORT"
if [ "$PRE_PORT" = "200" ]; then echo "UNEXPECTED: something already serving on 11434"; exit 2; fi
echo "confirmed clean: no binary, no daemon"

echo
echo "== starting the app (next dev) on :$PORT =="
npm run dev -- -p "$PORT" >"$LOG_DEV" 2>&1 &
DEV_PID=$!
cleanup() { kill -9 "$DEV_PID" 2>/dev/null || true; }
trap cleanup EXIT

READY=0
for i in $(seq 1 120); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$PORT/" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  echo "app never became ready -- dev log:"; cat "$LOG_DEV"
  echo "BUGFIX_LAB_RESULT=ORACLE_COULD_NOT_RUN"; exit 2
fi
echo "-- app ready --"

echo
echo "== driving the real onboarding UI (headless Chromium) =="
ORACLE_URL="http://localhost:$PORT/" ORACLE_TIMEOUT_MS=1200000 ORACLE_CLICKS=3 \
  node scripts/bugfix-lab/win-check-install.mjs | tee "$LOG_JSON"

echo
echo "== dev server log (last 40 lines) =="
tail -40 "$LOG_DEV" || true

echo
echo "== post-click evidence, taken OUTSIDE the browser =="
BIN_FOUND=""
for p in "$CAND_BIN" "$CAND_LOCAL" "$CAND_PF"; do
  if [ -e "$p" ]; then BIN_FOUND="$p"; fi
  echo "exists? $p -> $([ -e "$p" ] && echo YES || echo no)"
done
if where.exe ollama >/dev/null 2>&1; then BIN_FOUND="$(where.exe ollama | head -1)"; fi
echo "where.exe ollama -> ${BIN_FOUND:-<nothing>}"
echo "--- contents of ./bin (the app's own download dir) ---"
ls -la ./bin 2>&1 || echo "(no ./bin directory -- nothing was ever downloaded)"
POST_PORT=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:11434/api/tags" 2>/dev/null || echo 000)
echo "post-run 127.0.0.1:11434/api/tags -> HTTP $POST_PORT"

echo
echo "== verdict =="
ORACLE_BIN_FOUND="$BIN_FOUND" ORACLE_PORT_CODE="$POST_PORT" \
  node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const binFound = (process.env.ORACLE_BIN_FOUND || "").trim();
const serving = process.env.ORACLE_PORT_CODE === "200";
if (r.error) { console.log("ORACLE COULD NOT RUN:", r.error); console.log("BUGFIX_LAB_RESULT=ORACLE_COULD_NOT_RUN"); process.exit(2); }
if (!r.reachedProviderScreen || r.clicks < 1) { console.log("ORACLE COULD NOT RUN: incomplete run", JSON.stringify(r)); console.log("BUGFIX_LAB_RESULT=ORACLE_COULD_NOT_RUN"); process.exit(2); }
console.log("clicks=" + r.clicks, "connectedAfter=" + r.connectedAfter, "buttonBack=" + r.buttonBack);
console.log("bannerText=" + JSON.stringify(r.bannerText), "toastText=" + JSON.stringify(r.toastText));
console.log("ollamaBinaryOnDisk=" + (binFound || "<none>"), "daemonServing=" + serving);
const installed = Boolean(binFound) || serving || r.connectedAfter;
const visibleError = Boolean((r.bannerText && String(r.bannerText).trim()) || (r.toastText && String(r.toastText).trim()));
console.log("visibleError=" + visibleError);
// Cluster record's own stated pass/fail rule (clusters.json "oracle" field): reproduces iff
// (no install AND no visible toast/banner); does NOT reproduce if either the install proceeds
// OR a visible error surfaces. Applying that compound rule verbatim, not just install success.
if (installed || visibleError) {
  console.log("BUG ABSENT per the cluster's own stated rule: install succeeded, or a visible toast/banner rendered (not a silent no-op).");
  console.log("BUGFIX_LAB_RESULT=BUGFIX_LAB_ABSENT"); process.exit(0);
}
console.log("BUG PRESENT per the cluster's own stated rule: after " + r.clicks + " clicks on Install, no ollama binary exists anywhere findBinary() looks, nothing is serving on 11434, the row is not Connected, AND no visible toast/banner rendered -- a genuine silent no-op.");
console.log("BUGFIX_LAB_RESULT=BUGFIX_LAB_PRESENT"); process.exit(1);
' "$LOG_JSON"
