#!/usr/bin/env bash
# publik-release.sh — cuts one Simplicity release for every OS Simplicity ships (macOS Apple silicon and
# Windows x64), in one command (docs/updates.md › Cut a release):
#
#   scripts/publik-release.sh <app version> [--no-publish]        for example: scripts/publik-release.sh 1.12.10
#
# <app version> is package.json "version" (1.12.x). The release TAG is a different series (v0.1.x): the script
# takes the next patch tag after the latest published release (v0.1.10 -> v0.1.11); PUBLIK_RELEASE_TAG
# overrides it. Run it on the maintainer's Mac: the Developer ID certificate, the notarytool profile "publik"
# and the publik update key (keychain service publik-update-key, accounts mann-private and mann-password)
# live in its keychain. Before: set <app version> in package.json, commit, push to desktop. Then:
#   1. checks: on desktop, clean tree, pushed; package.json carries <app version> (the only file a bump
#      touches: yarn.lock does not hold the app's own version); it is newer than the version of the latest
#      release; the tag is free (a DRAFT of that tag on this commit is resumed); identity, notary profile and
#      update key are in the keychain
#   2. CI: publik-build.yml on this commit (the unsigned Simplicity.app and the Windows installer, both with
#      the publik app token, unit-tested and self-tested on the runners); a green run of the commit is reused
#   3. macOS app: signs it with the Developer ID (scripts/publik-mac-sign.cjs: @electron/osx-sign, inner code
#      first, hardened runtime, desktop/entitlements.mac.plist), notarizes it (notarytool), staples it, checks
#      it, and makes the update zip from the stapled app; the zip goes to the DRAFT release
#   4. macOS dmg: publik-dmg.yml packs the stapled app with electron-builder's dmg target (no signing); this
#      Mac signs, notarizes and staples the dmg
#   5. Windows: the installer from step 2 (not code-signed, as every Simplicity release so far)
#   6. SHA256SUMS.txt and the update feed (scripts/publik-update-feed.cjs): latest.yml + latest-mac.yml with
#      absolute GitHub URLs, signed with the publik update key from the keychain
#   7. uploads everything to the draft, deletes the local copies, downloads every file back and verifies it:
#      feed signatures (the app's public key), sha512/sha256, versions (Info.plist, exe = feed), codesign,
#      spctl, stapler, the designated requirement, the publik app token
#   8. publishes the draft as the latest release (not with --no-publish), then checks every download URL
# It stops before publishing at the first failed check, can run again to resume (state: $PUBLIK_RELEASE_WORK,
# default ${TMPDIR}/publik-release-simplicity/<version>-<commit>: one work folder per commit), starts no app,
# and prints no secret. GitHub API calls are retried, and while it waits it makes one call per 90 seconds
# (the hourly API limit is shared with the user's other jobs). Disk: about 2 GB free at the peak (the
# unpacked app and one zip); each step checks the room it needs first.
set -euo pipefail

APP=Simplicity
SLUG=simplicity
REPO=Blueturboguy07/Simplicity
BRANCH=desktop
BUNDLE_ID=com.simplicity.desktop
IDENTITY='Developer ID Application: Mann Bellani (R5R3ZS54LV)'
NOTARY_PROFILE=publik
KEY_SERVICE=publik-update-key
DR_EXPECTED='identifier "com.simplicity.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = R5R3ZS54LV'
DMG=Simplicity-mac-arm64.dmg
ZIP=Simplicity-mac-arm64.zip
EXE=Simplicity-Setup-Windows.exe
CI_MAC_ARTIFACT=Simplicity-mac-arm64-UNSIGNED-app
CI_MAC_FILE=Simplicity-mac-arm64-unsigned.app.zip
CI_WIN_ARTIFACT=Simplicity-Setup-Windows
DMG_ARTIFACT=simplicity-dmg

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/publik-release-check.cjs"
ENT="$ROOT/desktop/entitlements.mac.plist"

say() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }
die() { printf '\npublik-release: STOP: %s\n' "$*" >&2; exit 1; }

VERSION="${1:-}"
PUBLISH=1
[ "${2:-}" = "--no-publish" ] && PUBLISH=0
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/publik-release.sh <app version> [--no-publish], for example 1.12.10"

