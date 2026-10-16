# BloxdForge Community Edition

An open-source version of BloxdForge.

Some features may differ or be missing from the managed version because of sensitive information, intellectual property protection, or other reasons.

See `public/README.md` for instructions on setting up the required assets.

BloxdForge Community Edition (khrotu) is licensed under the Apache License, Version 2.0.

Voxel Builder (nimadez) is licensed under the GNU General Public License, Version 3.0.

Monaco Editor (Microsoft) is licensed under the MIT License.

## macOS desktop app

The repo can be packaged as a signed macOS app with Electron. The app runs the Next.js standalone server inside an Electron utility process, bound to `127.0.0.1:38917`. The port is fixed so that saved projects and settings, which live in IndexedDB and localStorage, survive restarts.

```sh
npm ci
brew install sevenzip && npm run unpack-assets   # once; see public/README.md
npm run desktop:prepare                          # next build + assemble dist-server/
npm run desktop:dev                              # run it in Electron (unpackaged)
CSC_NAME="<signing identity>" npx electron-builder --mac   # signed .app/.dmg/.zip in dist/
```

- Builds are arm64 only. The bundled `sharp` binary is arm64.
- `CSC_NAME` is a codesigning identity from `security find-identity -v -p codesigning`. Use an Apple Development or Developer ID certificate, or a self-signed code-signing certificate. The app is not notarized, so on the target Mac run `xattr -dr com.apple.quarantine /Applications/BloxdForge.app` once.
- **Santa:** every executable in the bundle (the main app, four Electron helpers, and crashpad) is signed with the same certificate. A single TeamID rule, or a CERTIFICATE rule using the leaf certificate's SHA-256, covers all of them. SigningID rules would need one rule per executable.
- Server logs are written to `~/Library/Logs/BloxdForge/server.log`.
