# Updates

The Simplicity desktop app updates itself on macOS and Windows. The code is `desktop/publik-updater.cjs`
(the Electron part) and `desktop/publik-update-verify.cjs` (the signature check). Both files are the same
in every publik Electron app. `desktop/main.mjs` starts them first thing at app ready.

## How it works

1. The app asks `https://publikhq.com/api/updates/simplicity/` for two files: `latest.yml` (Windows) or
   `latest-mac.yml` (macOS), and the signature of that file (`latest.yml.sig` or `latest-mac.yml.sig`).
   It asks at launch, every 24 hours, and when you click **Check for Updates…** (macOS: the Simplicity
   menu; Windows: the Help menu).
2. The app verifies the signature with the publik update public key, which is in
   `desktop/publik-update-verify.cjs`. If the signature is missing or wrong, the app stops there. It
   downloads nothing.
3. The feed must name this app (`publikApp: simplicity`) and give a sha512 for each file.
4. electron-updater downloads the file that the feed names. It refuses the file if its sha512 is not the
   one in the signed feed. Windows downloads the NSIS installer. macOS downloads the zip, and Squirrel.Mac
   also refuses an app that does not satisfy the code signature of the running app (same bundle ID
   `com.simplicity.desktop`, same Developer ID).
5. The app asks: "Simplicity X is ready to install. Restart now?" **Later** installs the update when you
   quit. The app never restarts by itself.

A failure in the background is silent (the log has it). A manual check always shows its result.
`PUBLIK_UPDATES=0` in the environment stops the automatic checks. The CI launch tests set it.

Only a build signed with the Developer ID can update itself on macOS. An ad-hoc signed build (a build
without `MAC_SIGN=1`, for example the unsigned app of `publik-build.yml` before it is signed) has a
designated requirement that only its own bytes satisfy, so Squirrel.Mac refuses every update for it.

## The version

electron-updater compares the feed `version` with the version the app reports: `package.json` "version"
(1.12.x). The release tags (v0.1.x) are a different series. So:

