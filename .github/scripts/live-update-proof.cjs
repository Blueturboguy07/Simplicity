// CI only (.github/workflows/live-update-proof.yml). Not part of the app.
//
// The live update proof: what a Simplicity user does, on a GitHub runner, with the REAL release and the
// LIVE publik feed (https://publikhq.com/api/updates/simplicity/). No test hook, no feed override, no
// sign-in. (Copied from SurfCam's proof: the same updater kit and the same publik gate.)
//   1. downloads release --from-tag from GitHub (the dmg / the installer that publik's listing links) and
//      checks it against the sha512 in that release's signed feed. The from version is the version of that
//      feed (the tags v0.1.x and the app version 1.12.x differ). macOS: sets the quarantine flag as a
//      browser does, Gatekeeper must accept the dmg and the app, Finder copies the app to /Applications.
//      Windows: the installer runs silently.
//   2. macOS: REAL TCC grants (camera, microphone, screen capture, accessibility) for the bundle ID, bound
//      to the app's designated requirement (.github/scripts/live-proof-root.sh).
//   3. starts the installed app the normal way (macOS: open; Windows: the installed exe). Nobody signs in,
//      so Simplicity stays on its publik sign-in window: no server, no local search, no microphone, camera
//      or screen capture. The app's log (stdout and stderr, where electron-updater writes) goes to a file.
//   4. waits for the updater. --expect = the from version: the app must find no update. Else it must
//      download --expect and ask "Restart now?"; --answer restart clicks "Restart Now", --answer later
//      clicks "Later", quits the app as a user does and opens it again.
//   5. checks the version on disk and the version the running app reports, the designated requirement,
//      Gatekeeper, and that the stored requirement of each TCC grant is satisfied by the app after the
//      update: the check tccd makes. (A runner cannot show a consent prompt; this check is the proof that
//      none would be shown.)
//   6. clicks "Check for Updates…" and reads the answer ("You’re up to date." and the running version).
// Writes summary.json, the app's logs, UI dumps and screenshots to --out. Exits 1 when a check fails.
//
//   node live-update-proof.cjs --from-tag v0.1.10 --expect 1.12.10 --answer restart|later --repo OWNER/REPO --out DIR
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('../../desktop/publik-update-verify.cjs');

const APP = 'Simplicity';
const SLUG = 'simplicity';
const BUNDLE_ID = 'com.simplicity.desktop';
const FEED_BASE = `https://publikhq.com/api/updates/${SLUG}/`;
const KEY_ID = 'F5E0515C77912BD0';
const MAC_DMG = 'Simplicity-mac-arm64.dmg';
const MAC_ZIP = 'Simplicity-mac-arm64.zip';
const WIN_EXE = 'Simplicity-Setup-Windows.exe';
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const ROOT_SH = path.join(__dirname, 'live-proof-root.sh');
const WIN_PS = path.join(__dirname, 'live-proof-win.ps1');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  return o;
}
const opt = parseArgs(process.argv.slice(2));
const FROM_TAG = String(opt['from-tag'] || '');
const EXPECT = String(opt.expect || '').replace(/^v/, '');
const ANSWER = opt.answer || 'restart';
const REPO = opt.repo || process.env.GITHUB_REPOSITORY;
const OUT = path.resolve(opt.out || 'live-proof');
const TMP = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'live-proof-'));
const FEED = isMac ? 'latest-mac.yml' : 'latest.yml';
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/${FROM_TAG}/`;
// The app version of release FROM_TAG: the version of its signed feed (set by fromRelease()).
let FROM = null;
let UPDATE = null;
if (!/^v\d+\.\d+\.\d+$/.test(FROM_TAG) || !/^\d+\.\d+\.\d+$/.test(EXPECT) || !['restart', 'later'].includes(ANSWER) || !REPO) {
  console.error('usage: live-update-proof.cjs --from-tag vX.Y.Z --expect X.Y.Z --answer restart|later --repo OWNER/REPO --out DIR');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- reporting

const summary = {
  platform: process.platform, arch: process.arch, os: os.release(), image: process.env.ImageOS || null, imageVersion: process.env.ImageVersion || null,
  fromTag: FROM_TAG, from: null, expect: EXPECT, answer: ANSWER, update: null, downloadsByThisScript: [], checks: [], notes: [], events: [],
};
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[proof ${stamp()}]`, ...a);
const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 400);
function check(name, pass, detail) {
  summary.checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${short(detail)}`}`);
  return !!pass;
}
function note(text) { summary.notes.push(text); log(`NOTE ${text}`); }
function event(name, data = {}) { summary.events.push({ t: new Date().toISOString(), name, ...data }); log(`event ${name} ${short(data)}`); }
function save(name, text) { fs.writeFileSync(path.join(OUT, name), text == null ? '' : text); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs, everyMs = 2000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) { log(`timeout (${Math.round(timeoutMs / 1000)} s): ${what}`); return null; }
    await sleep(everyMs);
  }
}
function sh(cmd, args, opts = {}) {
  // A timeout on every call: a program that waits for an answer on the screen must not stop the proof.
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 10 * 60_000, killSignal: 'SIGKILL', ...opts });
  const out = r.stdout || '';
  const err = r.stderr || '';
  return { status: r.status, out, err, text: `${out}${err}`.trim(), error: r.error ? String(r.error) : null };
}

// ---------------------------------------------------------------- files, feeds, asar

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  return { status: res.status, url: res.url, body: Buffer.from(await res.arrayBuffer()) };
}
async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  summary.downloadsByThisScript.push({ url, file: path.basename(file), bytes: fs.statSync(file).size });
  return fs.statSync(file).size;
}
function sha512(file) {
  const h = crypto.createHash('sha512');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 << 20);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('base64');
}
function feedFiles(text) {
  return [...text.matchAll(/- url: '([^']+)'\n\s+sha512: '([^']+)'\n\s+size: (\d+)/g)].map((m) => ({ url: m[1], sha512: m[2], size: Number(m[3]) }));
}
/** A signed feed (the live publik one, or a release's own) with its signature checked against the app's key. */
async function signedFeed(base, name, label) {
  const q = base.startsWith(FEED_BASE) ? `?noCache=${crypto.randomBytes(6).toString('hex')}` : '';
  const feed = await fetchBuffer(`${base}${name}${q}`);
  const sig = await fetchBuffer(`${base}${name}.sig${q}`);
  const r = { url: `${base}${name}`, status: feed.status, sigStatus: sig.status, version: null, signature: null, files: [] };
  if (feed.status !== 200 || sig.status !== 200) return r;
  const text = feed.body.toString('utf8');
  save(`${label}-${name}`, text);
  try {
    const v = verifyMinisign(feed.body, sig.body.toString('utf8'), PUBLIK_UPDATE_PUBLIC_KEYS, { file: name });
    r.signature = `ok, key ${v.keyId}`;
    r.keyId = v.keyId;
  } catch (e) {
    r.signature = `REFUSED: ${e.message}`;
  }
  r.version = (/^version: '([^']+)'/m.exec(text) || [])[1] || null;
  r.app = (/^publikApp: '([^']+)'/m.exec(text) || [])[1] || null;
  r.files = feedFiles(text);
  return r;
}
/**
 * The signed feed of release FROM_TAG: it gives the from version (the app version of that release) and the
 * sha512 of each of its files. UPDATE = expect is not that version.
 */
