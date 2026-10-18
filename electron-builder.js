const fs = require("node:fs");
const path = require("node:path");

// When `npm run desktop:assets` has built the workshop assets zip, the DMG carries
// it next to the app, and the app offers to install it on first launch.
const assetsZip = path.join(__dirname, "dist", "BloxdForge-Assets.zip");
const withAssets = fs.existsSync(assetsZip);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.whatsupfv.bloxdforge",
  productName: "BloxdForge",
  copyright: "Copyright © 2026 khrotu",
  directories: {
    app: "electron",
    output: "dist",
    buildResources: "electron/build",
  },
  npmRebuild: false,
  // The app dir (electron/) has no dependencies. Without this, electron-builder
  // falls back to the root node_modules and bundles the whole web toolchain.
  files: ["main.js", "package.json", "!node_modules/**"],
  // electron-builder's default filters drop dot-dirs and node_modules from
  // extraResources, so the standalone server's .next/ and node_modules/ are
  // listed explicitly.
  extraResources: [
    { from: "dist-server", to: "server", filter: ["**/*"] },
    { from: "dist-server/.next", to: "server/.next", filter: ["**/*"] },
    { from: "dist-server/node_modules", to: "server/node_modules", filter: ["**/*"] },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "electron/build/icon.png",
    target: [{ target: "dmg", arch: ["arm64"] }],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "electron/build/entitlements.mac.plist",
    entitlementsInherit: "electron/build/entitlements.mac.plist",
    // osx-sign runs codesign on every non-text file, one at a time. The data
    // and public files are JSON, images and archives, not code, so skip them;
    // the app's resource seal still covers them.
    signIgnore: ["/Contents/Resources/server/data/", "/Contents/Resources/server/public/"],
    // Signing identity comes from the CSC_NAME env var (see README).
    notarize: true,
  },
  dmg: {
    title: "BloxdForge",
    // No auto-updater, so skip the blockmap (it reads the whole multi-GB image).
    writeUpdateInfo: false,
    window: { width: 540, height: withAssets ? 480 : 380 },
    contents: [
      { x: 130, y: 220, type: "file" },
      { x: 410, y: 220, type: "link", path: "/Applications" },
      ...(withAssets ? [{ x: 270, y: 380, type: "file", path: assetsZip }] : []),
    ],
  },
};