[ "$(uname)" = Darwin ] || die "run this on the Mac that holds the Developer ID certificate"
for t in gh git node npm npx xcrun codesign spctl hdiutil ditto security shasum plutil lipo curl unzip; do
  command -v "$t" > /dev/null || die "missing tool: $t"
done
cd "$ROOT"
git fetch --quiet origin "$BRANCH" --tags
SHA="$(git rev-parse HEAD)"
WORK="${PUBLIK_RELEASE_WORK:-${TMPDIR:-/tmp}/publik-release-$SLUG/$VERSION-${SHA:0:12}}"
STATE="$WORK/state"
OUT="$WORK/out"
MAC="$WORK/mac"
APP_PATH="$MAC/$APP.app"
mkdir -p "$STATE" "$OUT"
mark() { touch "$STATE/$1"; }
done_() { [ -f "$STATE/$1" ]; }
need_mb() { # <MB> <what>: stops (resumable) when the disk lacks the room
  local free; free="$(df -m "$WORK" | awk 'NR==2 {print $4}')"
  [ "$free" -ge "$1" ] || die "$2 needs about $1 MB of free disk, $free MB are free. Free some space, then run the script again (it resumes)."
}
# gh with retries: the GitHub API limit (5000 calls an hour) is per user and the user's other jobs share it;
# a rate limit, a 5xx or a dropped connection waits 90 s and tries again. Other errors stop at once.
ghr() {
  local out err i
  for i in $(seq 1 40); do
    if out="$(gh "$@" 2> "$WORK/gh.err")"; then
      [ -z "$out" ] || printf '%s\n' "$out"
      return 0
    fi
    err="$(tr '\n' ' ' < "$WORK/gh.err")"
    case "$err" in
      *"rate limit"* | *"HTTP 5"* | *"timed out"* | *"timeout"* | *"onnection"* | *"EOF"* | *"TLS"* | *"i/o"*) ;;
      *) printf '%s\n' "$err" >&2; return 1 ;;
    esac
    echo "   GitHub API: ${err:0:120}... waiting 90 s (try $i of 40)" >&2
    sleep 90
  done
  printf '%s\n' "$err" >&2
  return 1
}