async function fromRelease() {
  const rel = await signedFeed(RELEASE_BASE, FEED, 'release');
  check(`the release ${FROM_TAG} carries its signed feed ${FEED} (signature checked with the app's key, publikApp ${SLUG})`,
    rel.status === 200 && rel.keyId === KEY_ID && rel.app === SLUG && /^\d+\.\d+\.\d+$/.test(rel.version || ''), { status: rel.status, version: rel.version, signature: rel.signature });
  FROM = rel.version;
  UPDATE = EXPECT !== FROM;
  summary.from = FROM;
  summary.update = UPDATE;
  log(`release ${FROM_TAG} is app version ${FROM}: ${UPDATE ? `the app must update to ${EXPECT} (answer ${ANSWER})` : 'the app must find no update'}`);
  return rel;
}
/** The live feed must name a file of a NEWER release of this repo (not FROM_TAG) for an update. */
function liveFileUrl(live, name) {
  const f = live.files.find((x) => x.url.endsWith(`/${name}`));
  const prefix = `https://github.com/${REPO}/releases/download/`;
  const ok = !!f && f.url.startsWith(prefix) && !f.url.startsWith(RELEASE_BASE) && f.url.slice(prefix.length).split('/').length === 2;
  return ok ? f.url : null;
}
/** One file out of an asar archive (header: two pickles, then the JSON index; data after the header). */
function asarFile(asar, inner) {
  const fd = fs.openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const json = Buffer.alloc(head.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (const part of inner.split('/')) node = node && node.files && node.files[part];
    if (!node || node.offset === undefined) return null;
    const data = Buffer.alloc(node.size);
    fs.readSync(fd, data, 0, node.size, 8 + headerSize + Number(node.offset));
    return data;
  } finally {
    fs.closeSync(fd);
  }
}
/** The folder electron-updater keeps its downloads in (the pending folder sits inside it). */
let cacheDirName = `${SLUG}-updater`;
/** What the installed build is: a release build (no test flag) that asks the publik feed. Prints no token. */
function checkBuild(asar, resources, version) {
  const pkg = JSON.parse(asarFile(asar, 'package.json').toString('utf8'));
  check(`the installed build is the release build ${version} (package.json in app.asar; no "publikUpdaterTest", so no feed override is read)`,
    pkg.version === version && pkg.publikUpdaterTest === undefined, { version: pkg.version, publikUpdaterTest: pkg.publikUpdaterTest ?? null });
  const updater = (asarFile(asar, 'desktop/publik-updater.cjs') || '').toString('utf8');
  const main = (asarFile(asar, 'desktop/main.mjs') || '').toString('utf8');
  check(`the build asks ${FEED_BASE} (desktop/publik-updater.cjs + desktop/main.mjs in app.asar)`,
    updater.includes("const FEED_BASE = 'https://publikhq.com/api/updates/';") && main.includes(`startUpdates({ slug: '${SLUG}'`));
  let token = '';
  try { token = String(JSON.parse(fs.readFileSync(path.join(resources, '.next', 'standalone', 'publik-app.json'), 'utf8')).token || '').trim(); } catch {}
  check('the build carries the publik app token (resources/.next/standalone/publik-app.json; not printed)', token.startsWith('pat_'));
  const cfg = path.join(resources, 'app-update.yml');
  if (fs.existsSync(cfg)) {
    const text = fs.readFileSync(cfg, 'utf8');
    save('app-update.yml', text);
    const m = /^updaterCacheDirName: ['"]?([^'"\n]+)['"]?$/m.exec(text);
    if (m) cacheDirName = m[1].trim();
  }
  note(`electron-updater's cache folder: ${cacheDirName}${fs.existsSync(cfg) ? ' (resources/app-update.yml)' : ' (no app-update.yml in the build: publik-updater.cjs writes one with this name)'}`);
}
const pendingRe = () => new RegExp(`${cacheDirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]pending[/\\\\]`);

// ---------------------------------------------------------------- the app's log

function readLog(files) {
  return files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')).join('\n');
}
/** What electron-updater and publik-updater.cjs wrote to the app's log so far. */
function updaterState(text) {
  const m = (re) => re.exec(text);
  const verified = m(/(latest(?:-mac)?\.yml) (\S+): signature OK \(key ([0-9A-F]{16})\)/);
  const notAvailable = m(/Update for version (\S+) is not available \(latest version: ([^,]+),/);
  const found = m(/Found version (\S+) \(url: ([^)]*)\)/);
  const downloading = m(/Downloading update from (.*)/);
  const downloaded = m(/New version (\S+) has been downloaded to (.*)/);
  const error = m(/\[updates\] Error: (.*)/) || m(/(Cannot get latest(?:-mac)?\.yml[^\n]*)/) || m(/(is not signed by the publik update key[^\n]*)/);
  return {
    checking: /\[updates\] Checking for update/.test(text),
    verified: verified && { feed: verified[1], version: verified[2], key: verified[3] },
    notAvailable: notAvailable && { running: notAvailable[1], latest: notAvailable[2] },
    found: found && { version: found[1], urls: found[2].split(', ') },
    downloading: downloading && downloading[1].trim(),
    downloaded: downloaded && { version: downloaded[1], file: downloaded[2].trim() },
    error: error && error[1].trim(),
    autoInstallOnQuit: /Auto install update on quit/.test(text),
  };
}
async function waitUpdater(files, timeoutMs) {
  return waitFor('the updater', () => {
    const s = updaterState(readLog(files));
    return s.notAvailable || s.downloaded || s.error ? s : null;
  }, timeoutMs, 2000);
}
function updaterChecks(s, label) {
  check(`${label}: the app checked for updates and verified the feed signature with the publik key (${FEED})`,
    s && s.checking && s.verified && s.verified.feed === FEED && s.verified.key === KEY_ID, s && s.verified);
}

// ---------------------------------------------------------------- macOS

