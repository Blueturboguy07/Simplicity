/* Finish the standalone build so it can actually serve.
 *
 * `next build` with output:'standalone' emits a server.js and its traced
 * node_modules, but deliberately leaves out the static assets — the Dockerfile
 * copies them in by hand (see Dockerfile: COPY .next/static, COPY public). The
 * desktop build needs the same two copies, so this runs as part of
 * `yarn build:desktop`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const standalone = path.join(root, '.next', 'standalone');

if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  console.error('No standalone build found — run `yarn build` first.');
  process.exit(1);
}

for (const [from, to] of [
  [path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static')],
  [path.join(root, 'public'), path.join(standalone, 'public')],
]) {
  fs.cpSync(from, to, { recursive: true });
  console.log(`copied ${path.relative(root, from)} → ${path.relative(root, to)}`);
}

/* Bake the publik app token into the standalone payload as a JSON file the
 * Electron main process reads at launch (desktop/main.mjs publikEnv()). CI
 * sets PUBLIK_APP_TOKEN from a repository secret; a local build without it
 * produces a BYO-only app, which is the right thing for a build nobody will
 * distribute. A file next to the server, not next.config `env:` inlining —
 * Next's env map replaces process.env.X at compile time in EVERY bundle that
 * references it, so one careless client-side reference would ship the token
 * to the renderer. A file read only by the main process cannot leak that way.
 * The token is an app identifier with abuse limits, not a cryptographic
 * secret; it is never logged here.
 */
const publikFile = path.join(standalone, 'publik-app.json');
fs.rmSync(publikFile, { force: true });
const publikToken = process.env.PUBLIK_APP_TOKEN ?? '';
if (publikToken) {
  fs.writeFileSync(
    publikFile,
    JSON.stringify(
      {
        app: 'simplicity',
        token: publikToken,
        baseUrl: process.env.PUBLIK_API_BASE_URL || 'https://publikhq.com/api/v1',
      },
      null,
      2,
    ),
  );
  console.log('publik app token baked in (publik-app.json)');
} else {
  console.log('WARNING: no PUBLIK_APP_TOKEN — BYO-only build (no publik-app.json)');
}

/* Next's file tracing sweeps in our own build tooling — most damagingly the
 * `electron` package, which carries a complete Electron.app (~296 MB). Nesting
 * that inside the packaged Electron.app doubles the bundle AND breaks signing:
 * codesign rejects the framework symlinks with "invalid destination for
 * symbolic link in bundle". None of it is used at runtime; the server only
 * needs Next and its own deps.
 */
const buildOnly = ['electron', '@electron', '@electron-internal', 'electron-builder'];
for (const name of buildOnly) {
  const dir = path.join(standalone, 'node_modules', name);
  if (!fs.existsSync(dir)) continue;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`pruned node_modules/${name}`);
}

console.log('standalone build ready');