# ------------------------------------------------------------------ 1. checks
say "1. checks (work folder $WORK)"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "check out $BRANCH first"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean"
[ "$SHA" = "$(git rev-parse "origin/$BRANCH")" ] || die "HEAD is not origin/$BRANCH: push (or pull) first"
ok "on $BRANCH at $SHA, clean, pushed"
pkg_v="$(node -p "require('./package.json').version")"
[ "$pkg_v" = "$VERSION" ] || die "package.json says $pkg_v. Bump first: set \"version\": \"$VERSION\" in package.json, commit, push to $BRANCH"
ok "package.json: $VERSION (yarn.lock holds no version of the app itself)"
gh auth status > /dev/null 2>&1 || die "gh is not logged in"
PREV_TAG="$(ghr release list -R "$REPO" --exclude-drafts --exclude-pre-releases -L 1 --json tagName --jq '.[0].tagName // ""')"
[[ "$PREV_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the latest release has no vX.Y.Z tag: '$PREV_TAG'"
PREV_V="$(curl -fsSL "https://github.com/$REPO/releases/download/$PREV_TAG/latest-mac.yml" | sed -n "s/^version: '\(.*\)'$/\1/p")"
[ -n "$PREV_V" ] || die "cannot read the app version of $PREV_TAG (its latest-mac.yml)"
newest="$(printf '%s\n%s\n' "$PREV_V" "$VERSION" | sort -V | tail -1)"
[ "$newest" = "$VERSION" ] && [ "$PREV_V" != "$VERSION" ] || die "$VERSION is not newer than $PREV_V (the latest release $PREV_TAG)"
if [ -n "${PUBLIK_RELEASE_TAG:-}" ]; then TAG="$PUBLIK_RELEASE_TAG"
else p="${PREV_TAG#v}"; TAG="v${p%.*}.$(( ${p##*.} + 1 ))"; fi
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the tag $TAG is not vX.Y.Z"
ok "app version $VERSION is newer than $PREV_V (the latest release $PREV_TAG); this release: tag $TAG"
BASE="https://github.com/$REPO/releases/download/$TAG/"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" > /dev/null 2>&1; then
  die "the tag $TAG exists already (a published release or a stray tag): set PUBLIK_RELEASE_TAG to a free tag"
fi
RELEASE_ID="$(ghr api "repos/$REPO/releases?per_page=30" --jq ".[] | select(.tag_name == \"$TAG\") | .id")"
if [ -n "$RELEASE_ID" ]; then
  rel="$(ghr api "repos/$REPO/releases/$RELEASE_ID" --jq '"\(.draft) \(.target_commitish)"')"
  [ "${rel%% *}" = true ] || die "a published release $TAG exists already"
  [ "${rel#* }" = "$SHA" ] || die "the draft $TAG targets ${rel#* }, not $SHA: delete that draft or check out its commit"
  ok "the tag $TAG is free; resuming the draft $TAG (release $RELEASE_ID)"
else
  ok "the tag $TAG is free"
fi
ids="$(security find-identity -v -p codesigning)"
grep -qF "\"$IDENTITY\"" <<< "$ids" || die "the keychain has no valid identity $IDENTITY"
ok "signing identity: $IDENTITY"
xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" > /dev/null 2>&1 || die "the notarytool keychain profile \"$NOTARY_PROFILE\" does not work"
ok "notary profile: $NOTARY_PROFILE"
for a in mann-private mann-password; do
  security find-generic-password -s "$KEY_SERVICE" -a "$a" > /dev/null 2>&1 || die "the keychain has no $KEY_SERVICE / $a (the publik update key)"
done
ok "update key: keychain service $KEY_SERVICE (not read yet, never printed)"

# ------------------------------------------------------------------ helpers: CI, notarization, uploads
wait_run() { # <run id> <what>
  local s c
  echo "   waiting for $2: https://github.com/$REPO/actions/runs/$1"
  while :; do
    # One call per 90 s; a failed request (for example the API limit) is tried again, it does not stop.
    s="$(gh run view "$1" -R "$REPO" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null || echo 'unknown unknown')"
    [ "${s%% *}" = completed ] && break
    sleep 90
  done
  c="${s#* }"
  [ "$c" = success ] || die "$2 ended with $c: https://github.com/$REPO/actions/runs/$1 (run the script again to retry)"
  ok "$2: success"
}
dispatch() { # <workflow file> <state name> [inputs...]: a run of the workflow on this commit (reused when it is green or running)
  local wf="$1" name="$2" id="" s since i
  shift 2
  [ -f "$STATE/$name" ] && id="$(cat "$STATE/$name")"
  if [ -n "$id" ]; then
    s="$(ghr run view "$id" -R "$REPO" --json status,conclusion,headSha --jq '"\(.headSha) \(.status) \(.conclusion)"')"
    case "$s" in
      "$SHA completed success" | "$SHA in_progress "* | "$SHA queued "* | "$SHA waiting "* | "$SHA pending "* | "$SHA requested "*) ;;
      *) echo "   the earlier run $id ($s) is not usable: starting a new one"; id="" ;;
    esac
  fi
  if [ -z "$id" ]; then
    since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ghr workflow run "$wf" -R "$REPO" --ref "$BRANCH" "$@" > /dev/null
    for i in 1 2 3 4 5; do
      if [ "$i" = 1 ]; then sleep 20; else sleep 90; fi
      id="$(gh run list -R "$REPO" --workflow "$wf" --event workflow_dispatch --commit "$SHA" -L 5 --json databaseId,createdAt \
        --jq "[.[] | select(.createdAt >= \"$since\")] | .[-1].databaseId // \"\"" 2>/dev/null || true)"
      [ -n "$id" ] && break
    done
    [ -n "$id" ] || die "the run of $wf did not show up"
  fi
  echo "$id" > "$STATE/$name"
  RUN_ID="$id"
}
notarize() { # <file> <label>
  local file="$1" label="$2" id status
  id="$(cat "$STATE/notary-$label" 2>/dev/null || true)"
  if [ -z "$id" ]; then
    xcrun notarytool submit "$file" --keychain-profile "$NOTARY_PROFILE" --no-wait --output-format plist > "$WORK/notary-$label-submit.plist"
    id="$(plutil -extract id raw "$WORK/notary-$label-submit.plist")"
    echo "$id" > "$STATE/notary-$label"
  fi
  echo "   notarization of the $label: submission $id, waiting for Apple"
  xcrun notarytool wait "$id" --keychain-profile "$NOTARY_PROFILE" --timeout 2h > "$WORK/notary-$label-wait.txt" 2>&1 || true
  xcrun notarytool info "$id" --keychain-profile "$NOTARY_PROFILE" --output-format plist > "$WORK/notary-$label-info.plist"
  status="$(plutil -extract status raw "$WORK/notary-$label-info.plist")"
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" "$WORK/notary-$label-log.json" > /dev/null 2>&1 || true
    rm -f "$STATE/notary-$label"
    die "notarization of the $label: $status (Apple's log: $WORK/notary-$label-log.json)"
  fi
  ok "notarization of the $label: Accepted (submission $id)"
}
ensure_draft() {
  [ -n "$RELEASE_ID" ] && return
  local notes="$WORK/notes.md" changes
  if [ -n "${PUBLIK_RELEASE_NOTES:-}" ]; then changes="$(cat "$PUBLIK_RELEASE_NOTES")"
  else changes="$(git log --no-merges --format='- %s' "$PREV_TAG..HEAD")"; fi
  cat > "$notes" <<EOF
$APP $VERSION.

Changes since $PREV_TAG:

$changes

$APP $PREV_V and later update themselves to this version: $APP asks publik for a new version when it opens, every 24 hours, and when you click **Check for Updates…** (macOS: the $APP menu; Windows: the Help menu). It asks before it restarts. If you have 0.1.9 or older, download this version one time from the links below.

Files:

- \`$DMG\`: macOS (Apple Silicon). Signed with the Developer ID, notarized and stapled by Apple.
- \`$EXE\`: Windows 10/11, 64-bit (beta, not code-signed: SmartScreen warns the first time; More info, then Run anyway).
- \`$ZIP\`, \`latest-mac.yml\`, \`latest.yml\` and the \`.sig\` files: the update files that the app reads. You do not need to download them. \`SHA256SUMS.txt\`: the checksums.

App version $VERSION. Release tag $TAG (the v0.1.x tags do not follow the app version: $PREV_TAG was $PREV_V).
EOF
  ghr release create "$TAG" -R "$REPO" --draft --target "$SHA" --title "$APP ${TAG#v}" --notes-file "$notes" > /dev/null
  RELEASE_ID="$(ghr api "repos/$REPO/releases?per_page=30" --jq ".[] | select(.tag_name == \"$TAG\") | .id")"
  [ -n "$RELEASE_ID" ] || die "the draft $TAG was not created"
  ok "draft release $TAG created (release $RELEASE_ID, target $SHA)"
}
asset_digest() { # <name>: "sha256:<hex>", "none" (no digest from the API) or "" (not on the draft)
  ghr api "repos/$REPO/releases/$RELEASE_ID/assets?per_page=100" --jq ".[] | select(.name == \"$1\") | (.digest // \"none\")"
}
upload() { # <file>: puts the file on the draft unless the same bytes are there
  local f="$1" name remote want
  name="$(basename "$f")"
  want="sha256:$(shasum -a 256 "$f" | cut -d' ' -f1)"
  remote="$(asset_digest "$name")"
  if [ "$remote" = "$want" ]; then ok "$name is on the draft already"; return; fi
  ghr release upload "$TAG" "$f" -R "$REPO" --clobber > /dev/null
  remote="$(asset_digest "$name")"
  [ "$remote" = "$want" ] || [ "$remote" = none ] || die "the upload of $name has $remote, the local file $want"
  ok "uploaded $name ($remote)"
}
on_draft() { [ -n "$RELEASE_ID" ] && [ -n "$(asset_digest "$1")" ]; }
app_checks() { # <Simplicity.app> <label>: the checks of a signed, notarized, stapled app
  local app="$1" label="$2" v dr a info ent gk
  v="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")"
  [ "$v" = "$VERSION" ] || die "$label: Info.plist version $v, not $VERSION"
  [ "$(plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist")" = "$BUNDLE_ID" ] || die "$label: bundle ID"
  a="$(lipo -archs "$app/Contents/MacOS/$APP")"
  [[ "$a" == *arm64* ]] || die "$label: architectures $a"
  ok "$label: Info.plist $v, $BUNDLE_ID, $a"
  codesign --verify --deep --strict "$app" || die "$label: codesign --verify --deep --strict failed"
  info="$(codesign -dvv "$app" 2>&1)"
  grep -q "^Authority=$IDENTITY" <<< "$info" || die "$label: not signed by $IDENTITY"
  grep -q 'flags=0x10000(runtime)' <<< "$info" || die "$label: no hardened runtime"
  grep -q '^Timestamp=' <<< "$info" || die "$label: no secure timestamp"
  dr="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
  [ "$dr" = "$DR_EXPECTED" ] || die "$label: designated requirement changed: $dr"
  ent="$(codesign -d --entitlements - --xml "$app" 2>/dev/null)"
  grep -q 'com.apple.security.cs.allow-jit' <<< "$ent" || die "$label: not signed with desktop/entitlements.mac.plist"
  ok "$label: codesign --verify --deep --strict: valid; $IDENTITY; hardened runtime; timestamp; the repo's entitlements"
  ok "$label: designated => $dr"
  xcrun stapler validate "$app" > /dev/null || die "$label: no stapled ticket"
  gk="$(spctl -a -t exec -vv "$app" 2>&1 || true)"
  grep -q 'source=Notarized Developer ID' <<< "$gk" || die "$label: spctl: $gk"
  ok "$label: stapler validate: worked; spctl: $(tr '\n' ' ' <<< "$gk")"
  node "$CHECK" asar "$app/Contents/Resources/app.asar" --version "$VERSION" | sed 's/^/   /' || die "$label: app.asar check failed"
  node "$CHECK" token "$app/Contents/Resources" | sed 's/^/   /' || die "$label: publik app token check failed"
}
dmg_checks() { # <dmg> <label>
  local dmg="$1" label="$2" mnt="$WORK/mnt" info gk
  codesign --verify --strict "$dmg" || die "$label: codesign --verify failed"
  info="$(codesign -dvv "$dmg" 2>&1)"
  grep -q "^Authority=$IDENTITY" <<< "$info" || die "$label: not signed by $IDENTITY"
  xcrun stapler validate "$dmg" > /dev/null || die "$label: no stapled ticket"
  gk="$(spctl -a -t open --context context:primary-signature -vv "$dmg" 2>&1 || true)"
  grep -q 'source=Notarized Developer ID' <<< "$gk" || die "$label: spctl: $gk"
  ok "$label: signed by $IDENTITY; stapler validate: worked; spctl: $(tr '\n' ' ' <<< "$gk")"
  mkdir -p "$mnt"
  hdiutil attach "$dmg" -nobrowse -noautoopen -readonly -mountpoint "$mnt" -quiet || die "$label: does not mount"
  [ -L "$mnt/Applications" ] || { hdiutil detach "$mnt" -quiet; die "$label: no Applications link"; }
  ( app_checks "$mnt/$APP.app" "$label › $APP.app" ) || { hdiutil detach "$mnt" -force -quiet; exit 1; }
  hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet
}
ASSETS=("$DMG" "$ZIP" "$EXE" SHA256SUMS.txt latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig)
ALL_ON_DRAFT=0
CI_RUN="$(cat "$STATE/ci-build" 2>/dev/null || true)"
if [ -n "$RELEASE_ID" ] && on_draft "$ZIP" && on_draft "$DMG" && on_draft "$EXE"; then ALL_ON_DRAFT=1; fi

# ------------------------------------------------------------------ 2. CI build
say "2. CI build (publik-build.yml on $SHA)"
if [ "$ALL_ON_DRAFT" = 1 ]; then
  ok "the draft holds the zip, the dmg and the installer: no build needed"
else
  if [ ! -f "$STATE/ci-build" ]; then
    green="$(ghr run list -R "$REPO" --workflow publik-build.yml --commit "$SHA" --status success -L 1 --json databaseId --jq '.[0].databaseId // ""')"
    if [ -n "$green" ]; then echo "$green" > "$STATE/ci-build"; ok "reusing the green run $green of this commit"; fi
  fi
  dispatch publik-build.yml ci-build
  CI_RUN="$RUN_ID"
  wait_run "$CI_RUN" "publik build"
  steps="$(ghr run view "$CI_RUN" -R "$REPO" --json jobs --jq '[.jobs[].steps[] | select(.name | test("^Assert the publik token|self-test|^Run yarn test$")) | "\(.name)=\(.conclusion)"] | join("; ")')"
  n_ok="$(grep -o '=success' <<< "$steps" | wc -l | tr -d ' ')"
  [ "$n_ok" -ge 5 ] && [[ "$steps" != *"=failure"* ]] && [[ "$steps" != *"=skipped"* ]] || die "the CI checks (app token, self-tests, unit tests) did not all pass: $steps"
  ok "CI checked both builds: $steps"
fi

# ------------------------------------------------------------------ 3. macOS app: sign, notarize, staple, update zip
say "3. macOS app: Developer ID, notarization, staple, update zip"
if on_draft "$ZIP"; then
  ok "$ZIP is on the draft"
else
  if [ ! -f "$STATE/zip-made" ]; then
    if [ -d "$MAC" ] && [ "$(cat "$STATE/mac-from-run" 2>/dev/null)" != "$CI_RUN" ]; then
      rm -r "$MAC"
      ok "deleted a local app of an earlier CI run"
    fi
    if [ ! -d "$APP_PATH" ]; then
      rm -f "$STATE/mac-signed" "$STATE/notary-app" "$STATE/mac-stapled"
      need_mb 2400 "the unsigned app (download + unpack)"
      rm -rf "$WORK/ci-mac"
      ghr run download "$CI_RUN" -R "$REPO" -n "$CI_MAC_ARTIFACT" -D "$WORK/ci-mac"
      mkdir -p "$MAC"
      ditto -x -k "$WORK/ci-mac/$CI_MAC_FILE" "$MAC"
      echo "$CI_RUN" > "$STATE/mac-from-run"
      rm -r "$WORK/ci-mac"
      ok "unpacked the CI app: $(du -sm "$APP_PATH" | cut -f1) MB"
    fi
    if ! done_ mac-signed; then
      [ "$(plutil -extract CFBundleShortVersionString raw "$APP_PATH/Contents/Info.plist")" = "$VERSION" ] || die "the CI app is not $VERSION"
      osx_v="$(awk '/^"?@electron\/osx-sign@/ { getline; gsub(/[ "]|version/, ""); print; exit }' yarn.lock)"
      [ -n "$osx_v" ] || die "cannot read the @electron/osx-sign version from yarn.lock"
      if [ ! -d "$WORK/tools/node_modules/@electron/osx-sign" ]; then
        need_mb 100 "@electron/osx-sign"
        npm install --prefix "$WORK/tools" --no-audit --no-fund --no-save --loglevel=error "@electron/osx-sign@$osx_v" > /dev/null
      fi
      echo "   signing every binary inside the app, then the app (@electron/osx-sign $osx_v; this takes a while)"
      node "$ROOT/scripts/publik-mac-sign.cjs" "$APP_PATH" "$ENT" "$IDENTITY" "$WORK/tools/node_modules/@electron/osx-sign" || die "signing the app failed"
      codesign --verify --deep --strict "$APP_PATH" || die "the signed app does not verify"
      mark mac-signed
    fi
    if ! done_ mac-stapled; then
      if [ ! -f "$STATE/notary-app" ]; then
        need_mb 700 "the notarization zip"
        ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$WORK/notarize-app.zip"
        notarize "$WORK/notarize-app.zip" app
        rm -f "$WORK/notarize-app.zip"
      else
        rm -f "$WORK/notarize-app.zip"
        notarize "$APP_PATH" app
      fi
      xcrun stapler staple "$APP_PATH" > /dev/null || die "stapling the app failed"
      mark mac-stapled
    fi
    app_checks "$APP_PATH" "$APP.app (signed here)"
    need_mb 700 "the update zip"
    ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$OUT/$ZIP"
    mark zip-made
    ok "$ZIP made from the stapled app ($(du -m "$OUT/$ZIP" | cut -f1) MB)"
  fi
  [ -f "$OUT/$ZIP" ] || die "$OUT/$ZIP is missing: delete $STATE/zip-made and run again"
  ensure_draft
  upload "$OUT/$ZIP"
fi
if [ -d "$MAC" ]; then rm -r "$MAC"; ok "deleted the local app (the zip holds it)"; fi

# ------------------------------------------------------------------ 4. macOS dmg
say "4. macOS dmg (publik-dmg.yml packs the stapled app; this Mac signs, notarizes, staples)"
ensure_draft
if on_draft "$DMG"; then
  ok "$DMG is on the draft"
else
  if [ ! -f "$OUT/$DMG" ]; then
    rm -f "$STATE/dmg-signed" "$STATE/notary-dmg" "$STATE/dmg-done"
    dispatch publik-dmg.yml dmg-build -f "tag=$TAG"
    wait_run "$RUN_ID" "publik dmg"
    need_mb 700 "the dmg"
    rm -rf "$WORK/ci-dmg"
    ghr run download "$RUN_ID" -R "$REPO" -n "$DMG_ARTIFACT" -D "$WORK/ci-dmg"
    mv "$WORK/ci-dmg/$DMG" "$OUT/$DMG"
    rm -r "$WORK/ci-dmg"
  fi
  if ! done_ dmg-signed; then
    codesign --force --sign "$IDENTITY" --timestamp "$OUT/$DMG"
    mark dmg-signed
  fi
  if ! done_ dmg-done; then
    notarize "$OUT/$DMG" dmg
    xcrun stapler staple "$OUT/$DMG" > /dev/null || die "stapling the dmg failed"
    dmg_checks "$OUT/$DMG" "$DMG"
    mark dmg-done
  fi
fi

# ------------------------------------------------------------------ 5. Windows installer
say "5. Windows installer"
if [ ! -f "$OUT/$EXE" ] && ! on_draft "$EXE"; then
  need_mb 500 "the Windows installer"
  rm -rf "$WORK/ci-win"
  ghr run download "$CI_RUN" -R "$REPO" -n "$CI_WIN_ARTIFACT" -D "$WORK/ci-win"
  mv "$WORK/ci-win/$EXE" "$OUT/$EXE"
  rm -r "$WORK/ci-win"
fi
if [ -f "$OUT/$EXE" ]; then
  node "$CHECK" exe "$OUT/$EXE" --version "$VERSION" | sed 's/^/   /' || die "$EXE: version check failed"
else
  ok "$EXE is on the draft"
fi

# ------------------------------------------------------------------ 6. SHA256SUMS.txt and the signed feed
say "6. SHA256SUMS.txt and the update feed"
if [ ! -f "$STATE/feed-done" ]; then
  for f in "$ZIP" "$DMG" "$EXE"; do
    if [ ! -f "$OUT/$f" ]; then need_mb 600 "$f"; ghr release download "$TAG" -R "$REPO" --pattern "$f" --dir "$OUT" --clobber; fi
  done
  (cd "$OUT" && shasum -a 256 "$DMG" "$EXE" "$ZIP" > SHA256SUMS.txt)
  [ ! -d "$OUT/feed" ] || rm -r "$OUT/feed"
  node "$ROOT/scripts/publik-update-feed.cjs" write --app "$SLUG" --version "$VERSION" --fixed-names --download-base "$BASE" \
    --win "$OUT/$EXE" --mac-zip "$OUT/$ZIP" --mac-dmg "$OUT/$DMG" --out "$OUT/feed"
  # The update key goes from the keychain into the environment of the signing process only; it is never printed.
  PUBLIK_UPDATE_KEY="$(security find-generic-password -s "$KEY_SERVICE" -a mann-private -w)" \
  PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s "$KEY_SERVICE" -a mann-password -w)" \
    node "$ROOT/scripts/publik-update-feed.cjs" sign "$OUT/feed/latest.yml" "$OUT/feed/latest-mac.yml"
  mark feed-done
fi
ok "feed: $(sed -n 1p "$OUT/feed/latest.yml"), $(sed -n 1p "$OUT/feed/latest-mac.yml")"

# ------------------------------------------------------------------ 7. upload, download back, verify
say "7. upload to the draft $TAG, then download every file back and verify it"
for f in "$DMG" "$EXE" "$ZIP"; do [ -f "$OUT/$f" ] && upload "$OUT/$f"; done
upload "$OUT/SHA256SUMS.txt"
for f in latest.yml latest.yml.sig latest-mac.yml latest-mac.yml.sig; do upload "$OUT/feed/$f"; done
for f in "$DMG" "$EXE" "$ZIP"; do rm -f "$OUT/$f"; done
ok "deleted the local copies of the installers"
if [ ! -f "$STATE/verified" ]; then
  V="$WORK/verify"
  [ ! -d "$V" ] || rm -r "$V"
  mkdir -p "$V/feed" "$V/files"
  names="$(ghr api "repos/$REPO/releases/$RELEASE_ID/assets?per_page=100" --jq '.[].name' | sort | tr '\n' ' ')"
  want="$(printf '%s\n' "${ASSETS[@]}" | sort | tr '\n' ' ')"
  [ "$names" = "$want" ] || die "the draft holds [$names], want [$want]"
  ok "the draft holds exactly: $names"
  ghr release download "$TAG" -R "$REPO" --dir "$V/feed" --pattern 'latest*' --pattern SHA256SUMS.txt --clobber
  FEEDCHECK=(node "$CHECK" feed "$V/feed" "$V/files" --version "$VERSION" --app "$SLUG" --base "$BASE" --names "$ZIP,$DMG,$EXE")
  "${FEEDCHECK[@]}" | sed 's/^/   /' || die "the feed check failed"
  for f in "$EXE" "$DMG" "$ZIP"; do
    need_mb 2400 "the check of $f"
    ghr release download "$TAG" -R "$REPO" --dir "$V/files" --pattern "$f" --clobber
    "${FEEDCHECK[@]}" | grep -E "^(PASS|FAIL) $f" | sed 's/^/   /'
    "${FEEDCHECK[@]}" > /dev/null || die "$f does not match the feed"
    node "$CHECK" sums "$V/feed/SHA256SUMS.txt" "$V/files" | grep -v '^skip' | sed 's/^/   /' || die "$f does not match SHA256SUMS.txt"
    case "$f" in
      *.exe) node "$CHECK" exe "$V/files/$f" --version "$VERSION" | sed 's/^/   /' || die "$f: version" ;;
      *.dmg) dmg_checks "$V/files/$f" "$f (downloaded back)" ;;
      *.zip)
        mkdir -p "$V/zip"
        ditto -x -k "$V/files/$f" "$V/zip"
        rm -f "$V/files/$f"
        app_checks "$V/zip/$APP.app" "$f › $APP.app (downloaded back)"
        rm -r "$V/zip" ;;
    esac
    rm -f "$V/files/$f"
  done
  mark verified
  ok "every file on the draft verified"
fi

# ------------------------------------------------------------------ 8. publish
if [ "$PUBLISH" = 0 ]; then
  say "stopped before publishing (--no-publish): the draft $TAG is complete and verified"
  exit 0
fi
say "8. publish $TAG"
ghr release edit "$TAG" -R "$REPO" --draft=false --latest > /dev/null
mark published
for f in "${ASSETS[@]}"; do
  code="$(curl -s -o /dev/null -L -r 0-0 -w '%{http_code}' "$BASE$f")"
  [ "$code" = 200 ] || [ "$code" = 206 ] || die "published, but $BASE$f answers $code"
done
latest="$(curl -s -o /dev/null -w '%{redirect_url}' "https://github.com/$REPO/releases/latest")"
[ "${latest##*/}" = "$TAG" ] || die "published, but the latest release is ${latest##*/}, not $TAG"
ok "published: https://github.com/$REPO/releases/tag/$TAG (the latest release; every file downloads)"
for d in "$WORK/verify" "$WORK/tools" "$OUT"; do [ ! -d "$d" ] || rm -r "$d"; done
ok "deleted the local work files (the state folder $STATE stays)"
echo "   publik takes the release in at its next daily intake (10:00 UTC); then https://publikhq.com/api/updates/$SLUG/latest-mac.yml serves $VERSION"
