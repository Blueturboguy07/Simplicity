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
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as searxng from './searxng.mjs';

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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

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
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dir = standaloneDir();

  if (!fs.existsSync(path.join(dir, 'server.js'))) {
    throw new Error(`Simplicity's server build is missing at ${dir}. Run \`yarn build\` first.`);
  }

  serverProc = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      DATA_DIR: dataDir(),
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
    /* Send the child's output to a log rather than discarding it — a packaged
       app has nowhere to print, and without this a startup failure surfaces
       only as "isn't responding" with no way to find out why. */
    stdio: ['ignore', logFd(), logFd()],
  });
  serverProc.on('exit', () => {
    serverProc = null;
    serverURL = null;
  });

  const start = Date.now();
  while (Date.now() - start < 60_000) {
    if (await isServing(url)) {
      serverURL = url;
      return url;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Simplicity's server started but isn't responding.");
}

async function ensureRunning(onLog) {
  if (serverURL && (await isServing(serverURL))) return serverURL;

  /* Search first — Vane reads its config at request time, so seeding the URL
     before the server boots means the very first search already works. */
  const searxngURL = await searxng.start(dataDir(), onLog);
  prepareDataDir(searxngURL);

  if (serverProc) {
    try {
      serverProc.kill();
    } catch {
      /* already gone */
    }
    serverProc = null;
  }
  onLog?.('Starting Simplicity…');
  return startServer();
}

/* Poll health; if either service died, bring it back and reload so the user
   never sees a blank page. */
function startHealthWatch() {
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (!mainWindow) return;
    const before = serverURL;
    try {
      const url = await ensureRunning();
      if (url !== before) mainWindow.loadURL(url);
    } catch {
      /* transient — try again on the next tick */
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

app.whenReady().then(createWindow);

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
    try {
      serverProc.kill();
    } catch {
      /* already gone */
    }
    serverProc = null;
  }
});
