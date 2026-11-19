# Desktop app

The desktop app is an Electron window that opens the web UI of the server it is paired with. The server must expose the device listener ([Reach your server from the phone](android.md#reach-your-server-from-the-phone) sets it up, and [Security model](security.md) describes it).

This repository publishes no desktop build: its Releases carry the Android APK only. You build the installers yourself, sign the update manifest with your own key, and the server offers the result for download in Settings, Devices (`MARU_DESKTOP_DIR`, default `apps/desktop/dist-release`). Pairing works like the Android app: Settings, Devices, Connect desktop gives a short code and a link.

```sh
pnpm --filter @maru/desktop start       # bundles and runs the app in development
node apps/desktop/scripts/build.ts --out <dir> --targets mac-arm64   # installers and a signed update manifest
```

`build.ts` takes `--targets` from `mac-arm64`, `mac-x64`, `win-x64`, `win-arm64` (or `MARU_DESKTOP_TARGETS`), builds with electron-builder, and signs the update manifest.

- You create the update signing key pair yourself (see [Update signing keys](android.md#update-signing-keys)). `--key` and `--cert` of `build.ts` name another pair. The certificate is embedded in the desktop app and in the Android app, and the apps verify every update against it
- On macOS the app is signed with a local self-signed certificate in your login Keychain, because the build uses no Apple Developer ID (see [macOS signing certificate](#macos-signing-certificate)). Without it the build signs ad hoc, and the Keychain asks for access again after each update
- Unit tests of the app run with the root `pnpm test`

## macOS signing certificate

A self-signed code signing certificate named `maru Local Code Signing` in the login Keychain gives every build of the desktop app the same signing identity, so the Keychain does not ask again after each update (`LOCAL_SIGNING_NAME` in `apps/desktop/scripts/builderConfig.ts`). The build finds it by that name with `security find-identity -p codesigning`

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=maru Local Code Signing" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning"
openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem \
  -name "maru Local Code Signing" -out maru.p12      # asks for an export password
security import maru.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign
security find-identity -p codesigning                # lists it
rm key.pem cert.pem maru.p12
```

- `-legacy` is for OpenSSL 3 and newer (Homebrew's `openssl`): without it `security import` fails with "MAC verification failed". The `/usr/bin/openssl` of macOS (LibreSSL) does not know the flag, so leave it out there
- `find-identity` shows the certificate as not trusted. That is expected: it is not added to the trust settings, and the build signs through the identity's hash
