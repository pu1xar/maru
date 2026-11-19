# maru Android app

The Android client of maru (Expo SDK 58, Android only). `apps/mobile` is its own npm package root with its own `node_modules`. The root [README](../../README.md) describes what the app does and how the server pairs with it. This file covers building it.

## Requirements

- Android Studio (its bundled JBR is the default `JAVA_HOME`) and the Android SDK (`ANDROID_HOME`, default `/opt/homebrew/share/android-commandlinetools`, with a `build-tools` folder)
- Node 26 or newer, and npm
- `pnpm install` run once at the repository root (the app's bundle imports `packages/shared` and `apps/web/src`, and the tests compare generated bundles with the packages `apps/web` installs)

```sh
cd apps/mobile
npm ci
npx tsc --noEmit -p .
node --test 'src/**/*.test.ts' 'scripts/**/*.test.mts'
```

## Build settings

Per-deployment values live in `~/.config/maru/build.env` (`MARU_BUILD_ENV` names another file). Copy [`build.env.example`](../../build.env.example) and uncomment what you need. One `KEY=VALUE` per line, no shell expansion, and a variable already in the environment wins.

| Name | Effect |
|---|---|
| `MARU_ANDROID_PACKAGE` | Application id (default `dev.maru.app`). Keep it once phones have installed the app |
| `MARU_UPDATES_URL` | `https://<your server>/ota/manifest`. Unset: the APK has OTA updates off |
| `MARU_UPDATES_CERT` | Certificate of the OTA signing key (default `certs/certificate.pem`) |
| `MARU_CAMERA_PERMISSION_TEXT` | Text of the camera permission prompt for the pairing QR scan (default English) |
| `MARU_FONT_CDN` | Where the Bon Google Sans Code files are served (unset: no Bon file is downloaded) |
| `MARU_RELEASES_REPO` | `<owner>/<repo>`: the app checks that repository's GitHub Releases for a newer APK and offers it (see 6). Unset: the app's config has no such key |

`MARU_ANDROID_PACKAGE`, `MARU_UPDATES_CERT`, `MARU_CAMERA_PERMISSION_TEXT` and the update token are native inputs. Changing any of them changes the app's runtime version (the native fingerprint), and installed apps then need a new APK before they take your OTA updates again.

## 1. The APK signing keystore

`build-apk.sh` signs the release APK with a keystore you make once. Keep it and its passwords: Android refuses an update that another key signed.

```sh
mkdir -p ~/.config/maru/android && chmod 700 ~/.config/maru/android
keytool -genkeypair -storetype PKCS12 \
  -keystore ~/.config/maru/android/maru-release.p12 \
  -alias maru -keyalg RSA -keysize 2048 -validity 10000
```

`keytool` is in `Android Studio.app/Contents/jbr/Contents/Home/bin/` (and `/usr/bin/keytool` runs it when a JDK is installed). It asks for a password and for the certificate's name fields. Use the same password for the store and the key (a PKCS12 keystore requires it).

Then write `~/.config/maru/android/keystore.properties`, which the build reads (`MARU_ANDROID_KEYSTORE_PROPERTIES` names another path):

```properties
storeFile=/Users/you/.config/maru/android/maru-release.p12
storePassword=the password you typed
keyAlias=maru
keyPassword=the password you typed
```

```sh
chmod 600 ~/.config/maru/android/keystore.properties
```

`storeFile` is an absolute path.

## 2. The OTA update signing key pair

JavaScript changes reach installed apps as signed over-the-air updates that your server serves. A key pair signs them: the private key stays on the build machine, and the APK embeds the certificate. One pair also signs the desktop app's updates. Make it before the first APK that has OTA on:

```sh
cd apps/mobile
npx expo-updates codesigning:generate \
  --key-output-directory ~/.config/maru/updates-signing \
  --certificate-output-directory certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name maru
chmod 600 ~/.config/maru/updates-signing/private-key.pem
```

- Output: `~/.config/maru/updates-signing/private-key.pem` (what `ota-export.mts` signs with, or `--key`, or `MARU_UPDATES_KEY`), a `public-key.pem` that nothing here reads, and `certs/certificate.pem` (what the APK carries, or the file `MARU_UPDATES_CERT` names)
- `certs/certificate.pem` belongs to your deployment. A repository that is a public copy of maru has none, so you make it here
- Never commit the private key. Back it up with the keystore: with a new pair, installed apps and the desktop app stop trusting your updates

## 3. Build the APK

```sh
cd apps/mobile
scripts/build-apk.sh
```

The script (read its header for the steps)

1. reads `build.env` and the version of the checkout
2. computes the runtime version (the native fingerprint)
3. copies the app to a build folder outside the repository (`~/.cache/maru-android-build`, `MARU_ANDROID_BUILD_DIR`) and runs `expo prebuild` and `gradlew assembleRelease` there, for `arm64-v8a` (`MARU_ANDROID_ABIS` lists others)
4. checks the APK (signature, embedded runtime version and update manifest) and writes it with `latest.json` to `~/.local/share/maru/mobile/apk/` (`MARU_MOBILE_DIR`), where the server offers it for download

With an update URL, the first build creates the OTA read token `~/.config/maru/mobile-update-token` (`MARU_UPDATE_TOKEN_FILE`). Every APK carries it, and a new token needs a new APK.

## 4. Serve OTA updates

```sh
cd apps/mobile
node scripts/ota-export.mts --out dist-ota
```

This exports the JavaScript with `expo export`, signs the manifest with the private key and checks it against the certificate. The server serves the folder named by `MARU_OTA_DIR` (default `apps/mobile/dist-ota`) at `/ota/manifest`. Run the export again after a JavaScript change. Only apps with the same runtime version take an update.

## 5. Push notifications (optional)

Push needs a Firebase project and two files. See [FCM-SETUP.md](FCM-SETUP.md).

## Pairing

In the web UI (Settings, Devices) open the pairing dialog and scan its QR code in the app. The server address must be `https`, or `http` for a loopback address.

## 6. Public releases on GitHub

`.github/workflows/android-release.yml` builds the APK that the repository's Releases page offers. Pushing a tag `v<major>.<minor>.<count>` (for example `v0.1.1`), or running the workflow by hand with a tag name, builds on an Ubuntu runner and attaches `maru-<version>.apk` and its `.sha256` to that tag's Release (the Release is created when it does not exist).

- The build uses the public defaults: package `dev.maru.app`, OTA updates off, no font CDN, and `MARU_RELEASES_REPO` set to the repository that runs the workflow. The version is the tag's: versionName `<major>.<minor>.<count>` and versionCode `<count>`. Every tag needs a larger count than the one before (Android installs an update only over a lower versionCode)
- The installed app reads `https://api.github.com/repos/<owner>/<repo>/releases/latest` at start and on a foreground return a day after the last check, and offers the `.apk` asset when the release's version is higher than the installed one (`src/lib/releaseCheck.logic.ts`, `src/lib/useRelease.ts`). It needs no update server and no token
- `build-apk.sh` takes `JAVA_HOME`, `ANDROID_HOME` and `MARU_VERSION` from the environment, which is how the workflow drives it

### Release signing

The workflow signs with a keystore held in repository secrets. Make the keystore once, with the `keytool` command of section 1, and keep it with its passwords somewhere safe outside the repository. Android refuses an update signed by another key, so a keystore chosen for the public release can never be replaced: users would have to uninstall the app, lose its pairing and install again.

Add four secrets under Settings, Secrets and variables, Actions of the repository:

| Secret | Value |
|---|---|
| `MARU_ANDROID_KEYSTORE_BASE64` | the keystore file, base64 on one line: `base64 < maru-release.p12 \| tr -d '\n'` |
| `MARU_ANDROID_KEYSTORE_PASSWORD` | the store password |
| `MARU_ANDROID_KEY_ALIAS` | the key alias (`maru` in section 1) |
| `MARU_ANDROID_KEY_PASSWORD` | the key password (the same as the store password for PKCS12) |

The workflow stops with an error naming the secrets that are missing, before it builds anything. It writes the keystore and a `keystore.properties` to the runner's temporary folder and passes the latter as `MARU_ANDROID_KEYSTORE_PROPERTIES`.
