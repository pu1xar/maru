# Turning on FCM push

The maru Android app is ready to receive push notifications through FCM (Firebase Cloud Messaging), and they are off until you set them up: without a Firebase project the app is built without FCM, and without a credential the server sends nothing. Follow the steps below to turn them on.

Two files are needed. Keep both on the machine that builds the app and runs the server, outside the repository.

| File | Read by | Location | Secret |
|---|---|---|---|
| `google-services.json` | the APK build (`app.config.ts`) | `~/.config/maru/firebase/google-services.json` | No. App registration facts (project id, app id, API key). They are built into the APK, where anyone can read them |
| service account key (JSON) | the maru server (`apps/server/src/push/`) | `~/.config/maru/firebase/service-account.json` | Yes. This key can send pushes |

To use other paths, set `MARU_GOOGLE_SERVICES_FILE` for the build and `MARU_FCM_SERVICE_ACCOUNT_FILE` for the server.

## 1. Create a Firebase project

1. Sign in to https://console.firebase.google.com with a Google account and choose "Create a project"
2. Any name works (for example `maru`). Google Analytics can stay off; push does not need it
3. In Project settings (the gear), open the "Cloud Messaging" tab and check that "Firebase Cloud Messaging API (V1)" is enabled. If it is not, enable it in the Google Cloud console from the menu beside it. The legacy server key API is not used

## 2. Register the Android app and get `google-services.json`

1. In Project Overview, add an app with the Android icon
2. Android package name: the value of `MARU_ANDROID_PACKAGE` (in `~/.config/maru/build.env`, default `dev.maru.app`). It must match `android.package` in `apps/mobile/app.config.ts` exactly
3. Any app nickname works (for example `maru`). The "Debug signing certificate SHA-1" field is not needed for FCM and can stay empty. You need the release signing certificate's SHA-1 only if you restrict the API key in step 5 (step 5 shows how to get it)
4. Download `google-services.json` and put it in place:

   ```sh
   mkdir -p ~/.config/maru/firebase
   chmod 700 ~/.config/maru/firebase
   mv ~/Downloads/google-services.json ~/.config/maru/firebase/google-services.json
   chmod 600 ~/.config/maru/firebase/google-services.json
   ```

5. (Optional) Restrict the API key to your app
   - The API key in `google-services.json` is created by Firebase, and at first it carries no Android app restriction: someone who extracts it can call this Firebase project from another app. It cannot send pushes (only the service account key in section 3 can)
   - To restrict it, get the SHA-1 of your release signing certificate. The password is `storePassword` in `~/.config/maru/android/keystore.properties`

     ```sh
     keytool -list -v -storetype PKCS12 -keystore ~/.config/maru/android/maru-release.p12 | grep 'SHA1:'
     ```

   - In Firebase Project settings, under your app (the `MARU_ANDROID_PACKAGE` value), choose "Add fingerprint" and enter that SHA-1
   - In the Google Cloud console, under "APIs & Services", "Credentials", open that API key, set the application restriction to "Android apps", and enter the package name (the `MARU_ANDROID_PACKAGE` value) with the same SHA-1
   - After restricting it, check that the app's settings sheet shows push for this device as on. A wrong SHA-1 keeps the app from getting a token, and the sheet shows the failure
6. Skip the console's remaining steps (editing Gradle files, adding the SDK). `expo prebuild` adds them from `android.googleServicesFile` in `app.config.ts`

## 3. The service account key for the server

Prefer an account that can only send pushes. The default account on the Firebase console's "Service accounts" tab (`firebase-adminsdk-...`) can administer all of Firebase, so a leaked key does more harm.

1. On the "Service accounts" tab of Project settings, follow "Manage service account permissions" to the Google Cloud console
2. "Create service account", for example named `maru-push`
3. Give it the role "Firebase Cloud Messaging API Admin" (`roles/firebasecloudmessaging.admin`). If that role is not offered, the default account's key (`firebase-adminsdk-...`) also works; it only has wider permissions
4. On the new account's "Keys" tab choose "Add key", "Create new key", JSON, and put the downloaded file in place:

   ```sh
   mv ~/Downloads/<project>-<id>.json ~/.config/maru/firebase/service-account.json
   chmod 600 ~/.config/maru/firebase/service-account.json
   ```

5. The server logs a warning when the file's permissions are wider than 0600. Never paste its contents (`private_key`) anywhere
6. If the key is lost or leaked, delete it on the same "Keys" tab and create a new one. A deleted key stops working at once

## 4. Build and install a new APK

`google-services.json` is a native setting, so it changes the runtime version (the native fingerprint). After putting the file in place you need a new APK.

1. Build the release APK with `apps/mobile/scripts/build-apk.sh`. The build sees the file and turns FCM on (`extra.maruPush` in `app.config.ts` becomes true)
2. On the phone, download the APK from the web app's settings (Devices) and install it. App data and pairing stay as they are

Note: from the moment the file is in place, the OTA updates your builds export carry the new runtime version. An app installed before the new APK cannot take them (the app's settings sheet and the web's Devices tab say a new APK is needed). Put the file in place, build the APK and install it in one go.

## 5. Turn on the server side

The server reads the service account file when it starts. After putting the file in place, restart the maru server. Its start log has a line saying push is on.

## 6. Check

1. Open the app. On Android 13 and later it asks for notification permission; allow it
2. In the app's settings sheet, under "Push notifications"
   - This device: on (the server has this device's token)
   - Server: "Can send"
3. Send a message to a session from the app and go straight to the home screen. When the turn ends, a notification arrives; tapping it opens that session
4. While the app is on screen, no notification is shown (by design)

## Turning it off

- Server only: move `service-account.json` away and restart the server. The app can stay as it is
- The app too: move `google-services.json` away, then build and install the APK again (the runtime version changes again)
- One device: turn off maru notifications in the phone's Android settings