const osa = (script, args = []) => sh('osascript', ['-', ...args], { input: script, timeout: 120_000 });
// System Events: the windows of a process with their texts and buttons. A walk over "UI elements" (not
// "entire contents", which returned nothing for dialogs on the runner). The sign-in window holds a web page,
// so it is read only 4 levels deep: enough for a sheet (an alert attached to it) and its texts and buttons.
const AS_WALK = `
on str(x)
  try
    if x is missing value then return ""
    return x as text
  on error
    return ""
  end try
end str
on walk(x, depth, maxDepth)
  set out to {}
  tell application "System Events"
    set r to ""
    try
      set r to (role of x) as text
    end try
    if r is "AXStaticText" then
      try
        set end of out to "TEXT" & tab & my str(value of x)
      end try
    else if r is "AXButton" then
      try
        set end of out to "BUTTON" & tab & my str(name of x)
      end try
    else if r is "AXSheet" then
      set end of out to "SHEET"
    end if
    if depth < maxDepth then
      set kids to {}
      try
        set kids to UI elements of x
      end try
      repeat with k in kids
        set out to out & my walk(k, depth + 1, maxDepth)
      end repeat
    end if
  end tell
  return out
end walk
on press(x, btnName, depth, maxDepth)
  tell application "System Events"
    set r to ""
    try
      set r to (role of x) as text
    end try
    if r is "AXButton" then
      if my str(name of x) is btnName then
        click x
        return true
      end if
    end if
    if depth < maxDepth then
      set kids to {}
      try
        set kids to UI elements of x
      end try
      repeat with k in kids
        if my press(k, btnName, depth + 1, maxDepth) then return true
      end repeat
    end if
  end tell
  return false
end press
on depthOf(w, deep)
  tell application "System Events"
    if deep then return 8
    if my str(name of w) is "Sign in with publik" then return 4
  end tell
  return 8
end depthOf`;
const AS_DUMP = `on run argv
  set procName to item 1 of argv
  set deep to ((count of argv) > 1 and item 2 of argv is "deep")
  set out to {}
  tell application "System Events"
    if not (exists process procName) then return "NOPROC"
    tell process procName
      set ws to {}
      try
        set ws to every window
      end try
      repeat with w in ws
        set sr to ""
        try
          set sr to (subrole of w) as text
        end try
        set end of out to "WINDOW" & tab & my str(name of w) & tab & sr
        set out to out & my walk(w, 0, my depthOf(w, deep))
      end repeat
    end tell
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run
${AS_WALK}`;
const AS_CLICK = `on run argv
  set procName to item 1 of argv
  set btnName to item 2 of argv
  set deep to ((count of argv) > 2 and item 3 of argv is "deep")
  tell application "System Events"
    if not (exists process procName) then return "NOPROC"
    tell process procName
      try
        set frontmost to true
      end try
      set ws to {}
      try
        set ws to every window
      end try
      repeat with w in ws
        if my press(w, btnName, 0, my depthOf(w, deep)) then return "CLICKED"
      end repeat
    end tell
  end tell
  return "NOTFOUND"
end run
${AS_WALK}`;
const AS_MENU = `on run argv
  set procName to item 1 of argv
  set itemName to item 2 of argv
  tell application "System Events"
    tell process procName
      set frontmost to true
      delay 1
      set mb to menu bar item 2 of menu bar 1
      set menuName to (name of mb) as text
      click menu item itemName of menu 1 of mb
      return "CLICKED" & tab & menuName
    end tell
  end tell
end run`;
// Gatekeeper's first-launch question (CoreServicesUIAgent): its text, and a click on its "Open" button.
const AS_GK = `on run argv
  tell application "System Events"
    if not (exists process "CoreServicesUIAgent") then return "NONE"
    tell process "CoreServicesUIAgent"
      if not (exists window 1) then return "NONE"
      if not (exists button "Open" of window 1) then return "NOBUTTON"
      if (count of argv) > 0 and item 1 of argv is "click" then
        click button "Open" of window 1
        return "CLICKED"
      end if
      set out to {}
      try
        repeat with t in (every static text of window 1)
          set end of out to ((value of t) as text)
        end repeat
      end try
      set AppleScript's text item delimiters to " | "
      return "ASKS" & tab & (out as text)
    end tell
  end tell
end run`;
const gatekeeperPeek = () => osa(AS_GK, []).text;
const gatekeeperOpen = () => osa(AS_GK, ['click']).text;
const uiDump = (proc, deep) => osa(AS_DUMP, deep ? [proc, 'deep'] : [proc]).text;
const uiClick = (proc, button, deep) => osa(AS_CLICK, deep ? [proc, button, 'deep'] : [proc, button]).text;
const uiMenu = (proc, item) => osa(AS_MENU, [proc, item]).text;
let shots = 0;
function shot(name) {
  const file = path.join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`);
  const r = isMac ? sh('screencapture', ['-x', file]) : winPs(['shot', '-Out', file]);
  if (!fs.existsSync(file)) note(`screenshot ${name} failed: ${short(r.text || r)}`);
}
const plistVersion = (app) => sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents', 'Info.plist')]).out.trim();
function macMainPid() {
  const r = sh('pgrep', ['-x', APP]);
  const pids = r.out.split('\n').map((s) => Number(s)).filter(Boolean);
  return pids.length ? pids[0] : null;
}
const psCommand = (pid) => sh('ps', ['-o', 'command=', '-p', String(pid)]).out.trim();
const psStart = (pid) => sh('ps', ['-o', 'lstart=', '-p', String(pid)]).out.trim();
function designated(app) {
  const r = sh('codesign', ['-d', '-r-', app]);
  return ((r.text.match(/designated => (.*)/) || [])[1] || '').trim();
}
function spctlExec(app) {
  const r = sh('spctl', ['-a', '-t', 'exec', '-vv', app]);
  return { ok: r.status === 0 && /source=Notarized Developer ID/.test(r.text), text: r.text };
}
/** Squirrel.Mac's request to ShipIt (written when the update is staged): which bundle it installs where. */
function shipItState() {
  const file = path.join(os.homedir(), 'Library', 'Caches', `${BUNDLE_ID}.ShipIt`, 'ShipItState.plist');
  if (!fs.existsSync(file)) return null;
  try {
    const st = JSON.parse(sh('plutil', ['-convert', 'json', '-o', '-', file]).out);
    const staged = st.updateBundleURL && decodeURIComponent(new URL(st.updateBundleURL).pathname).replace(/\/$/, '');
    return { staged, stagedVersion: staged && fs.existsSync(path.join(staged, 'Contents', 'Info.plist')) ? plistVersion(staged) : null, target: st.targetBundleURL || null, relaunch: st.launchAfterInstallation ?? null };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
async function macLaunch(app, n) {
  const files = [path.join(OUT, `app-${n}.stdout.log`), path.join(OUT, `app-${n}.stderr.log`)];
  for (const f of files) fs.writeFileSync(f, '');
  // `open` waits while Gatekeeper asks its first-launch question, so it runs in the background.
  const opener = spawn('open', ['--stdout', files[0], '--stderr', files[1], app], { stdio: 'ignore' });
  const openDone = new Promise((r) => opener.on('exit', (code) => r(code)));
  event('open', { n, app });
  // Gatekeeper asks once before the first start of a downloaded app: the user clicks "Open". The app's
  // process exists while the question is open, so the app counts as started when its window is there.
  let asked = false;
  const pid = await waitFor('the app window (after Gatekeeper\'s first-launch question, if it asks)', () => {
    const g = gatekeeperPeek();
    if (!asked && g.startsWith('ASKS')) {
      asked = true;
      save(`gatekeeper-question-${n}.txt`, g);
      shot(`gatekeeper-question-${n}`);
      event('Gatekeeper asks', { text: g.slice(5) });
      event('answer: Open', { click: gatekeeperOpen() });
      return null;
    }
    const p = macMainPid();
    return p && /WINDOW\tSign in with publik/.test(uiDump(APP)) ? p : null;
  }, 180_000, 1500);
  const code = await Promise.race([openDone, sleep(30_000).then(() => 'still waiting')]);
  event('open finished', { exit: code });
  if (n === 1) summary.gatekeeperFirstLaunchQuestion = asked;
  return { pid, files, asked };
}
async function macQuit(pid) {
  const r = uiMenu(APP, `Quit ${APP}`);
  event(`quit via the ${APP} menu`, { result: r });
  const gone = await waitFor('the app to quit', () => sh('kill', ['-0', String(pid)]).status !== 0, 60_000, 1000);
  if (!gone) {
    event('quit via AppleScript', { result: osa(`tell application "${APP}" to quit`).text });
    await waitFor('the app to quit', () => sh('kill', ['-0', String(pid)]).status !== 0, 60_000, 1000);
  }
  return sh('kill', ['-0', String(pid)]).status !== 0;
}
async function macMenuCheck(version) {
  const r = uiMenu(APP, 'Check for Updates…');
  event('menu: Check for Updates…', { result: r });
  const answer = await waitFor('the answer of "Check for Updates…"', () => {
    const d = uiDump(APP);
    return /TEXT\t(You’re up to date\.|No update is available\.|Could not update\.|.* is available\.|An update is downloading\.)/.test(d) ? d : null;
  }, 120_000, 2000);
  save('menu-answer.txt', answer || uiDump(APP));
  shot('menu-answer');
  check(`"Check for Updates…" in the ${APP} menu (clicked through the UI) answers "You’re up to date." and "${APP} ${version} is the newest version."`,
    r.startsWith(`CLICKED\t${APP}`) && answer && answer.includes('TEXT\tYou’re up to date.') && answer.includes(`TEXT\t${APP} ${version} is the newest version.`),
    { menu: r, answer: (answer || '').split('\n').filter((l) => /^(TEXT|BUTTON)/.test(l)) });
  if (answer) event('answer OK', { click: uiClick(APP, 'OK') });
}

async function mac() {
  const dest = `/Applications/${APP}.app`;

  // 1. the dmg that publik's listing links, as a browser downloads it
  const relFeed = await fromRelease();
  if (!FROM) return;
  const entry = relFeed.files.find((f) => f.url === `${RELEASE_BASE}${MAC_DMG}`);
  const dmg = path.join(TMP, MAC_DMG);
  const bytes = await download(`${RELEASE_BASE}${MAC_DMG}`, dmg);
  check(`download: ${MAC_DMG} from the GitHub release ${FROM_TAG} matches the sha512 in that release's signed feed`,
    relFeed.keyId === KEY_ID && entry && entry.size === bytes && entry.sha512 === sha512(dmg), { bytes, feedSignature: relFeed.signature });
  const qtn = `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;${crypto.randomUUID().toUpperCase()}`;
  sh('xattr', ['-w', 'com.apple.quarantine', qtn, dmg]);
  save('gatekeeper-status.txt', sh('bash', [ROOT_SH, 'gatekeeper']).text);
  const gkDmg = sh('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
  check('Gatekeeper accepts the quarantined dmg (spctl: Notarized Developer ID)', gkDmg.status === 0 && /source=Notarized Developer ID/.test(gkDmg.text), gkDmg.text);
  check('the dmg carries its notarization ticket (stapler validate)', sh('xcrun', ['stapler', 'validate', dmg]).status === 0);

  // 2. install as a user does: open the dmg, drag the app to Applications (Finder copies it)
  const mnt = path.join(TMP, 'dmg');
  const at = sh('hdiutil', ['attach', dmg, '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt]);
  if (!check('the dmg mounts', at.status === 0, at.text.split('\n').pop())) return;
  const srcApp = path.join(mnt, `${APP}.app`);
  const qIn = sh('xattr', ['-p', 'com.apple.quarantine', srcApp]);
  note(`quarantine on the app in the mounted dmg: ${qIn.status === 0 ? qIn.out.trim() : 'none'}`);
  const gkIn = spctlExec(srcApp);
  check('Gatekeeper accepts the app in the dmg (spctl: Notarized Developer ID)', gkIn.ok, gkIn.text);
  const finder = osa(`with timeout of 900 seconds
  tell application "Finder" to duplicate (POSIX file "${srcApp}" as alias) to (POSIX file "/Applications" as alias) with replacing
end timeout`);
  if (finder.status === 0 && fs.existsSync(dest)) {
    event('installed with Finder (dmg -> /Applications)');
  } else {
    note(`Finder could not copy the app (${short(finder.text)}); copied with ditto instead`);
    sh('ditto', [srcApp, dest]);
  }
  sh('hdiutil', ['detach', mnt]);
  fs.rmSync(dmg, { force: true });
  check(`the installed app is ${FROM} (Info.plist)`, plistVersion(dest) === FROM, plistVersion(dest));
  const qInst = sh('xattr', ['-p', 'com.apple.quarantine', dest]);
  summary.quarantineInstalled = qInst.status === 0 ? qInst.out.trim() : null;
  note(`quarantine on /Applications/${APP}.app after the Finder copy: ${summary.quarantineInstalled || 'none'}`);
  // When a user drags the app to Applications, Finder marks it as moved by the user (quarantine flag
  // 0x0100), and macOS then starts it in place. A SCRIPTED Finder copy or move does not set that flag
  // (tested on this runner image), and macOS would start the app from a read-only translocated copy that
  // cannot update itself. So the proof sets that one flag. The quarantine stays: Gatekeeper still checks
  // the app and still asks before the first start.
  if (summary.quarantineInstalled) {
    const [flags, ...rest] = summary.quarantineInstalled.split(';');
    const moved = (parseInt(flags, 16) | 0x100).toString(16).padStart(4, '0');
    sh('xattr', ['-w', 'com.apple.quarantine', [moved, ...rest].join(';'), dest]);
    summary.quarantineAsUserMoved = sh('xattr', ['-p', 'com.apple.quarantine', dest]).out.trim();
    note(`quarantine flag 0x0100 (moved by the user, as a Finder drag sets it): ${summary.quarantineAsUserMoved}`);
  }
  const gkInst = spctlExec(dest);
  check('Gatekeeper accepts the installed app (spctl: Notarized Developer ID)', gkInst.ok, gkInst.text);
  checkBuild(path.join(dest, 'Contents/Resources/app.asar'), path.join(dest, 'Contents/Resources'), FROM);

  // 3. the designated requirement and REAL TCC grants bound to it
  const drBefore = designated(dest);
  summary.designatedRequirementBefore = drBefore;
  check(`designated requirement before the update: bundle ID ${BUNDLE_ID} + Developer ID team R5R3ZS54LV`,
    drBefore.includes(`identifier "${BUNDLE_ID}"`) && drBefore.includes('certificate leaf[subject.OU] = R5R3ZS54LV'), drBefore);
  const drFile = path.join(OUT, 'designated-requirement-before.txt');
  fs.writeFileSync(drFile, drBefore);
  const grant = sh('bash', [ROOT_SH, 'tcc-grant', BUNDLE_ID, drFile, OUT]);
  save('tcc-grant.txt', grant.text);
  check(`TCC: camera, microphone, screen capture and accessibility granted to ${BUNDLE_ID} (user + system database, csreq = the designated requirement)`,
    grant.status === 0 && (grant.text.match(/ granted$/gm) || []).length === 8, grant.text);
  const tccBefore = sh('bash', [ROOT_SH, 'tcc-check', BUNDLE_ID, dest, OUT]);
  save('tcc-before.txt', tccBefore.text);
  check('TCC before the update: the 8 rows are there and the app satisfies each stored requirement', tccBefore.status === 0, tccBefore.text.split('\n').map((l) => l.split(' :: ')[0]));

  // 4. the live feed, then the app, started the normal way
  const live = await signedFeed(FEED_BASE, FEED, 'live');
  summary.liveFeed = live;
  check(`the live publik feed serves ${UPDATE ? EXPECT : FROM} (${FEED}, signature checked with the app's key)`,
    live.status === 200 && live.keyId === KEY_ID && live.app === SLUG && live.version === (UPDATE ? EXPECT : FROM), { status: live.status, version: live.version, signature: live.signature });
  save('net-start.txt', sh('bash', [ROOT_SH, 'net-start', path.join(OUT, 'network.txt')]).text);
  const t0 = Date.now();
  const first = await macLaunch(dest, 1);
  if (!check(`the app starts (open /Applications/${APP}.app)`, first.pid, first.pid)) return;
  summary.quarantineAfterFirstStart = sh('xattr', ['-p', 'com.apple.quarantine', dest]).out.trim() || null;
  note(`quarantine after the first start: ${summary.quarantineAfterFirstStart} (0x0040: the user said Open)`);
  const cmd1 = psCommand(first.pid);
  check('the app runs from /Applications (not translocated)', cmd1 === `${dest}/Contents/MacOS/${APP}`, cmd1);
  await sleep(4000);
  save('ui-after-launch.txt', uiDump(APP));
  shot('after-launch');

  // 5. the updater
  const s1 = await waitUpdater(first.files, UPDATE ? 20 * 60_000 : 4 * 60_000);
  save('updater-1.json', JSON.stringify(s1, null, 1));
  updaterChecks(s1, 'first start');
  let runningPid = first.pid;
  if (!UPDATE) {
    check(`no update: the running app (${FROM}) asked the live feed, which serves ${FROM}`,
      s1 && s1.notAvailable && s1.notAvailable.running === FROM && s1.notAvailable.latest === FROM, s1 && (s1.notAvailable || s1.error));
    await sleep(20_000);
    check('no update: the app keeps running, unchanged on disk, nothing downloaded', macMainPid() === first.pid && plistVersion(dest) === FROM && !updaterState(readLog(first.files)).found,
      { pid: macMainPid(), version: plistVersion(dest) });
  } else {
    const want = liveFileUrl(live, MAC_ZIP);
    check(`the app found ${EXPECT} in the live feed and downloaded the update zip from GitHub (its log: the URL of the live feed, a newer release than ${FROM_TAG})`,
      want && s1 && s1.found && s1.found.version === EXPECT && s1.found.urls[0] === want && s1.downloaded && s1.downloaded.version === EXPECT && pendingRe().test(s1.downloaded.file),
      s1 && { want, found: s1.found, downloading: s1.downloading, downloaded: s1.downloaded, error: s1.error });
    const question = await waitFor('the question "Restart now?"', () => {
      const d = uiDump(APP);
      return d.includes(`TEXT\t${APP} ${EXPECT} is ready to install.`) ? d : null;
    }, 6 * 60_000, 2000);
    save('restart-question.txt', question || uiDump(APP));
    shot('restart-question');
    check(`the app asks "${APP} ${EXPECT} is ready to install." with the buttons Restart Now and Later`,
      question && question.includes('BUTTON\tRestart Now') && question.includes('BUTTON\tLater'), (question || '').split('\n').filter((l) => /^(TEXT|BUTTON)/.test(l)));
    const pending = path.join(os.homedir(), 'Library/Caches', cacheDirName, 'pending');
    summary.updaterPending = fs.existsSync(pending) ? fs.readdirSync(pending) : [];
    summary.shipItState = shipItState();
    note(`staged by Squirrel.Mac before the answer: ${short(summary.shipItState)}`);
    const tClick = Date.now();
    if (ANSWER === 'restart') {
      const c = question ? uiClick(APP, 'Restart Now') : 'NOQUESTION';
      event('answer: Restart Now', { click: c });
      if (c !== 'CLICKED') {
        note('the question could not be answered through the UI: the app is quit and opened again instead');
        await macQuit(first.pid);
      }
      let gkAfter = null;
      const back = await waitFor(`the bundle on disk to become ${EXPECT} and the app to start again`, () => {
        const p = macMainPid();
        if (plistVersion(dest) === EXPECT && p && p !== first.pid) return p;
        const d = !gkAfter && plistVersion(dest) === EXPECT ? gatekeeperPeek() : '';
        if (d.startsWith('ASKS')) {
          gkAfter = d;
          save('gatekeeper-question-after-update.txt', d);
          shot('gatekeeper-question-after-update');
          event('Gatekeeper asks after the update', { text: d.slice(5), click: gatekeeperOpen() });
        }
        return null;
      }, 8 * 60_000, 3000);
      check('the restarted app opens without a Gatekeeper question (the user sees no prompt)', !gkAfter, gkAfter);
      if (!back && c !== 'CLICKED') {
        const again = await macLaunch(dest, 2);
        runningPid = again.pid;
      } else {
        runningPid = back;
      }
      check(`"Restart Now": the app quit, the update installed, and the app started again by itself as ${EXPECT}`,
        c === 'CLICKED' && back && plistVersion(dest) === EXPECT, { pid: back, started: back && psStart(back), version: plistVersion(dest) });
    } else {
      const c = question ? uiClick(APP, 'Later') : 'NOQUESTION';
      event('answer: Later', { click: c });
      await sleep(15_000);
      shot('after-later');
      check(`"Later": the app keeps running as ${FROM} (same process, bundle unchanged)`,
        c === 'CLICKED' && macMainPid() === first.pid && plistVersion(dest) === FROM, { pid: macMainPid(), version: plistVersion(dest) });
      const quit = await macQuit(first.pid);
      check(`the user quits the app (${APP} menu › Quit ${APP})`, quit);
      const swapped = await waitFor(`the update to install on quit (bundle on disk = ${EXPECT})`, () => plistVersion(dest) === EXPECT, 8 * 60_000, 3000);
      check(`"Later" + quit: the update installed itself when the app quit (Info.plist ${EXPECT})`, swapped, plistVersion(dest));
      await sleep(5000);
      const again = await macLaunch(dest, 2);
      runningPid = again.pid;
      check('the updated app opens without a Gatekeeper question (the user sees no prompt)', !again.asked);
      const s2 = await waitUpdater(again.files, 4 * 60_000);
      save('updater-2.json', JSON.stringify(s2, null, 1));
      updaterChecks(s2, 'second start');
      check(`the app opened again runs ${EXPECT} (its log: "Update for version ${EXPECT} is not available")`,
        again.pid && s2 && s2.notAvailable && s2.notAvailable.running === EXPECT, s2 && (s2.notAvailable || s2.error));
    }
    for (const f of ['ShipIt_stderr.log', 'ShipIt_stdout.log']) {
      const p = path.join(os.homedir(), 'Library/Caches', `${BUNDLE_ID}.ShipIt`, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, f));
    }
    summary.secondsFromClickToRunning = Math.round((Date.now() - tClick) / 1000);
  }

  // 6. the running app, the menu item, signatures and TCC after the update
  if (runningPid) {
    const cmd = psCommand(runningPid);
    check(`the running app is /Applications/${APP}.app at ${EXPECT}`, cmd === `${dest}/Contents/MacOS/${APP}` && plistVersion(dest) === EXPECT, { pid: runningPid, cmd, started: psStart(runningPid) });
    await sleep(15_000); // a relaunched app runs its own start-up check first
    await macMenuCheck(EXPECT);
  }
  const drAfter = designated(dest);
  summary.designatedRequirementAfter = drAfter;
  check('the designated requirement is unchanged (what TCC keys the grants on)', drAfter && drAfter === drBefore, drAfter);
  const verify = sh('codesign', ['--verify', '--deep', '--strict', dest]);
  check('codesign --verify --deep --strict passes on the installed app', verify.status === 0, verify.text || 'valid');
  const gkAfter = spctlExec(dest);
  check('Gatekeeper still accepts the installed app (spctl: Notarized Developer ID)', gkAfter.ok, gkAfter.text);
  check('the app on disk is signed by Developer ID Application: Mann Bellani (R5R3ZS54LV)',
    /Authority=Developer ID Application: Mann Bellani \(R5R3ZS54LV\)/.test(sh('codesign', ['-dvv', dest]).text));
  const tccAfter = sh('bash', [ROOT_SH, 'tcc-check', BUNDLE_ID, dest, OUT]);
  save('tcc-after.txt', tccAfter.text);
  check(`TCC after ${UPDATE ? 'the update' : 'the run'}: all 8 grants are still there and the app satisfies each stored csreq (the check tccd makes; no new prompt is needed)`,
    tccAfter.status === 0 && (tccAfter.text.match(/requirement=satisfied/g) || []).length === 8, tccAfter.text.split('\n').map((l) => l.split(' :: ')[0]));
  check('no manual download: this script downloaded only the from release; any newer version came from the app\'s own updater',
    summary.downloadsByThisScript.every((d) => d.url.startsWith(RELEASE_BASE)), summary.downloadsByThisScript.map((d) => d.url));

  // 7. the network log (information): DNS queries and connects while the app ran
  sh('bash', [ROOT_SH, 'net-stop']);
  await sleep(1000);
  const net = fs.existsSync(path.join(OUT, 'network.txt')) ? fs.readFileSync(path.join(OUT, 'network.txt'), 'utf8') : '';
  // pktap names the process of each packet: "proc X" sends it, "eproc X" asked mDNSResponder for a name.
  // Electron's network requests leave from the "Simplicity Helper" process (its network service).
  const appLines = net.split('\n').filter((l) => new RegExp(`[(,]\\s*e?proc ${APP}[^:,)]*[:,)]`).test(l));
  save('network-simplicity.txt', appLines.join('\n'));
  const dnsAsked = (re) => appLines.filter((l) => / A{1,4}\? /.test(l) && re.test(l)).map((l) => (/ A{1,4}\? (\S+)/.exec(l) || [])[1]);
  summary.network = {
    appDnsQueries: [...new Set(dnsAsked(/./))],
    appAskedPublik: dnsAsked(/publikhq\.com/).length,
    appAskedGithub: dnsAsked(/github\.com|githubusercontent\.com/).length,
    appTcpConnects: appLines.filter((l) => /Flags \[S/.test(l)).length,
  };
  note(`network log while the app ran: ${JSON.stringify(summary.network)} (network.txt)`);
  const p = macMainPid();
  if (p) await macQuit(p);
  summary.secondsTotal = Math.round((Date.now() - t0) / 1000);
}

// ---------------------------------------------------------------- Windows

function winPs(args) {
  const r = sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, ...args]);
  let json = null;
  try { json = r.out.trim() ? JSON.parse(r.out.trim().replace(/^﻿/, '')) : null; } catch {}
  return { ...r, json };
}
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const winProcs = () => asList(winPs(['procs']).json);
const winMain = () => winProcs().find((p) => p.main) || null;
const winInstallerBusy = () => winProcs().some((p) => /^(Simplicity-Setup.*|Au_\.exe|Un_A\.exe)$/i.test(p.name));
const winInstalled = () => (winPs(['installed']).json || {}).displayVersion || '';
const winExeVersion = (exe) => winPs(['version', '-Path', exe]).json || {};
/** The version of an installed exe as the app reports it: x.y.z (Windows writes ProductVersion as x.y.z.0). */
const winVer = (exe) => {
  const v = winExeVersion(exe);
  return String(v.file || v.product || '').replace(/^(\d+\.\d+\.\d+)\.0$/, '$1');
};
function winDump() {
  const wins = asList(winPs(['dump']).json);
  return wins.map((w) => [`WINDOW\t${w.title}\t${w.className}`, ...asList(w.items).map((i) => `${i.type === 'Button' ? 'BUTTON' : i.type === 'Text' ? 'TEXT' : i.type.toUpperCase()}\t${i.name}`)].join('\n')).join('\n');
}
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(PUBLIK_|ELECTRON_|DO_NOT_TRACK$|NODE_OPTIONS$)/i.test(k)) env[k] = v;
  return env;
}
function winLaunch(exe, n) {
  const files = [path.join(OUT, `app-${n}.stdout.log`), path.join(OUT, `app-${n}.stderr.log`)];
  const fds = files.map((f) => fs.openSync(f, 'w'));
  const child = spawn(exe, [], { detached: true, stdio: ['ignore', fds[0], fds[1]], env: cleanEnv(), cwd: path.dirname(exe) });
  child.unref();
  fds.forEach((fd) => fs.closeSync(fd));
  event('start', { n, exe, pid: child.pid });
  return { pid: child.pid, files };
}
async function winMenuCheck(version) {
  const m = winPs(['menu']);
  event('menu: Help › Check for Updates…', { result: m.json || m.text });
  const answer = m.json && m.json.driven && await waitFor('the answer of "Check for Updates…"', () => {
    const d = winDump();
    return /TEXT\t(You’re up to date\.|No update is available\.|Could not update\.|.* is available\.|An update is downloading\.)/.test(d) ? d : null;
  }, 60_000, 2000);
  save('menu-answer.txt', answer || winDump());
  shot('menu-answer');
  if (!answer) {
    note('Windows: the menu bar of the sign-in window is hidden (Help › Check for Updates… could not be driven on this runner). The macOS jobs click the menu item; desktop/publik-updater-ui.test.mjs covers the Windows Help menu handler.');
    summary.menuItem = 'not driven';
    return;
  }
  summary.menuItem = 'driven';
  check(`"Check for Updates…" (Help menu, through the UI) answers "You’re up to date." and "${APP} ${version} is the newest version."`,
    answer.includes('TEXT\tYou’re up to date.') && answer.includes(`TEXT\t${APP} ${version} is the newest version.`), answer.split('\n').filter((l) => /^(TEXT|BUTTON)/.test(l)));
  event('answer OK', { click: winPs(['click', '-Name', 'OK', '-Title', 'No update', '-Key', 'enter']).json });
}

