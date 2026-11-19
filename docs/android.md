# Android app

The Android app is a separate native app (Expo, Android only) that talks to your maru server
through the device listener. It shows the session list, conversations, shells and search, and it
pairs with the server by QR code.

## Install the released APK

Releases of this repository carry a ready-made APK (package `dev.maru.app`, OTA updates off).

1. Open the repository's Releases page on your phone and download `maru-<version>.apk` (a `.sha256` file sits next to it)
2. Open the file. Android asks once to allow installs from that app (the browser or the file manager)
3. Open maru and pair it with your server (below)

The app reads the repository's latest release at start and once a day while it stays open. When a newer one exists, the drawer shows "maru <version> is available" with a Download button that opens the APK in the browser. A failed check is silent.

## Reach your server from the phone

The app takes the server address from the pairing QR code and accepts only `https` (plain `http` only for the phone's own loopback). The device listener binds to `127.0.0.1`, so a plain LAN address does not work: direct connection over the same Wi-Fi is not supported. Put an HTTPS tunnel in front of the device listener.

On the server:

1. Set `MARU_DEVICE_PORT` (for example `8025`) and restart the server. This opens the device listener on `127.0.0.1:<port>`
2. Expose that port over HTTPS with one of the options below
3. Set `MARU_DEVICE_URL` to the public address (`https://...`, no path) so the pairing QR carries it, and `MARU_DEVICE_HOSTS` to the same name as the `Host` header shows it (`name.example.com`, with `:port` only for a non-default port). Restart
4. In the web UI on the Mac, open Settings, Devices and scan the QR code with the app

The device listener allows a request only when its `Host` header is `127.0.0.1:<port>`, `localhost:<port>`, an entry of `MARU_HOSTS` or an entry of `MARU_DEVICE_HOSTS` (an exact match, `apps/server/src/devices/deviceServer.ts`). A refused request answers 403 `host not allowed: <value>`, and that value is what to add.

Tailscale (recommended): reachable only from your tailnet, never from the internet.

1. Install Tailscale on the Mac and the phone and sign in to the same tailnet
2. Enable MagicDNS and HTTPS certificates in the Tailscale admin console
3. On the Mac (syntax of Tailscale 1.52 and later; check the [Tailscale Serve docs](https://tailscale.com/kb/1242/tailscale-serve) for the current form):

   ```sh
   tailscale serve --bg --https=443 localhost:8025
   tailscale serve status        # shows https://<machine>.<tailnet>.ts.net
   ```

4. `MARU_DEVICE_URL=https://<machine>.<tailnet>.ts.net` and `MARU_DEVICE_HOSTS=<machine>.<tailnet>.ts.net`. The app sends that name as `Host`, with no port because 443 is the default. Tailscale Serve should hand the `Host` header on to the listener; the 403 message above names the value when it does not
5. Switch it off with `tailscale serve --https=443 localhost:8025 off`. Do not use `tailscale funnel`, which publishes the address to the internet

Cloudflare quick tunnel: `cloudflared tunnel --url http://127.0.0.1:8025` prints a `https://<random>.trycloudflare.com` address. The address changes at every start, so each restart needs a new `MARU_DEVICE_URL` and `MARU_DEVICE_HOSTS` and a new pairing. The address is public on the internet; the device token is the only thing that guards it.

ngrok: a free account gets one static domain. `ngrok http --url=<your-domain>.ngrok-free.app 127.0.0.1:8025` (check ngrok's current syntax). The address is public on the internet, guarded by the device token alone.

The desktop app pairs with the same address: the dialog in Settings, Devices offers a short code and link for it, built from `MARU_DEVICE_URL` as well. The computer that runs it must reach the address (join the tailnet for Tailscale).

## Build it yourself

The Android app lives in `apps/mobile` (Expo SDK 58, a separate npm package root with its own `node_modules`). Signing keys, build settings and the release workflow are in [apps/mobile/README.md](../apps/mobile/README.md).

```sh
cd apps/mobile
npm ci
scripts/build-apk.sh                     # builds a release APK with Gradle, no EAS
```

`build-apk.sh` runs `expo prebuild` in a build folder outside the repository, then `gradlew assembleRelease`, and writes the APK under `~/.local/share/maru/mobile/apk/`, where the server offers it for download. It needs `JAVA_HOME` (default: the JBR inside Android Studio) and `ANDROID_HOME`.

- Keys you create yourself (the commands are in [apps/mobile/README.md](../apps/mobile/README.md))
  - The Android signing keystore (`keystore.properties` and a PKCS12 keystore, default folder `~/.config/maru/android/`)
  - The OTA update signing key pair (see [Update signing keys](#update-signing-keys)). JavaScript changes reach installed apps as signed OTA updates that the server serves
  - The OTA read token, which `build-apk.sh` creates once in `~/.config/maru/mobile-update-token`
- Build settings (package name `MARU_ANDROID_PACKAGE`, default `dev.maru.app`, the update URL `MARU_UPDATES_URL` and others) can be set in `~/.config/maru/build.env`. See [apps/mobile/README.md](../apps/mobile/README.md) and [build.env.example](../build.env.example)
- Push notifications are optional and need a Firebase project ([apps/mobile/FCM-SETUP.md](../apps/mobile/FCM-SETUP.md))

## Update signing keys

One RSA key pair signs the Android OTA updates and the desktop update manifest. The private key stays on your build machine, and the certificate goes into the apps. Expo's generator writes a pair that Expo Updates accepts. Run it once, after `npm ci` in `apps/mobile`

```sh
cd apps/mobile
npx expo-updates codesigning:generate \
  --key-output-directory ~/.config/maru/updates-signing \
  --certificate-output-directory certs \
  --certificate-validity-duration-years 10 \
  --certificate-common-name maru
chmod 600 ~/.config/maru/updates-signing/private-key.pem
```

- It writes `~/.config/maru/updates-signing/private-key.pem` (and a `public-key.pem` that nothing here reads) and `apps/mobile/certs/certificate.pem`
- The OTA export and the desktop build read the private key from that path by default (`MARU_UPDATES_KEY`, `--key`), and the certificate from `apps/mobile/certs/certificate.pem` (`MARU_UPDATES_CERT`, `--cert`)
- The certificate is a native input of the Android app. A new certificate needs a new APK, and installed apps built with the old one stop taking your updates. Keep the private key safe and never commit it. `apps/mobile/certs/certificate.pem` belongs to your deployment, and each deployment makes its own
