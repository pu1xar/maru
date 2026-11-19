#!/usr/bin/env bash
# Builds the maru release APK on this Mac with Gradle, without EAS (DESIGN.md 2d).
#
#   apps/mobile/scripts/build-apk.sh
#       the production APK: the settings come from the build settings file (below); updates from
#       its MARU_UPDATES_URL, or none (OTA off) when it names no URL. Written to
#       ~/.local/share/maru/mobile/apk/ (the web server offers the latest one for download)
#   MARU_UPDATES_URL=http://127.0.0.1:8052/ota/manifest MARU_MOBILE_DIR=<dir> build-apk.sh
#       a test build that asks another update server; it must name its own output folder
#
# Build settings: ~/.config/maru/build.env (env MARU_BUILD_ENV names another file; build.env.example
# lists the names): MARU_ANDROID_PACKAGE, MARU_UPDATES_URL, MARU_CAMERA_PERMISSION_TEXT, MARU_FONT_CDN. One KEY=VALUE per line,
# read as text (no shell expansion); a variable already in the environment wins over the file.
#
# On a CI runner (.github/workflows/android-release.yml) JAVA_HOME and ANDROID_HOME come from the
# environment, MARU_BUILD_ENV names an empty file, MARU_VERSION is the tag's version, and
# MARU_MOBILE_DIR, MARU_ANDROID_BUILD_DIR and MARU_ANDROID_KEYSTORE_PROPERTIES name the runner's own
# folders. MARU_RELEASES_REPO=<owner>/<repo> makes the app read that repository's releases for new
# versions (src/lib/useRelease.ts); such a build has no update server (MARU_UPDATES_URL unset).
#
# A new APK is needed only when the runtime version (the native fingerprint) changes; JavaScript
# reaches installed apps as signed OTA updates (scripts/ota-export.mts, release.sh).
#
# Steps:
#   0. version: maru's version of the checkout's HEAD (scripts/version.ts, DESIGN.md 2c), exported
#      as MARU_VERSION so app.config.ts makes it the versionName and its commit count the
#      versionCode also in the build folder, which has no git. It is not in the runtime version
#   1. runtime version: the fingerprint of this folder, which has no android/ (Expo's managed
#      workflow), the same value scripts/ota-export.mts gives every update
#   2. copy the app (with packages/shared and apps/web/src, which its bundle imports) to a build
#      folder outside the repository: Gradle writes build output into node_modules/*/android/build,
#      which release.sh would otherwise clone with every release
#   3. expo prebuild there, then gradlew assembleRelease with that runtime version and the release
#      keystore (~/.config/maru/android/keystore.properties). The build folder keeps android/ and
#      Gradle's state between builds, so Gradle reruns only what changed; android/ is generated
#      again from scratch (prebuild --clean) when the runtime version or the installed packages
#      changed since the last prebuild, or with MARU_ANDROID_CLEAN=1. Deleting the build folder
#      starts everything, Gradle's state in node_modules included, from nothing
#   4. check the APK (signature, embedded runtime version, embedded update manifest made by this
#      build) and publish it with latest.json
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The build settings file, same format as packages/shared/src/buildEnv.ts reads.
BUILD_ENV="${MARU_BUILD_ENV:-$HOME/.config/maru/build.env}"
DEFAULT_URL=""
if [ -f "$BUILD_ENV" ]; then
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in '' | '#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    case "$line" in *=*) ;; *) echo "build-apk: $BUILD_ENV line $n is not KEY=VALUE" >&2; exit 1 ;; esac
    case "$key" in '' | [0-9]* | *[!A-Za-z0-9_]*) echo "build-apk: $BUILD_ENV line $n is not KEY=VALUE" >&2; exit 1 ;; esac
    case "$val" in \"*\" | \'*\') val="${val:1:${#val}-2}" ;; esac
    [ "$key" != MARU_UPDATES_URL ] || DEFAULT_URL="$val"
    if [ -z "${!key+x}" ]; then export "$key=$val"; fi
  done <"$BUILD_ENV"
fi
UPDATES_URL="${MARU_UPDATES_URL:-}"
# A build that asks another server than the settings file's is a test build.
if [ -n "$DEFAULT_URL" ] && [ "$UPDATES_URL" != "$DEFAULT_URL" ] && [ -z "${MARU_MOBILE_DIR:-}" ]; then
  echo "build-apk: a test build (MARU_UPDATES_URL=$UPDATES_URL) needs its own MARU_MOBILE_DIR" >&2
  exit 1
fi
OUT="${MARU_MOBILE_DIR:-$HOME/.local/share/maru/mobile}/apk"
BUILD="${MARU_ANDROID_BUILD_DIR:-$HOME/.cache/maru-android-build}"
KEYPROPS="${MARU_ANDROID_KEYSTORE_PROPERTIES:-$HOME/.config/maru/android/keystore.properties}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export MARU_UPDATES_URL="$UPDATES_URL"
# The app's JavaScript reads the font CDN under this name (Metro inlines EXPO_PUBLIC_ variables).
if [ -n "${MARU_FONT_CDN:-}" ]; then export EXPO_PUBLIC_MARU_FONT_CDN="$MARU_FONT_CDN"; fi

[ -f "$KEYPROPS" ] || { echo "build-apk: no keystore properties at $KEYPROPS" >&2; exit 1; }
# The OTA read token every APK carries (app.config.ts, apps/server/src/mobile/updateToken.ts).
# Made once; a new one changes the runtime version, so installed APKs stop getting updates.
# A build without an update URL has OTA updates off and carries no token.
UPDATE_TOKEN_FILE="${MARU_UPDATE_TOKEN_FILE:-$HOME/.config/maru/mobile-update-token}"
if [ -n "$UPDATES_URL" ] && [ ! -f "$UPDATE_TOKEN_FILE" ]; then
  (umask 077 && mkdir -p "$(dirname "$UPDATE_TOKEN_FILE")" \
    && node -e 'process.stdout.write("maru_u_" + require("crypto").randomBytes(32).toString("base64url") + "\n")' >"$UPDATE_TOKEN_FILE")
  echo "build-apk: created the OTA update token $UPDATE_TOKEN_FILE"
fi
[ -d "$APP/node_modules" ] || { echo "build-apk: run npm ci in $APP first" >&2; exit 1; }
[ ! -e "$APP/android" ] || { echo "build-apk: $APP/android exists; the native project is generated in $BUILD only" >&2; exit 1; }

say() { printf 'build-apk: %s\n' "$*"; }
t0=$(date +%s)

REPO="$(cd "$APP/../.." && pwd)"
# A MARU_VERSION already in the environment wins (the release workflow takes it from its tag: the
# commit count of a public repository is not the version).
if [ -n "${MARU_VERSION:-}" ]; then
  [[ "$MARU_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-dev)?$ ]] || { echo "build-apk: MARU_VERSION '$MARU_VERSION' is not <major>.<minor>.<count>" >&2; exit 1; }
  say "version $MARU_VERSION (MARU_VERSION)"
else
  MARU_VERSION="$(node "$REPO/scripts/version.ts")" || { echo "build-apk: could not read the version of $REPO" >&2; exit 1; }
  say "version $MARU_VERSION (HEAD)"
fi
export MARU_VERSION
dirty="$(git -C "$REPO" status --porcelain -- apps/mobile packages/shared apps/web/src | wc -l | tr -d ' ')"
if [ "$dirty" != 0 ]; then say "  $dirty uncommitted change(s) in what the app bundles go into this APK without changing its version"; fi

say "runtime version"
RV="$(cd "$APP" && npx --no-install expo-updates runtimeversion:resolve --platform android --workflow managed \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).runtimeVersion))')"
[ -n "$RV" ] || { echo "build-apk: empty runtime version" >&2; exit 1; }
say "runtime version $RV"
# The installed packages, for what the runtime version does not hash but expo prebuild runs: its
# own code (@expo/cli, @expo/config-plugins, @expo/prebuild-config) and the native project
# template (expo/template.tgz). npm writes node_modules/.package-lock.json for the installed tree.
DEPS="$( { cat "$APP/package-lock.json"; [ ! -f "$APP/node_modules/.package-lock.json" ] || cat "$APP/node_modules/.package-lock.json"; } \
  | shasum -a 256 | cut -d' ' -f1)"

# The build folder mirrors the repository's layout for what the bundle reads: the app, the shared
# contract and the web's pure logic (metro.config.js).
WORK="$BUILD/repo/apps/mobile"
say "sync $APP -> $WORK"
mkdir -p "$BUILD" "$WORK" "$BUILD/repo/apps/web/src" "$BUILD/repo/packages/shared"
chmod 700 "$BUILD"
# Gradle's output and state inside node_modules stay between builds (P = protect from --delete):
# the native modules built from source (<package>/android/build, .cxx) and the Gradle plugins built
# as included builds (@react-native/gradle-plugin, expo-gradle-plugin, expo-module-gradle-plugin,
# expo-updates-gradle-plugin), each with its own task history in its .gradle/.
rsync -a --delete \
  --exclude /android --exclude /.expo --exclude /dist-ota \
  --filter 'P node_modules/**/android/build/' --filter 'P node_modules/**/android/.cxx/' \
  --filter 'P node_modules/**/.gradle/' \
  --filter 'P node_modules/**/*gradle-plugin/build/' --filter 'P node_modules/**/*gradle-plugin/*/build/' \
  "$APP/" "$WORK/"
rsync -a --delete "$REPO/apps/web/src/" "$BUILD/repo/apps/web/src/"
rsync -a --delete "$REPO/packages/shared/" "$BUILD/repo/packages/shared/"

cd "$WORK"

# Removes the injected signing lines (below) and the blank lines that end the file, keeping it
# private to this user.
strip_signing() {
  [ -f "$1" ] || return 0
  (umask 077 && { grep -v '^android\.injected\.signing\.' "$1" || true; } \
    | awk '{ l[NR] = $0 } END { n = NR; while (n > 0 && l[n] == "") n--; for (i = 1; i <= n; i++) print l[i] }' >"$1.tmp")
  mv "$1.tmp" "$1"
}

# expo prebuild generates android/; the build folder keeps it, with Gradle's state inside it
# (.gradle/ task history, build/, app/build/, app/.cxx/), so that Gradle reruns only what changed.
# A prebuild over the existing android/ (--no-clean; this Expo CLI cleans unless told not to)
# writes the same files as a clean one when the runtime version and the installed packages are
# those of the last prebuild (measured, DESIGN.md 2d): the runtime version hashes the native config,
# the config plugins and the native modules, and what it leaves out that reaches android/
# (version, versionCode, updates.url) is set in place. Config plugins only
# add to android/ (permissions, Gradle plugins), so a change that removes something needs a clean
# prebuild; such a change also changes the runtime version. PREBUILD_STEP goes up when this script
# changes how it runs prebuild.
PREBUILD_STEP=1
KEYFILE="android/.maru-prebuild-key"
clean=""
if [ "${MARU_ANDROID_CLEAN:-}" = 1 ]; then
  clean="MARU_ANDROID_CLEAN=1"
elif [ ! -d android ]; then
  clean="no android/ yet"
elif [ ! -f "$KEYFILE" ]; then
  clean="android/ has no prebuild key (made before keys existed, or by a prebuild that did not finish)"
else
  old_rv="$(sed -n 's/^runtime //p' "$KEYFILE")"
  old_deps="$(sed -n 's/^deps //p' "$KEYFILE")"
  old_step="$(sed -n 's/^prebuild //p' "$KEYFILE")"
  changed=""
  [ "$old_rv" = "$RV" ] || changed="$changed, runtime version ${old_rv:0:12} -> ${RV:0:12}"
  [ "$old_deps" = "$DEPS" ] || changed="$changed, installed packages"
  [ "$old_step" = "$PREBUILD_STEP" ] || changed="$changed, prebuild step ${old_step:-?} -> $PREBUILD_STEP"
  [ -z "$changed" ] || clean="changed since the last prebuild: ${changed#, }"
fi
# Without a key the next build starts clean, so a prebuild that stops halfway is not reused.
rm -f "$KEYFILE"
strip_signing android/gradle.properties
if [ -n "$clean" ]; then
  say "expo prebuild --clean: $clean"
  prebuild_flag=--clean
else
  say "expo prebuild --no-clean: same runtime version and installed packages as the last prebuild"
  prebuild_flag=--no-clean
fi
CI=1 EXPO_NO_GIT_STATUS=1 npx --no-install expo prebuild --platform android "$prebuild_flag" --no-install >/dev/null
printf 'runtime %s\ndeps %s\nprebuild %s\n' "$RV" "$DEPS" "$PREBUILD_STEP" >"$KEYFILE"

# Release signing through the Android Gradle plugin's injected properties (the generated
# build.gradle stays as Expo writes it). The build folder is private to this user. Prebuild ends
# the file with or without a newline depending on what it read; stripping again gives both paths
# the same bytes.
strip_signing android/gradle.properties
store="$(sed -n 's/^storeFile=//p' "$KEYPROPS")"
pass="$(sed -n 's/^storePassword=//p' "$KEYPROPS")"
alias="$(sed -n 's/^keyAlias=//p' "$KEYPROPS")"
kpass="$(sed -n 's/^keyPassword=//p' "$KEYPROPS")"
(umask 077 && {
  echo ""
  echo "android.injected.signing.store.file=$store"
  echo "android.injected.signing.store.password=$pass"
  echo "android.injected.signing.key.alias=$alias"
  echo "android.injected.signing.key.password=$kpass"
} >> android/gradle.properties)
chmod 600 android/gradle.properties

# expo-updates' createReleaseUpdatesResources writes the APK's embedded update manifest (a new id
# and commitTime, the asset list) and its fingerprint file, but declares only fixed strings as its
# inputs, so with the kept task history Gradle would call it up to date and ship the previous
# build's files. Without its output it runs again. The check after the build reads commitTime back.
rm -rf android/app/build/generated/assets/createReleaseUpdatesResources

say "gradlew assembleRelease"
tg=$(date +%s)
# arm64-v8a only: current phones and the Apple-silicon emulator. MARU_ANDROID_ABIS lists others.
(cd android && EXPO_UPDATES_FINGERPRINT_OVERRIDE="$RV" NODE_ENV=production ./gradlew assembleRelease --console=plain \
  -PreactNativeArchitectures="${MARU_ANDROID_ABIS:-arm64-v8a}")

APK="android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "build-apk: no $APK" >&2; exit 1; }
BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
"$BT/apksigner" verify --print-certs "$APK" | grep -E "Signer.* certificate (DN|SHA-256 digest):"
embedded="$(unzip -p "$APK" assets/fingerprint 2>/dev/null || true)"
[ "$embedded" = "$RV" ] || { echo "build-apk: APK fingerprint '$embedded' differs from $RV" >&2; exit 1; }
commit_time="$(unzip -p "$APK" assets/app.manifest 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(Math.floor(JSON.parse(s).commitTime/1000)))}catch{}})' || true)"
[ -n "$commit_time" ] && [ "$commit_time" -ge "$tg" ] \
  || { echo "build-apk: the APK's embedded update manifest (assets/app.manifest, commitTime ${commit_time:-none}) was not made by this build (started $tg)" >&2; exit 1; }
url_in_apk="$("$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK" | grep -A1 'EXPO_UPDATE_URL' | sed -n 's/.*A: http:\/\/schemas.android.com\/apk\/res\/android:value(0x[0-9a-f]*)="\([^"]*\)".*/\1/p' | head -1 || true)"
if [ -n "$UPDATES_URL" ]; then say "update URL in APK: $url_in_apk"; else say "OTA updates off (no MARU_UPDATES_URL)"; fi
# versionName and versionCode as Android reads them. A mismatch is reported, not fatal: the
# runtime version above is what OTA updates depend on.
badging="$("$BT/aapt2" dump badging "$APK" 2>/dev/null | sed -n '1p' || true)"
case "$badging" in
  *"versionCode='$(node -e 'process.stdout.write(process.argv[1].split(".")[2].split("-")[0])' "$MARU_VERSION")' versionName='$MARU_VERSION'"*) say "APK version $MARU_VERSION" ;;
  *) say "warning: the APK's version is not $MARU_VERSION: ${badging:-(aapt2 dump badging gave nothing)}" ;;
esac

stamp="$(date +%Y%m%d-%H%M%S)"
name="maru-$MARU_VERSION-${RV:0:12}-$stamp.apk"
mkdir -p "$OUT"
cp "$APK" "$OUT/$name.tmp"
mv "$OUT/$name.tmp" "$OUT/$name"
sha="$(shasum -a 256 "$OUT/$name" | cut -d' ' -f1)"
size="$(wc -c <"$OUT/$name" | tr -d ' ')"
node -e '
  const [out, file, rv, url, sha, size, version] = process.argv.slice(1);
  const fs = require("fs");
  const j = { file, runtimeVersion: rv, updatesUrl: url || null, sha256: sha, size: Number(size), builtAt: new Date().toISOString(), version };
  fs.writeFileSync(out + "/latest.json.tmp", JSON.stringify(j, null, 1) + "\n");
  fs.renameSync(out + "/latest.json.tmp", out + "/latest.json");' "$OUT" "$name" "$RV" "$url_in_apk" "$sha" "$size" "$MARU_VERSION"
say "$OUT/$name ($size bytes, sha256 $sha) in $(( $(date +%s) - t0 ))s"