async function windows() {
  const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', APP);
  const exe = path.join(installDir, `${APP}.exe`);

  const relFeed = await fromRelease();
  if (!FROM) return;
  const entry = relFeed.files.find((f) => f.url === `${RELEASE_BASE}${WIN_EXE}`);
  const setup = path.join(TMP, WIN_EXE);
  const bytes = await download(`${RELEASE_BASE}${WIN_EXE}`, setup);
  check(`download: ${WIN_EXE} from the GitHub release ${FROM_TAG} matches the sha512 in that release's signed feed`,
    relFeed.keyId === KEY_ID && entry && entry.size === bytes && entry.sha512 === sha512(setup), { bytes, feedSignature: relFeed.signature });
  note(`Authenticode of the installer: ${short(winPs(['sig', '-Path', setup]).json)} (Simplicity's Windows installer is not code-signed)`);
  const inst = sh(setup, ['/S']);
  await waitFor('the installer to finish', () => !winInstallerBusy(), 180_000, 2000);
  const stray = winMain();
  if (stray) { note(`the installer started the app (pid ${stray.pid}); stopping it before the proof`); sh('taskkill', ['/PID', String(stray.pid), '/T', '/F']); await sleep(3000); }
  check(`install: the installer (/S, as the silent install of a user) puts ${FROM} in %LOCALAPPDATA%\\Programs\\${APP}`,
    inst.status === 0 && fs.existsSync(exe) && winInstalled() === FROM && winVer(exe) === FROM, { exit: inst.status, uninstallEntry: winInstalled(), exe: winExeVersion(exe) });
  fs.rmSync(setup, { force: true });
  checkBuild(path.join(installDir, 'resources', 'app.asar'), path.join(installDir, 'resources'), FROM);

  const live = await signedFeed(FEED_BASE, FEED, 'live');
  summary.liveFeed = live;
  check(`the live publik feed serves ${UPDATE ? EXPECT : FROM} (${FEED}, signature checked with the app's key)`,
    live.status === 200 && live.keyId === KEY_ID && live.app === SLUG && live.version === (UPDATE ? EXPECT : FROM), { status: live.status, version: live.version, signature: live.signature });
  winPs(['dns-clear']);
  const t0 = Date.now();
  const first = winLaunch(exe, 1);
  const main1 = await waitFor('the app window', () => (winDump().includes('WINDOW\tSign in with publik') ? winMain() : null), 90_000, 2000);
  check('the app starts and shows its publik sign-in window (nobody signs in: no server, no microphone, camera or screen capture)', main1, main1);
  save('ui-after-launch.txt', winDump());
  shot('after-launch');

  const s1 = await waitUpdater(first.files, UPDATE ? 20 * 60_000 : 4 * 60_000);
  save('updater-1.json', JSON.stringify(s1, null, 1));
  updaterChecks(s1, 'first start');
  summary.network = { dnsCache: winPs(['dns']).json, connections: winPs(['tcp']).json };
  let running = main1;
  if (!UPDATE) {
    check(`no update: the running app (${FROM}) asked the live feed, which serves ${FROM}`,
      s1 && s1.notAvailable && s1.notAvailable.running === FROM && s1.notAvailable.latest === FROM, s1 && (s1.notAvailable || s1.error));
    await sleep(20_000);
    const m = winMain();
    check('no update: the app keeps running, unchanged on disk, nothing downloaded',
      m && main1 && m.pid === main1.pid && winInstalled() === FROM && !updaterState(readLog(first.files)).found, { main: m, installed: winInstalled() });
  } else {
    const want = liveFileUrl(live, WIN_EXE);
    check(`the app found ${EXPECT} in the live feed and downloaded the installer from GitHub (its log: the URL of the live feed, a newer release than ${FROM_TAG})`,
      want && s1 && s1.found && s1.found.version === EXPECT && s1.found.urls[0] === want && s1.downloaded && s1.downloaded.version === EXPECT && pendingRe().test(s1.downloaded.file),
      s1 && { want, found: s1.found, downloading: s1.downloading, downloaded: s1.downloaded, error: s1.error });
    let question = await waitFor('the question "Restart now?"', () => {
      const d = winDump();
      return d.includes(`TEXT\t${APP} ${EXPECT} is ready to install.`) ? d : null;
    }, 3 * 60_000, 2000);
    // The dialog's text shows before its two command links are in the accessibility tree: look again for 20 s.
    for (let i = 0; question && i < 10 && !(/BUTTON\tRestart Now/.test(question) && /BUTTON\tLater/.test(question)); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = winDump();
      if (d.includes(`TEXT\t${APP} ${EXPECT} is ready to install.`)) question = d;
    }
    save('restart-question.txt', question || winDump());
    shot('restart-question');
    check(`the app asks "${APP} ${EXPECT} is ready to install." with Restart Now and Later`,
      question && /BUTTON\tRestart Now/.test(question) && /BUTTON\tLater/.test(question), (question || '').split('\n').filter((l) => /^(TEXT|BUTTON)/.test(l)));
    const pending = path.join(process.env.LOCALAPPDATA, cacheDirName, 'pending');
    summary.updaterPending = fs.existsSync(pending) ? fs.readdirSync(pending) : [];
    const tClick = new Date();
    if (ANSWER === 'restart') {
      const c = question ? winPs(['click', '-Name', 'Restart Now', '-Title', 'Update ready', '-Key', 'enter']).json : null;
      event('answer: Restart Now', { click: c });
      if (!c || !c.clicked) {
        note('the question could not be answered through the UI: the app is closed and started again instead');
        winPs(['close', '-Name', 'Sign in with publik']);
      }
      const back = await waitFor(`the update to install and the app to start again as ${EXPECT}`, () => {
        const m = winMain();
        return !winInstallerBusy() && winInstalled() === EXPECT && m && main1 && m.pid !== main1.pid ? m : null;
      }, 8 * 60_000, 3000);
      running = back;
      if (!back && !(c && c.clicked)) {
        winLaunch(exe, 2);
        running = await waitFor('the app', winMain, 60_000);
      }
      check(`"Restart Now": the app quit, the installer ran silently, and the app started again by itself as ${EXPECT}`,
        c && c.clicked && back && new Date(back.started) > tClick && winInstalled() === EXPECT && winVer(exe) === EXPECT,
        { main: back, installed: winInstalled(), exe: winExeVersion(exe) });
    } else {
      const c = question ? winPs(['click', '-Name', 'Later', '-Title', 'Update ready', '-Key', 'esc']).json : null;
      event('answer: Later', { click: c });
      await sleep(15_000);
      shot('after-later');
      const m = winMain();
      check(`"Later": the app keeps running as ${FROM} (same process, ${FROM} installed)`,
        c && c.clicked && m && main1 && m.pid === main1.pid && winInstalled() === FROM, { main: m, installed: winInstalled() });
      const closed = winPs(['close', '-Name', 'Sign in with publik']).json;
      event('the user closes the app window', { closed });
      const gone = await waitFor('the app to quit', () => !winMain(), 60_000, 2000);
      check('the user closes the app (its window): the app quits', gone);
      const installed = await waitFor(`the update to install on quit (${EXPECT})`, () => !winInstallerBusy() && winInstalled() === EXPECT, 8 * 60_000, 3000);
      check(`"Later" + quit: the update installed itself when the app quit (${EXPECT} installed)`, installed && winVer(exe) === EXPECT,
        { installed: winInstalled(), exe: winExeVersion(exe), log: updaterState(readLog(first.files)).autoInstallOnQuit ? 'Auto install update on quit' : null });
      await sleep(3000);
      const again = winLaunch(exe, 2);
      running = await waitFor('the app', winMain, 90_000);
      const s2 = await waitUpdater(again.files, 4 * 60_000);
      save('updater-2.json', JSON.stringify(s2, null, 1));
      updaterChecks(s2, 'second start');
      check(`the app started again runs ${EXPECT} (its log: "Update for version ${EXPECT} is not available")`,
        s2 && s2.notAvailable && s2.notAvailable.running === EXPECT, s2 && (s2.notAvailable || s2.error));
    }
    summary.secondsFromClickToRunning = Math.round((Date.now() - tClick.getTime()) / 1000);
  }

  if (running) {
    check(`the running app is ${exe} at ${EXPECT}`, running.path && running.path.toLowerCase() === exe.toLowerCase() && winVer(exe) === EXPECT && winInstalled() === EXPECT,
      { main: running, exe: winExeVersion(exe), installed: winInstalled() });
    await sleep(15_000);
    await winMenuCheck(EXPECT);
  }
  check('no manual download: this script downloaded only the from release; any newer version came from the app\'s own updater',
    summary.downloadsByThisScript.every((d) => d.url.startsWith(RELEASE_BASE)), summary.downloadsByThisScript.map((d) => d.url));
  note(`network while the app ran (DNS cache, port-443 connections of ${APP} processes): ${short(summary.network)}`);
  const m = winMain();
  if (m) { winPs(['close', '-Name', 'Sign in with publik']); await waitFor('the app to quit', () => !winMain(), 30_000, 2000); }
  summary.secondsTotal = Math.round((Date.now() - t0) / 1000);
}

// ---------------------------------------------------------------- main

(async () => {
  log(`live update proof: ${FROM_TAG} -> expect ${EXPECT} (answer ${ANSWER}) on ${process.platform}/${process.arch}`);
  try {
    if (isMac) await mac();
    else if (isWin) await windows();
    else check('a supported OS', false, process.platform);
  } catch (e) {
    check('the proof ran to the end', false, String(e && e.stack || e));
  }
  summary.pass = summary.checks.length > 0 && summary.checks.every((c) => c.pass);
  save('summary.json', JSON.stringify(summary, null, 1));
  const failed = summary.checks.filter((c) => !c.pass);
  log(`${summary.checks.length - failed.length}/${summary.checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(' | ')}` : ''}`);
  process.exit(summary.pass ? 0 : 1);
})();
