#!/usr/bin/env node
// publik-release-check.cjs — the file checks of scripts/publik-release.sh. It reads files only: it runs no
// program and prints no secret. Each check prints "PASS ..." or "FAIL ..."; the exit code is 1 if one failed.
// (Adapted from SurfCam's scripts/publik-release-check.cjs.)
//
//   feed <feed dir> <files dir> --version 1.12.10 --app simplicity --base https://github.com/OWNER/REPO/releases/download/v0.1.11/
//        --names Simplicity-mac-arm64.zip,Simplicity-mac-arm64.dmg,Simplicity-Setup-Windows.exe
//        latest.yml and latest-mac.yml: the signature verifies with the public key in publik-update-verify.cjs,
//        version, publikApp, absolute URLs under --base for files of --names, `path`/`sha512` name the first
//        file; and for each file the feed lists that is in <files dir>: its sha512 and size. Files not in
//        <files dir> are skipped.
//   sums <SHA256SUMS.txt> <files dir>     each file of the list that is in <files dir> has its sha256
//   exe <installer.exe> --version 1.12.10 the version strings in the installer's VS_VERSIONINFO
//   asar <app.asar> --version 1.12.10     the packed package.json is the release build of that version (no test
//        flag), and the updater with the publik feed and its slug is packed
//   token <Resources dir>                 the publik app token is in .next/standalone/publik-app.json and not
//        in the client bundle (.next/standalone/.next/static). The token is never printed.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyMinisign, PUBLIK_UPDATE_PUBLIC_KEYS } = require('../desktop/publik-update-verify.cjs');

const KEY_ID = 'F5E0515C77912BD0';
const SLUG = 'simplicity';
let failed = 0;
function ok(pass, msg) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${msg}`);
  if (!pass) failed++;
}
function opts(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}
function hashFile(file, algo, encoding) {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 << 20);
  for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest(encoding);
}

function feed(o) {
  const [feedDir, filesDir] = o._;
  const { version, app, base } = o;
  const names = String(o.names || '').split(',').filter(Boolean);
  const want = { 'latest.yml': names.filter((n) => /\.exe$/i.test(n)), 'latest-mac.yml': names.filter((n) => /-mac-.*\.(zip|dmg)$/i.test(n)) };
  for (const name of ['latest.yml', 'latest-mac.yml']) {
    const file = path.join(feedDir, name);
    if (!fs.existsSync(file)) { ok(false, `${name} is missing`); continue; }
    const data = fs.readFileSync(file);
    try {
      const v = verifyMinisign(data, fs.readFileSync(`${file}.sig`, 'utf8'), PUBLIK_UPDATE_PUBLIC_KEYS, { file: name });
      ok(v.keyId === KEY_ID, `${name}.sig verifies with the app's public key (key ${v.keyId}; ${v.trustedComment.replace(/\t/g, ' ')})`);
    } catch (e) {
      ok(false, `${name}.sig: ${e.message}`);
    }
    const text = data.toString('utf8');
    const field = (k) => (new RegExp(`^${k}: '([^']*)'`, 'm').exec(text) || [])[1];
    ok(field('version') === version, `${name} version ${field('version')} (want ${version})`);
    ok(field('publikApp') === app, `${name} publikApp ${field('publikApp')}`);
    const entries = [...text.matchAll(/- url: '([^']+)'\n\s+sha512: '([^']+)'\n\s+size: (\d+)/g)].map((m) => ({ url: m[1], sha512: m[2], size: Number(m[3]) }));
    ok(entries.length > 0 && field('path') === entries[0].url && field('sha512') === entries[0].sha512, `${name} path/sha512 name the first of ${entries.length} file(s)`);
    const listed = entries.map((e) => decodeURIComponent(e.url.slice(base.length)));
    ok(JSON.stringify([...listed].sort()) === JSON.stringify([...want[name]].sort()) && (name !== 'latest-mac.yml' || /\.zip$/.test(listed[0])),
      `${name} lists ${listed.join(', ')}${name === 'latest-mac.yml' ? ' (the zip first: Squirrel.Mac installs from it)' : ''}`);
    for (const e of entries) {
      const fileName = decodeURIComponent(e.url.slice(base.length));
      ok(e.url.startsWith(base) && !fileName.includes('/') && names.includes(fileName), `${name}: absolute URL ${e.url}`);
      const local = path.join(filesDir, fileName);
      if (!fs.existsSync(local)) { console.log(`skip ${fileName} (not in ${filesDir} in this pass)`); continue; }
      const size = fs.statSync(local).size;
      ok(size === e.size && hashFile(local, 'sha512', 'base64') === e.sha512, `${fileName}: sha512 and size (${size}) match ${name}`);
    }
  }
}

