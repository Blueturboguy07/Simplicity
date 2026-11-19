// Signs Simplicity.app with the Developer ID identity in this Mac's keychain, the way electron-builder signs it
// (MAC_SIGN=1 in electron-builder.cjs): @electron/osx-sign signs the inner code first (helpers, frameworks,
// dylibs, the native modules of the server in Contents/Resources/.next/standalone), then the app, each with
// the hardened runtime, a secure timestamp and desktop/entitlements.mac.plist (electron-builder.cjs uses that
// file for both `entitlements` and `entitlementsInherit`). scripts/publik-release.sh calls it and installs the
// @electron/osx-sign version of yarn.lock outside the repo first. (Copied from SurfCam's release script.)
//   node scripts/publik-mac-sign.cjs <Simplicity.app> <entitlements.plist> <identity> <path of @electron/osx-sign>
'use strict';
const path = require('node:path');

const [app, entitlements, identity, osxSign] = process.argv.slice(2);
if (!app || !entitlements || !identity || !osxSign) {
  console.error('usage: node scripts/publik-mac-sign.cjs <app> <entitlements> <identity> <@electron/osx-sign dir>');
  process.exit(2);
}
// signAsync returns a promise (sign is the callback form).
const { signAsync } = require(path.resolve(osxSign));

signAsync({
  app,
  platform: 'darwin',
  type: 'distribution',
  identity,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  strictVerify: true,
  optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
})
  .then(() => console.log(`publik-mac-sign: signed ${path.basename(app)} (${identity})`))
  .catch((e) => {
    console.error(`publik-mac-sign: signing failed: ${(e && e.message) || e}`);
    process.exit(1);
  });
