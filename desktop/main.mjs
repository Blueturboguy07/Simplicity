/* Vane desktop shell.
 *
 * Vane is a Next.js server app, not a static bundle — `next build` emits a
 * standalone server.js that has to actually run. So this shell:
 *   1. starts local search (SearXNG) and Vane's own server on launch
 *   2. opens a window pointed at it
 *   3. keeps both alive — if either stops answering, it's restarted so the
 *      window is never left showing a dead page
 *   4. shuts everything down on quit
 *
 * Vane resolves both its config and its SQLite file from DATA_DIR (see
 * src/lib/config/index.ts and src/lib/db/index.ts), so we point that at the
 * per-user app data dir and seed the SearXNG URL. The user never sees a setup
 * field for it — search just works, locally and for free.
 */

import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as searxng from './searxng.mjs';
import { pickServerPort } from './serverPort.mjs';
/* The publik module (publikhq.com/sdk/publik.ts.md): Sign in with publik at
   start-up, the plan choice, usage counts and this computer's publik install
   key. It runs in this process only; the window and the server never hold the
   app token. */
import { credentialPath, ensureSignedIn, resolveProvider } from './publik.mjs';
import { electronGateUI } from './publik-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let serverProc = null;
let serverURL = null;
let healthTimer = null;

const dataDir = () => app.getPath('userData');

/* One append-only log for everything the shell and its children emit, at
   <userData>/logs/simplicity.log. Opened lazily and reused so both stdout and
   stderr of a child land in the same file. */
