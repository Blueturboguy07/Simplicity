/* SearXNG lifecycle manager — Vane's local, free search backend.
 *
 * Vane talks to exactly one search backend (src/lib/searxng.ts): SearXNG, a
 * Python/Flask service. Upstream only ships it inside a Docker image, which a
 * desktop app can't assume is installed. So the shell provisions it the same
 * way NitroAI provisions Ollama:
 *   1. reuse whatever the user already runs, if something answers
 *   2. else download a relocatable CPython plus the SearXNG source into the
 *      app's data dir (one time) and pip-install it there
 *   3. run it with Flask on a loopback port, keeping a handle for teardown
 *
 * The point is that search stays free, local and private: no Docker, nothing on
 * PATH, no account, no API key. The Dockerfile's uwsgi is never used at runtime
 * (see entrypoint.sh) — plain `flask run` is what upstream actually serves.
 */

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const HOST = '127.0.0.1';

/* python-build-standalone publishes relocatable CPython builds for exactly the
   four targets we ship to. A venv bakes in absolute paths to its base
   interpreter, so a venv can't be moved into a .app — these can.

   Both sources are PINNED, not "latest". Provisioning happens on the user's
   machine at first launch, so an unpinned source means upstream can break
   every new install without us shipping anything — and the patches in
   patchSearxng() are verified against exactly this SearXNG commit. Bump the
   pins deliberately, re-checking those patches still apply. */
const PY_SERIES = '3.12';
const PBS_RELEASE =
  'https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20260728';

/* searxng/searxng master @ 2026-08-01 — the project publishes no tags. */
const SEARXNG_COMMIT = '8892414dc38dd57728b7f62f33152ea80e3b305f';
const SEARXNG_TARBALL = `https://codeload.github.com/searxng/searxng/tar.gz/${SEARXNG_COMMIT}`;

let proc = null; // the Flask process we spawned, if any
let runningURL = null;

const isWin = process.platform === 'win32';

/* ---------------------------------------------------------------- layout -- */

const paths = (dataDir) => {
  const root = path.join(dataDir, 'searxng');
  return {
    root,
    python: path.join(root, 'python'),
    src: path.join(root, 'searxng-src'),
    settings: path.join(root, 'settings.yml'),
    marker: path.join(root, '.provisioned'),
  };
};

const pythonBin = (p) =>
  isWin ? path.join(p.python, 'python.exe') : path.join(p.python, 'bin', 'python3');

