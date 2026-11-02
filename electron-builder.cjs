/* electron-builder configuration for the Vane desktop app.
 *
 * What ships:
 *   • desktop/  — the shell (window, server supervisor, SearXNG provisioner)
 *   • .next/standalone — Vane's built server, its traced node_modules, its
 *     static assets and public/. This is the bulk of the bundle and lives in
 *     extraResources rather than the asar, because better-sqlite3 loads a
 *     native .node from disk.
 *   • drizzle/ — migration SQL, copied into DATA_DIR at launch (migrate.ts
 *     reads them from there).
 *
 * SearXNG and its Python runtime are deliberately NOT bundled — they're
 * downloaded once into the user's data dir on first run (see desktop/searxng.mjs).
 * That keeps the installer small and the download honest about what it is.
 *
 * Signing mirrors the NitroAI setup: a real Developer ID when MAC_SIGN=1, and
 * a valid ad-hoc signature otherwise (see desktop/afterPack.cjs).
 */

const hasCert = process.env.MAC_SIGN === '1';
const canNotarize =
  hasCert &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.simplicity.desktop',
  productName: 'Simplicity',
  publish: null,
  /* Never rebuild native modules: better-sqlite3 is N-API and ships prebuilds
     for every platform inside the package (prebuilds/win32-x64.node etc.), so
     a rebuild adds nothing on the native arch and hard-fails the Windows
     cross-build (node-gyp cannot cross-compile). */
  npmRebuild: false,
  files: ['desktop/**', 'package.json', '!**/*.map', '!desktop/**/*.test.mjs'],
  extraMetadata: { main: 'desktop/main.mjs' },
  /* .next/standalone and drizzle/ are staged into the bundle by the afterPack
     hook, not by extraResources — see desktop/afterPack.cjs for why. */
  afterPack: './desktop/afterPack.cjs',
  directories: { output: 'release' },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    artifactName: 'Simplicity-mac-${arch}.${ext}',
    identity: hasCert ? undefined : null,
    hardenedRuntime: hasCert,
    entitlements: 'desktop/entitlements.mac.plist',
    entitlementsInherit: 'desktop/entitlements.mac.plist',
    notarize: canNotarize,
  },
  dmg: { title: 'Simplicity ${version}' },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'Simplicity-Setup-Windows.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
};