function sums(o) {
  const [list, filesDir] = o._;
  for (const line of fs.readFileSync(list, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const [hash, name] = line.split(/\s+\*?/);
    const local = path.join(filesDir, name);
    if (!fs.existsSync(local)) { console.log(`skip ${name} (not in ${filesDir} in this pass)`); continue; }
    ok(hashFile(local, 'sha256', 'hex') === hash, `${name}: sha256 matches SHA256SUMS.txt`);
  }
}

/** The values of the VS_VERSIONINFO strings ProductVersion and FileVersion (UTF-16, 32-bit aligned). */
function exe(o) {
  const data = fs.readFileSync(o._[0]);
  const found = {};
  for (const key of ['ProductName', 'ProductVersion', 'FileVersion']) {
    const k = Buffer.from(`${key}\0`, 'utf16le');
    const values = new Set();
    for (let i = data.indexOf(k); i >= 0; i = data.indexOf(k, i + 1)) {
      let j = i + k.length;
      while (j % 4) j++;
      let end = j;
      while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end += 2;
      const v = data.subarray(j, end).toString('utf16le');
      if (v) values.add(v);
    }
    found[key] = [...values];
    console.log(`${key}: ${found[key].join(', ') || '(none)'}`);
  }
  const same = (v) => v === o.version || v === `${o.version}.0`; // Windows writes x.y.z or x.y.z.0
  ok(found.ProductVersion.some(same), `${path.basename(o._[0])}: ProductVersion ${found.ProductVersion.join(', ')} (want ${o.version})`);
  ok(found.FileVersion.some(same), `${path.basename(o._[0])}: FileVersion ${found.FileVersion.join(', ')} (want ${o.version})`);
}

/** One file out of an asar archive. */
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
    const out = Buffer.alloc(node.size);
    fs.readSync(fd, out, 0, node.size, 8 + headerSize + Number(node.offset));
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function asar(o) {
  const file = o._[0];
  const pkg = JSON.parse((asarFile(file, 'package.json') || '{}').toString('utf8'));
  ok(pkg.version === o.version && pkg.publikUpdaterTest === undefined, `app.asar package.json: version ${pkg.version}, release build (no publikUpdaterTest)`);
  const updater = (asarFile(file, 'desktop/publik-updater.cjs') || '').toString('utf8');
  ok(updater.includes("const FEED_BASE = 'https://publikhq.com/api/updates/';"), 'app.asar: desktop/publik-updater.cjs with the publik feed');
  ok(asarFile(file, 'desktop/publik-update-verify.cjs') !== null, 'app.asar: desktop/publik-update-verify.cjs');
  const main = (asarFile(file, 'desktop/main.mjs') || '').toString('utf8');
  ok(main.includes(`startUpdates({ slug: '${SLUG}'`), `app.asar: desktop/main.mjs starts the updater for ${SLUG}`);
}

/** Every file below `dir` (no symbolic links followed). */
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function token(o) {
  const resources = o._[0];
  const standalone = path.join(resources, '.next', 'standalone');
  let t = '';
  try { t = String(JSON.parse(fs.readFileSync(path.join(standalone, 'publik-app.json'), 'utf8')).token || '').trim(); } catch {}
  ok(t.startsWith('pat_'), 'the publik app token is packed (.next/standalone/publik-app.json; not printed)');
  if (!t) return;
  const statics = path.join(standalone, '.next', 'static');
  let leaks = 0;
  let files = 0;
  if (fs.existsSync(statics)) {
    const needle = Buffer.from(t);
    for (const f of walk(statics)) { files++; if (fs.readFileSync(f).includes(needle)) leaks++; }
  }
  ok(files > 0 && leaks === 0, `the token is not in the client bundle (.next/standalone/.next/static: ${files} files, ${leaks} with the token)`);
}

const [cmd, ...rest] = process.argv.slice(2);
const o = opts(rest);
if (cmd === 'feed') feed(o);
else if (cmd === 'sums') sums(o);
else if (cmd === 'exe') exe(o);
else if (cmd === 'asar') asar(o);
else if (cmd === 'token') token(o);
else { console.error('usage: publik-release-check.cjs feed|sums|exe|asar|token ... (see the top of this file)'); process.exit(2); }
process.exit(failed ? 1 : 0);