export const isProvisioned = (dataDir) => {
  try {
    return fs.existsSync(paths(dataDir).marker);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------- readiness -- */

export async function isServing(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilServing(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServing(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/* Ask the OS for a free port rather than hardcoding 8080 — the user may well
   already have something there, including their own SearXNG. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* ----------------------------------------------------------- provisioning -- */

async function download(url, dest, onLog, label) {
  onLog?.(`Downloading ${label}…`);
  const res = await fetch(url, { headers: { 'user-agent': 'Simplicity-Desktop' } });
  if (!res.ok) throw new Error(`Couldn't download ${label} (${res.status})`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/* The asset triple for this machine. Both Mac arches and both Windows arches
   are published, so the desktop app covers every target we build for. */
function pbsTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (isWin) return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

async function resolvePythonURL() {
  const res = await fetch(PBS_RELEASE, {
    headers: { 'user-agent': 'Simplicity-Desktop' },
  });
  if (!res.ok) throw new Error(`Couldn't reach python-build-standalone (${res.status})`);
  const triple = pbsTriple();
  const asset = (await res.json()).assets.find(
    (a) =>
      a.name.startsWith(`cpython-${PY_SERIES}.`) &&
      a.name.includes(triple) &&
      a.name.endsWith('install_only.tar.gz'),
  );
  if (!asset) throw new Error(`No CPython ${PY_SERIES} build for ${triple}`);
  return asset.browser_download_url;
}

/* macOS's own tar is always present even when a Finder-launched app gets a
   minimal PATH; Windows 10+ ships bsdtar as tar.exe. */
const tarBin = () => (isWin ? 'tar' : '/usr/bin/tar');

function extract(tgz, into, excludes = []) {
  /* A previous failed attempt leaves a partial tree behind — start clean so
     a relaunch actually recovers. */
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  execFileSync(tarBin(), [
    'xzf',
    tgz,
    '-C',
    into,
    '--strip-components=1',
    ...excludes.flatMap((pattern) => ['--exclude', pattern]),
  ]);
  fs.rmSync(tgz, { force: true });
}

/* Skipped when unpacking the SearXNG repo — and ONLY the SearXNG repo. Its
   deployment scripting (utils/, container/) contains a symlink, and Windows
   tar.exe can't create symlinks without admin rights, which kills the whole
   extraction. None of these paths are needed to RUN SearXNG.

   The patterns are anchored to the tarball's root directory on purpose:
   bsdtar's `*` matches across `/`, so a bare pattern like '*\/utils' also
   deletes every directory named utils at ANY depth — applied to the Python
   runtime tarball it strips pip's _internal/utils and breaks pip entirely
   (observed: fresh installs dying at "pip install --upgrade"). */
const SEARXNG_EXCLUDES = [
  'searxng-*/utils',
  'searxng-*/utils/*',
  'searxng-*/container',
  'searxng-*/container/*',
  'searxng-*/.github',
  'searxng-*/.github/*',
];

/* SearXNG's settings. `formats: [json]` is the load-bearing line — without it
   the JSON API that src/lib/searxng.ts calls returns 403. Mirrors upstream's
   searxng/settings.yml, with a per-install secret.

   The engine list is deliberately broad: with a single general engine, one
   upstream throttling this IP (DuckDuckGo does after sustained use — observed
   as every query "Found 0 results") zeroes out all retrieval. Several
   independent engines means a blocked one degrades results instead of
   blanking them. */
function writeSettings(p) {
  fs.writeFileSync(
    p.settings,
    `use_default_settings: true

general:
  instance_name: 'simplicity'

search:
  autocomplete: 'google'
  formats:
    - html
    - json

server:
  secret_key: '${crypto.randomBytes(32).toString('hex')}'

outgoing:
  request_timeout: 8.0
  max_request_timeout: 12.0

engines:
  - name: wolframalpha
    disabled: false
  - name: duckduckgo
    disabled: false
  - name: brave
    disabled: false
  - name: bing
    disabled: false
  - name: startpage
    disabled: false
  - name: qwant
    disabled: false
  - name: mojeek
    disabled: false
  - name: wikipedia
    disabled: false
`,
  );
}

/* SearXNG's master branch assumes a git checkout on a POSIX host in two spots
   that break a fresh Windows provision. Both are patched against the extracted
   source before pip runs. */
function patchSearxng(p) {
  const searx = path.join(p.src, 'searx');

  /* 1. Version detection. searx/version.py shells out to `git` at import time,
     which runs during the editable `pip install` (setup's metadata build). It
     catches CalledProcessError but NOT FileNotFoundError, so a machine with no
     git on PATH dies mid-install with
     "FileNotFoundError: [WinError 2] The system cannot find the file specified".
     version.py imports searx.version_frozen first and only falls back to git,
     so writing that frozen module — exactly what upstream's `searx.version
     freeze` emits for out-of-git builds — sidesteps git entirely. The values
     mirror version.py's own hardcoded fallbacks. */
  try {
    const frozen = path.join(searx, 'version_frozen.py');
    if (fs.existsSync(searx) && !fs.existsSync(frozen)) {
      fs.writeFileSync(
        frozen,
        `# SPDX-License-Identifier: AGPL-3.0-or-later
# generated by Simplicity's desktop provisioner for out-of-git builds
VERSION_STRING = "1.0.0"
VERSION_TAG = "1.0.0"
DOCKER_TAG = "1.0.0"
GIT_URL = "unknown"
GIT_BRANCH = "unknown"
`,
      );
    }
  } catch {
    /* If upstream restructures versioning this freeze is moot; let the build
       surface any real error itself. */
  }

  /* 2. searx/valkeydb.py does a top-level `import pwd` — a Unix-only stdlib
     module absent on Windows — so webapp.py fails to import and Flask never
     boots (the server "started but isn't responding"). pwd is used only to
     name the current user in one valkey-connection error-log branch we never
     reach (no valkey.url is configured), so guarding the import is enough.
     Windows-only. */
  if (isWin) {
    try {
      const file = path.join(searx, 'valkeydb.py');
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('import pwd\n') && !src.includes('except ModuleNotFoundError')) {
        fs.writeFileSync(
          file,
          src.replace(
            'import pwd\n',
            'try:\n    import pwd\nexcept ModuleNotFoundError:  # Windows has no pwd module\n    pwd = None\n',
          ),
        );
      }
    } catch {
      /* If upstream restructures this file the import guard is moot — let the
         server try to boot and surface any real error itself. */
    }
  }
}

/* One-time setup. Everything lands under the app's data dir so uninstalling is
   a single rm -rf, and a marker file means later launches skip straight to
   spawning the server. */
export async function provision(dataDir, onLog) {
  const p = paths(dataDir);
  if (isProvisioned(dataDir)) return p;

  /* The marker is only written on full success, so reaching this point with
     an existing tree means a PREVIOUS provisioning died partway. Its remains
     are poison — the existsSync fast-paths below would happily reuse a
     half-extracted Python — so start over from nothing. The re-download is
     the price of a launch that actually recovers. */
  if (fs.existsSync(p.root)) {
    onLog?.('Previous search setup was incomplete — starting it over.');
    fs.rmSync(p.root, { recursive: true, force: true });
  }

  fs.mkdirSync(p.root, { recursive: true });
  onLog?.('Setting up local search — this is a one-time download of about 150 MB.');

  if (!fs.existsSync(pythonBin(p))) {
    const tgz = path.join(p.root, 'python.tar.gz');
    await download(await resolvePythonURL(), tgz, onLog, 'the Python runtime');
    onLog?.('Unpacking the Python runtime…');
    extract(tgz, p.python);
  }

  if (!fs.existsSync(path.join(p.src, 'searx', 'webapp.py'))) {
    const tgz = path.join(p.root, 'searxng.tar.gz');
    await download(SEARXNG_TARBALL, tgz, onLog, 'the SearXNG search engine');
    onLog?.('Unpacking SearXNG…');
    extract(tgz, p.src, SEARXNG_EXCLUDES);
    patchSearxng(p);
  }

  const py = pythonBin(p);
  onLog?.('Installing search dependencies…');
  /* Same two-step upstream's Dockerfile uses: seed the build deps, then install
     SearXNG itself editable so it keeps its templates and static assets. */
  execFileSync(py, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel',
    'pyyaml', 'msgspec', 'typing_extensions'], { stdio: 'ignore' });
  execFileSync(py, ['-m', 'pip', 'install', '--use-pep517', '--no-build-isolation',
    '-e', p.src], { stdio: 'ignore' });

  writeSettings(p);
  fs.writeFileSync(p.marker, new Date().toISOString());
  onLog?.('Local search is ready.');
  return p;
}

/* ------------------------------------------------------------- lifecycle -- */

/* Start SearXNG and return its URL. Provisions first if needed. */
export async function start(dataDir, onLog) {
  if (runningURL && (await isServing(runningURL))) return runningURL;

  const p = await provision(dataDir, onLog);
  if (!fs.existsSync(p.settings)) writeSettings(p);

  const port = await freePort();
  const url = `http://${HOST}:${port}`;

  onLog?.('Starting local search…');
  /* Keep Flask's output — when search fails to come up, its traceback is the
     only thing that explains why. */
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, 'searxng.log'), 'a');

  proc = spawn(pythonBin(p), ['-m', 'flask', 'run', '--host', HOST, '--port', String(port)], {
    cwd: p.src,
    env: {
      ...process.env,
      FLASK_APP: 'searx/webapp.py',
      SEARXNG_SETTINGS_PATH: p.settings,
    },
    stdio: ['ignore', fd, fd],
    detached: false,
  });
  proc.on('exit', () => {
    proc = null;
    runningURL = null;
  });

  if (!(await waitUntilServing(url))) {
    throw new Error("Local search started but isn't responding.");
  }
  runningURL = url;
  return url;
}

export function shutdown() {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  proc = null;
  runningURL = null;
}