let logHandle = null;
function logFd() {
  if (logHandle === null) {
    const dir = path.join(dataDir(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logHandle = fs.openSync(path.join(dir, 'simplicity.log'), 'a');
  }
  return logHandle;
}

function log(message) {
  try {
    fs.writeSync(logFd(), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* logging must never break startup */
  }
}

/* The packaged app keeps its payload in resources/; in dev it sits in the repo
   next to us. */
function resource(...parts) {
  const packaged = path.join(process.resourcesPath ?? '', ...parts);
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', ...parts);
}

const standaloneDir = () => resource('.next', 'standalone');

/* Lay out DATA_DIR the way Vane's server expects before it boots:
 *   data/     — it writes config.json and db.sqlite here, but won't mkdir it
 *   drizzle/  — migrate.ts reads migrations from DATA_DIR/drizzle
 * The migrations are refreshed every launch so they track the app version, and
 * the config is patched rather than replaced so the user's providers and
 * preferences survive.
 */
function prepareDataDir(searxngURL) {
  const dir = dataDir();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.cpSync(resource('drizzle'), path.join(dir, 'drizzle'), { recursive: true });

  const file = path.join(dir, 'data', 'config.json');
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run, or unreadable — fall back to Vane's own defaults */
    config = {
      version: 1,
      setupComplete: false,
      preferences: {},
      personalization: {},
      modelProviders: [],
    };
  }
  config.search = { ...(config.search ?? {}), searxngURL };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/* What the Next server gets about publik. The publik module in this process
   owns the install key (POST /installs at the gate); the server never mints.
   It reads the module's credential file (src/lib/publik/provision.ts) for
   the state and the choice, and, when the person connected their plan at the
   gate, it gets the key as PUBLIK_API_KEY so its config manager creates the
   publik provider from the environment. The app token never reaches the
   server; the renderer (contextIsolation, no nodeIntegration) talks to the
   server over HTTP and /api/publik never returns the key. */
function publikEnv() {
  const env = {
    PUBLIK_APP_VERSION: app.getVersion(),
    PUBLIK_CREDENTIAL_FILE: credentialPath(),
  };
  const provider = resolveProvider(null);
  if (provider.kind === 'publik') {
    env.PUBLIK_API_KEY = provider.apiKey;
    env.PUBLIK_API_BASE_URL = provider.baseURL;
  }
  return env;
}

async function isServing(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/* Spawn Next's standalone server. Electron has no separate node binary, so we
   re-exec ourselves as Node (ELECTRON_RUN_AS_NODE). That works without an
   electron-rebuild step because better-sqlite3 13 is N-API based: its prebuilt
   binaries are ABI-stable across both Node and Electron. (v11, which upstream
   pins, is not — it fails to compile against Electron 43's V8.) */
async function startServer() {
  /* The same port every launch: the window origin, and with it everything
     the renderer keeps in localStorage (model choice, settings), must
     survive a restart. See serverPort.mjs. */
  const port = await pickServerPort(dataDir());
  const url = `http://127.0.0.1:${port}`;
  const dir = standaloneDir();

  if (!fs.existsSync(path.join(dir, 'server.js'))) {
    throw new Error(`Simplicity's server build is missing at ${dir}. Run \`yarn build\` first.`);
  }

  const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      DATA_DIR: dataDir(),
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      /* Turns on the loopback-Host rule in the /api guard (src/proxy.ts): this
         server is reachable from any page in the user's browser, so only
         same-origin loopback requests may touch it. The web (Docker) build
         never sets this and keeps its normal cross-host behaviour. */
      SIMPLICITY_DESKTOP: '1',
      ...publikEnv(),
    },
    /* Send the child's output to a log rather than discarding it — a packaged
       app has nowhere to print, and without this a startup failure surfaces
       only as "isn't responding" with no way to find out why. */
    stdio: ['ignore', logFd(), logFd()],
  });
  serverProc = child;
  /* Clear the globals only for THIS child. A server we stopped can exit after
     its replacement started; clearing then made the health watch start a
     third server while the second still held the port. */
  child.on('exit', (code, signal) => {
    log(`server exited (code ${code}, signal ${signal})`);
    if (serverProc === child) {
      serverProc = null;
      serverURL = null;
    }
  });

  const start = Date.now();
  while (Date.now() - start < 60_000) {
    if (await isServing(url)) {
      serverURL = url;
      return url;
    }
    if (serverProc !== child) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Simplicity's server started but isn't responding.");
}

/* SIGKILL, not SIGTERM. After the server has loaded an embedding model,
   a normal exit makes onnxruntime-node abort in its exit-time destructors
   ("libc++abi: ... mutex lock failed: Invalid argument"), under Electron
   and plain node alike. macOS then writes a crash report and shows a
   "next-server quit unexpectedly" dialog after the user quits Simplicity.
   A killed process runs no destructors. The server keeps nothing in memory
   that needs a graceful exit: SQLite commits each write, and Next's own
   SIGTERM handler only closes the HTTP server and calls process.exit.
   (On Windows kill() always terminates the process.) */
function stopServer(proc) {
  try {
    proc.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

async function ensureRunning(onLog) {
  if (serverURL && (await isServing(serverURL))) return serverURL;

  /* Search first — Vane reads its config at request time, so seeding the URL
     before the server boots means the very first search already works. */
  const searxngURL = await searxng.start(dataDir(), onLog);
  prepareDataDir(searxngURL);

  if (serverProc) {
    stopServer(serverProc);
    serverProc = null;
  }
  onLog?.('Starting Simplicity…');
  return startServer();
}

/* Poll health; if either service died, bring it back and reload so the user
   never sees a blank page.
   A server process that is alive but slow to answer (a long upload or a
   search keeps it busy) is not dead: killing it loses that work. So restart
   at once only when the process has exited, and otherwise only after
   MAX_MISSED_CHECKS failed checks in a row. One tick at a time: a restart can
   take longer than the interval, and an overlapping tick used to kill the
   server that was still booting. */
const MAX_MISSED_CHECKS = 3;
let missedChecks = 0;
let healthBusy = false;

function startHealthWatch() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!mainWindow || healthBusy) return;
    healthBusy = true;
    try {
      if (serverProc && serverURL) {
        if (await isServing(serverURL)) {
          missedChecks = 0;
          return;
        }
        missedChecks += 1;
        log(`health check missed (${missedChecks}/${MAX_MISSED_CHECKS})`);
        if (missedChecks < MAX_MISSED_CHECKS) return;
      }
      missedChecks = 0;
      const before = serverURL;
      const procBefore = serverProc;
      const url = await ensureRunning();
      if (url !== before || serverProc !== procBefore) {
        log(`server restarted at ${url}`);
        mainWindow?.loadURL(url);
      }
    } catch {
      /* transient — try again on the next tick */
    } finally {
      healthBusy = false;
    }
  }, 5000);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#0a0a0a',
    title: 'Simplicity',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  /* External links belong in the system browser, not a second app window. */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(serverURL ?? '\0')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  /* Show the splash before any provisioning starts. First run downloads and
     installs local search (~150 MB) — minutes of work that used to happen
     behind a bare black window, which reads as "the app is broken". */
  let onSplash = true;
  const splashCall = (fn, message) => {
    if (!onSplash || !mainWindow) return;
    mainWindow.webContents
      .executeJavaScript(`window.${fn}(${JSON.stringify(String(message))})`)
      .catch(() => {
        /* window mid-navigation — the log file still has it */
      });
  };
  try {
    await mainWindow.loadFile(path.join(__dirname, 'splash.html'));
  } catch {
    onSplash = false; /* splash missing is cosmetic — keep booting */
  }
  mainWindow.show();

  const onStatus = (message) => {
    log(message);
    splashCall('__setStatus', message);
  };

  try {
    const url = await ensureRunning(onStatus);
    onSplash = false;
    await mainWindow.loadURL(url);
    startHealthWatch();
  } catch (err) {
    log(`startup failed: ${err?.stack ?? err}`);
    splashCall('__setError', err?.message ?? String(err));
    dialog.showErrorBox(
      'Simplicity could not start',
      `${err?.message ?? err}\n\nDetails were written to:\n${path.join(dataDir(), 'logs', 'simplicity.log')}`,
    );
  }
}

app.whenReady().then(async () => {
  /* Every publik app opens with Sign in with publik. The gate shows its
     screens in a small window before the app's own window; it resolves once
     the person is signed in (and, the first time, chose how to pay for AI),
     then usage counting runs in the background. PUBLIK_SELF_TEST=1 prints
     the module's self-test line and exits instead. */
  const ui = electronGateUI({ appName: 'Simplicity' });
  await ensureSignedIn(ui);
  ui.close();
  return createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* Tear down both children on exit — nothing should outlive the window. */
app.on('will-quit', () => {
  clearInterval(healthTimer);
  searxng.shutdown();
  if (serverProc) {
    stopServer(serverProc);
    serverProc = null;
  }
});