- Raise `package.json` "version" for every release, as before. An app installs only a HIGHER version.
- The feed version is `package.json` "version" of the release's commit, not the tag.
  `update-feed.yml` reads it from the tag (for a draft without a tag: from the release's target). Its
  `version` input overrides it.
- `scripts/publik-update-feed.cjs` opens the mac zip and refuses a feed whose version is not the version
  of the app in the zip.

## The feed contract (what publik serves)

| Request | Response |
|---|---|
| `GET /api/updates/simplicity/latest.yml` | the release asset `latest.yml`, byte for byte |
| `GET /api/updates/simplicity/latest.yml.sig` | the release asset `latest.yml.sig`, byte for byte |
| `GET /api/updates/simplicity/latest-mac.yml` | the release asset `latest-mac.yml`, byte for byte |
| `GET /api/updates/simplicity/latest-mac.yml.sig` | the release asset `latest-mac.yml.sig`, byte for byte |

- Serve the files from the scan-approved release without changes. One changed byte breaks the signature.
- The app adds `?noCache=<random>` to each request. Ignore the query string.
- A redirect is fine. A 404 means "no update" for the app.
- The base URL must not carry a query string: electron-updater copies the base query onto every file URL.
- The feed lists ABSOLUTE GitHub asset URLs. electron-updater's generic provider resolves each URL with
  `new URL(url, base)`, so an absolute URL stays as it is (checked by the unit tests and the proof). The
  app downloads the installer from GitHub, not from publik.
- The app does not send electron-updater's `x-user-staging-id` header.

The installer names carry no version (`Simplicity-Setup-Windows.exe`, `Simplicity-mac-arm64.zip`,
`Simplicity-mac-arm64.dmg`), so README's `releases/latest/download` links keep working. The tag in each
URL keeps the files of two releases apart. A feed file looks like this (`scripts/publik-update-feed.cjs
write` makes it):

```yaml
version: '1.13.0'
publikApp: 'simplicity'
files:
  - url: 'https://github.com/Blueturboguy07/Simplicity/releases/download/v0.2.0/Simplicity-mac-arm64.zip'
    sha512: '<base64>'
    size: 123456789
  - url: 'https://github.com/Blueturboguy07/Simplicity/releases/download/v0.2.0/Simplicity-mac-arm64.dmg'
    sha512: '<base64>'
    size: 123456789
path: '<the url of the first file>'
sha512: '<the sha512 of the first file>'
releaseDate: '2026-11-18T00:00:00.000Z'
```

The `.sig` file is a minisign signature of the feed file. The app accepts these forms:

| Made with | Algorithm | File form |
|---|---|---|
| `tauri signer sign` (what `scripts/publik-update-feed.cjs` uses) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text, wrapped in base64 |
| `minisign -S` (minisign 0.8 and later) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text |
| `minisign -S -l` (legacy) | `Ed`: Ed25519 over the file | minisign text |

Electron's crypto has no BLAKE2b-512, so the app computes it with the `blakejs` package. Both algorithms
therefore work in the app; `-l` is not needed. The trusted comment must name the file (`file:latest.yml` or
`file:latest-mac.yml`). tauri and minisign write that by default; do not replace it with `-t`.

## Cut a release

1. Raise `package.json` "version" (above the last release; 1.12.8 is v0.1.9). Commit.
2. Build the installers as before:
   - `release.yml` (a tag push) builds the Windows installer and, when the Apple secrets exist, the signed
     and notarized dmg AND zip (`yarn dist:mac` now makes both). Today the repo has no Apple secrets.
   - Or `publik-build.yml` builds the unsigned `Simplicity.app` and the Windows installer. On the Mac that
     holds the Developer ID: sign, notarize and staple the app, make the dmg, then make the zip FROM THE
     STAPLED APP:
     `ditto -c -k --sequesterRsrc --keepParent Simplicity.app Simplicity-mac-arm64.zip`.
3. Put `Simplicity-Setup-Windows.exe`, `Simplicity-mac-arm64.dmg` and `Simplicity-mac-arm64.zip` on the
   release (a draft is fine).
4. Make the feed: run **Actions › Update feed** with the tag (or
   `gh workflow run update-feed.yml -f tag=v0.2.0`). It adds `latest.yml`, `latest-mac.yml` and their
   `.sig` files. It adds only missing feed files. Use **force** after you replace an installer file.
   The `feed` job of `release.yml` does the same after a tag build.
5. Check that the release holds the four feed files.

For a publik release (a draft that publik scans): put all the installer files on the draft, then run
**Update feed** for the draft's tag BEFORE the scan. The scan then sees the feed files too.

The update key is needed only in step 4: `update-feed.yml` reads the repo secrets `PUBLIK_UPDATE_KEY`
and `PUBLIK_UPDATE_KEY_PASSWORD`. The builds do not need the key. Without CI, run the same script on a
Mac that has the key in its keychain:

```sh
PUBLIK_UPDATE_KEY="$(security find-generic-password -s publik-update-key -a mann-private -w)" \
PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s publik-update-key -a mann-password -w)" \
node scripts/publik-update-feed.cjs release --tag v0.2.0 --app simplicity --version 1.13.0 --fixed-names \
  --repo Blueturboguy07/Simplicity
```

## Roll back

electron-updater never installs an older version. To roll back:

1. Stop the bad update: delete its feed files, and publik stops serving it.
   `gh release delete-asset vX.Y.Z latest.yml -y` (and `latest.yml.sig`, `latest-mac.yml`, `latest-mac.yml.sig`).
   Apps that have not downloaded it yet get a 404 and stay where they are.
2. Release the good code again with a HIGHER `package.json` version, with its feed. Apps that installed
   the bad version update to it.

## Rotate the key

Every installed app trusts only the keys in `PUBLIK_UPDATE_PUBLIC_KEYS` (`desktop/publik-update-verify.cjs`).

1. Make a new key: `npx @tauri-apps/cli@2.12.4 signer generate -w new.key`. Put the private key and its
   password in the keychain and in the repo secrets. Do not delete the old key yet.
2. Add the new public key (the `RW…` line of `new.key.pub`, base64-decoded) to `PUBLIK_UPDATE_PUBLIC_KEYS`,
   next to the old key. Release that version, signed with the OLD key.
3. Wait until most users run that version. Then sign the feeds with the new key (change the secrets).
4. In a later release, remove the old key from the list.

Users who skip the transition release cannot verify feeds that the new key signs. They must install
again by hand. If the old private key leaks, do the same steps at once. Until users have the new list,
a leaked key lets an attacker sign a feed. On Windows the installer is not code-signed, so the key is
the only protection there. On macOS, Squirrel.Mac still requires the Developer ID signature.

## Test builds and the proof

`.github/workflows/updater-proof.yml` proves the updater on GitHub's macOS (arm64) and Windows runners.
It builds two test versions, N and N+1, with `"publikUpdaterTest": true` in `package.json`. Only a test
build reads these environment variables:

| Variable | Effect (test builds only) |
|---|---|
| `PUBLIK_UPDATE_URL` | replaces `https://publikhq.com/api/updates/simplicity/` |
| `PUBLIK_UPDATER_TEST=report` | writes the running version to `PUBLIK_UPDATER_RESULT` and exits |
| `PUBLIK_UPDATER_TEST=update` | runs the same check, download and install, writes the result, quits to install |

With `PUBLIK_UPDATER_TEST`, the app starts no sign-in, no window, no local search and no server.

Test versions are `0.0.0-updtest.*`. A test feed that the real key signs is therefore never newer than a
real release. The proof puts N+1 on a prerelease with a `v0.0.0-updtest.*` tag and deletes it at the end.
`release.yml` ignores those tags.

The macOS proof signs N and N+1 with an identity made on the runner, through the release's signing
config (`MAC_SIGN=1`: hardened runtime, `desktop/entitlements.mac.plist`). The Developer ID is not in the
repo secrets, so the proof does not cover Developer ID signing or notarization.
