# maru

maru is a personal chat UI for [Claude Code](https://code.claude.com) and [Codex](https://github.com/openai/codex) sessions. It runs as a small local server and shows every session of your Claude and Codex accounts in one window, in a browser, in an Electron desktop app, or in an Android app.

It reads the transcripts and daemons that the two CLIs already keep, so sessions you started in a terminal appear in the list and update live. A session that is stopped can be continued from the UI. A session that a terminal still has open is shown read-only. Sessions started from maru run through the official Claude Agent SDK (Claude) and the Codex app-server (Codex), with permission prompts turned off, so treat the server like a shell on your machine (see [Security model](#security-model)).

maru is a single-user tool, built for one person on one Mac. It is published as is, without a support promise.

## Features

Everything below is in the code of this repository.

- Session list
  - A list of the sessions you chose from all sessions of the configured Claude and Codex accounts (a new session made in maru joins the list by itself, others come in through "Add existing session", and "Remove from list" leaves the session files alone), grouped into user-defined Groups, with pinned sessions, folders that fold, an archive, a lock, rename, trash with restore, move to another account, and a working-folder change (rehome)
  - Live status (running, waiting for input, idle, closed) and which side holds the session (maru or a terminal)
- Conversation view
  - Timeline with markdown, code highlighting, tool rows, diffs, Mermaid diagrams and images, with windowed loading of long histories
  - Composer with slash commands, attachments (paste, drop, file picker), a queue for messages sent while a turn runs, model and effort pickers, and the question, plan and approval dialogs of both agents
  - Rewind a conversation or the code to an earlier message, and fork from a message
  - Search inside a conversation and across all sessions
- Terminal mode: the same conversation drawn like the Claude Code CLI
- Right panel: a file explorer with file preview tabs, and an Activity tab with subagents and background tasks
- Split view: several sessions and shells side by side in tab-like layouts, built by drag and drop
- Lean window: one session in its own small window
- Shell terminals: shells on a tmux server of their own, attached through xterm.js, which survive a restart of the web server
- Usage: rate-limit meters per account and a dashboard of running and waiting sessions
- Android app (Expo, Android only): the session list, conversation, shell and search, pairing by QR code, over-the-air updates served by your own server, optional push notifications through Firebase Cloud Messaging
- Desktop app (Electron, macOS and Windows installers): the web UI in its own window, paired like the Android app, with signed self-updates

The UI language is English.

## Requirements

- macOS. maru is developed and tested on macOS only
  - Code that assumes macOS: the folder picker (`osascript`), reading Claude Code credentials from the login Keychain (`security`), the `~/.Trash` stub folder, Keychain storage of the desktop pairing, and the Android build defaults (Android Studio on macOS)
  - Linux may run the core (the server, host and web UI use `ps`, `pgrep`, `lsof` and unix sockets) but has not been tried. Windows is supported only as a target of the desktop app, not for the server
- Node.js 26 or newer
- pnpm 9 (the repository pins `pnpm@9.15.0` in `package.json`)
- For Claude sessions: the Claude Code CLI, signed in (see [Authentication](#authentication-and-anthropics-terms)). maru finds it in this order: `claudeBin` in the config file, `claude` on the `PATH` of the server, then `~/.local/bin/claude` (where the native installer puts it)
- For Codex sessions: the Codex CLI, signed in, with its app-server daemon running (`codex remote-control start`). An account without a running daemon is read from its state database and cannot be driven
- tmux, for the shell terminals
- For the Android app: Android Studio (its bundled JBR) and the Android SDK, and Node with npm for `apps/mobile`

## Quick start

1. Install the dependencies

   ```sh
   pnpm install
   ```

2. Build the web UI

   ```sh
   pnpm build:web          # writes apps/web/dist
   ```

3. Start the Claude session host in one terminal

   ```sh
   pnpm host
   ```

   The host is a separate process that owns the Claude CLI child processes, so restarting the web server does not interrupt running turns. Without it the server still lists and reads sessions, and sending to a Claude session answers with an error.

4. Start the server in another terminal

   ```sh
   pnpm start
   ```

5. Open http://127.0.0.1:8024

The session list starts empty. Use "Add existing session" in the sidebar to search the sessions of your accounts and pick the ones to show, or start a new session from maru.

The server binds to `127.0.0.1` only. The port is 8024, or the `PORT` environment variable.

Development with hot reload runs two processes. The Vite dev server proxies `/api` and `/ws` to the server (`MARU_PORT` names the server port when it is not 8024).

```sh
MARU_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 pnpm dev:server
pnpm dev:web            # http://127.0.0.1:5173
```

## Configuration

maru reads `~/.config/maru/config.json`. Set `MARU_CONFIG` to use another path. Every field is optional, and `~` expands to your home folder.

```json
{
  "claudeAccounts": [{ "id": "claude", "dir": "~/.claude" }],
  "codexAccounts": [{ "id": "codex", "home": "~/.codex" }],
  "claudeBin": "~/.local/bin/claude",
  "claudeUsage": false,
  "codexUsage": false
}
```

- `claudeAccounts[].dir` is the `CLAUDE_CONFIG_DIR` of an account, `codexAccounts[].home` is its `CODEX_HOME`
- Without a file, or without the account fields, maru detects `~/.claude` and `~/.codex` when they exist and names them `claude` and `codex`
- A file that is not valid JSON stops the server at startup, and the server prints the reason
- Several accounts: give each account its own directory and sign in to each one separately

  ```sh
  CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
  ```

- The Accounts page edits this file for you: Settings, Accounts
  1. The list shows every account with its provider, folder and login status (Signed in, Not signed in, CLI not found, Unknown). An account found on disk without being in the file is marked Detected
  2. Add account asks for the provider, an id (letters, digits, `.`, `_`, `-`; unique) and the folder (default `~/.claude-<id>` or `~/.codex-<id>`). maru writes the account to the config file, creates the folder and opens a terminal with the CLI's own sign-in (`claude auth login` or `codex login`) typed in. Finish the sign-in there, then press Refresh
  3. Remove takes the account out of the config file only. Its folder and its login stay
  4. The "Claude usage" and "Codex usage" switches set `claudeUsage` and `codexUsage`
  5. The server reads its accounts at start, so an added or removed account applies after you restart maru (the page says so)
  6. Login status comes from `claude auth status` and `codex login status`. maru never reads token files or the keychain for it, and never receives a password, token or code
  7. The Android app shows the same list read only. Add, remove and sign in on a computer
- `claudeBin` is the path of the Claude CLI. Without it, maru uses `claude` from the `PATH`, then `~/.local/bin/claude`
- `claudeUsage` (default `false`) turns on the Claude usage meters, which read Claude Code's stored OAuth token and send it to Anthropic. Read [Authentication and Anthropic's terms](#authentication-and-anthropics-terms) before enabling it
- `codexUsage` (default `false`) turns on the Codex usage meters. maru reads the login token that the Codex CLI stored (`<CODEX_HOME>/auth.json`) and sends it to OpenAI's private usage endpoint `https://chatgpt.com/backend-api/wham/usage`, with the Codex CLI's `User-Agent`. Read the Codex paragraph of [Authentication and Anthropic's terms](#authentication-and-anthropics-terms) before enabling it

State lives in `~/.config/maru/`: `state.sqlite` (Groups, locks, paired devices and similar), the session host socket, the shell tmux socket, the trash and uploaded attachments. These environment variables move them or change the server's behavior.

| Variable | Meaning |
|---|---|
| `PORT` | Web listener port (default 8024) |
| `MARU_HOSTS` | Extra `host:port` values the web listener accepts in the `Host` header |
| `MARU_ORIGINS` | Extra browser origins the web listener accepts |
| `MARU_STATE` | Path of `state.sqlite` |
| `MARU_HOST_SOCKET` | Path of the session host socket |
| `MARU_SHELL_SOCKET` | Path of the shell tmux socket |
| `MARU_TRASH` | Folder for deleted sessions |
| `MARU_ATTACHMENTS` | Folder for uploaded attachments |
| `MARU_TMUX` | Path of the tmux binary |
| `MARU_DEVICE_PORT` | Port of the device listener (off when unset, see [Security model](#security-model)) |
| `MARU_DEVICE_HOSTS` | Extra `Host` values the device listener accepts |
| `MARU_DEVICE_URL` | Server URL that pairing links carry |
| `MARU_UPDATE_TOKEN_FILE` | File that holds the OTA update token (default `~/.config/maru/mobile-update-token`). The server accepts it on the update routes, and the Android build embeds it |
| `MARU_MOBILE_DIR` | Folder of the Android build output that the server offers for download (default `~/.local/share/maru/mobile`, APKs in `apk/`) |
| `MARU_OTA_DIR` | Folder of the exported Android OTA update (default `apps/mobile/dist-ota`) |
| `MARU_DESKTOP_DIR` | Folder of the desktop app build and its signed manifest (default `apps/desktop/dist-release`) |
| `MARU_FCM_SERVICE_ACCOUNT_FILE` | Firebase service account key for push (default `~/.config/maru/firebase/service-account.json`, see `apps/mobile/FCM-SETUP.md`) |
| `MARU_CLAUDE_USAGE_URL` | Claude usage endpoint (default `https://api.anthropic.com/api/oauth/usage`), for pointing a test instance at a stand-in |
| `MARU_CODEX_USAGE_URL` | Codex usage endpoint (default `https://chatgpt.com/backend-api/wham/usage`), for the same purpose |
| `USAGE_CLAUDE_RATE_CACHE_TTL` | Seconds that a Claude usage read is reused per account (default 60) |
| `USAGE_CODEX_LIVE_CACHE_TTL` | Seconds that a Codex usage read is reused per account (default 60) |
| `MARU_PORT` | Development only: the server port that the Vite dev server proxies to (default 8024) |
| `MARU_CONFIG` | Path of the config file (default `~/.config/maru/config.json`) |

Build and desktop variables. The web and Android builds also read them from `~/.config/maru/build.env` (see `build.env.example`; `MARU_BUILD_ENV` names another file)

| Variable | Meaning |
|---|---|
| `MARU_ANDROID_PACKAGE` | Android application id (default `dev.maru.app`) |
| `MARU_UPDATES_URL` | OTA manifest URL built into the APK (unset: OTA off) |
| `MARU_UPDATES_CERT` | Certificate of the OTA signing key (default `apps/mobile/certs/certificate.pem`) |
| `MARU_UPDATES_KEY` | Private key that signs OTA updates (default `~/.config/maru/updates-signing/private-key.pem`) |
| `MARU_CAMERA_PERMISSION_TEXT` | Text of the Android camera permission prompt (a native resource, so a change needs a new APK) |
| `MARU_RELEASES_REPO` | `<owner>/<repo>` whose GitHub Releases the Android app checks for a newer APK (unset: the server's notice only) |
| `MARU_FONT_CDN` | Where the Bon Google Sans Code files are served (unset: no Bon file is downloaded) |
| `MARU_GOOGLE_SERVICES_FILE` | `google-services.json` for push builds (default `~/.config/maru/firebase/google-services.json`) |
| `MARU_VERSION` | Version that a build reports (default: derived from the checkout) |
| `MARU_DESKTOP_APP_ID` | Desktop application id (default `dev.maru.desktop`) |
| `MARU_DESKTOP_TARGETS` | Default of `--targets` of the desktop build |
| `MARU_DESKTOP_USER_DATA` | Data folder of the desktop app instead of the OS default |
| `MARU_DESKTOP_SHOW_INACTIVE` | The desktop app opens its window without taking focus |

## Authentication and Anthropic's terms

maru does not handle Claude logins. Each user signs in to the unmodified Claude Code CLI with their own account, and maru drives that CLI through the Claude Agent SDK.

```sh
claude auth login            # a Claude subscription
claude auth login --console  # an Anthropic Console account (API billing)
```

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says, under "Acceptable use":

> Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK.

and, under "Authentication and credential use":

> Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens

and, in the same text, that this does

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription

How maru reads this

- maru is a program built on the Agent SDK, so the first sentence (API key authentication for developers) applies to maru's author and to anyone who redistributes maru as a product or service
- maru is meant for the case of the last quote: you, an end user, sign in to the unmodified Claude Code binary with your own Claude subscription, on your own machine, and maru drives that binary
  - maru does not offer Claude.ai login, does not receive or store your login, and does not route anyone else's requests through your plan
  - The use is meant to be ordinary and individual: one person, one Mac, sessions that person starts
- This is an interpretation, and the wording leaves room for another one: a tool that wraps the Agent SDK around a subscription login can be read as "building a product that interacts with Claude's capabilities", and Anthropic can change the text or enforce it without notice. Using a subscription with maru, and what follows for your account, is your decision and your responsibility
- When you are not sure, use API billing (`claude auth login --console`, or a supported cloud provider through the CLI's own settings) instead of a subscription, or ask Anthropic ([contact sales](https://www.anthropic.com/contact-sales))

```sh
claude auth login            # a Claude subscription
claude auth login --console  # an Anthropic Console account (API billing)
```

- Do not use maru to host sessions for other people. It is a single-user tool and it has no user accounts
- API billing: the CLI's Console login (`claude auth login --console`) stores its credentials in the account's config directory. maru starts the CLI with a fixed, minimal environment (`HOME`, `USER`, `PATH`, `LANG`, `SHELL`, `CLAUDE_CONFIG_DIR` and a few more), so an `ANTHROPIC_API_KEY` set in the server's environment does not reach the CLI
- `claudeUsage` reads the OAuth token that Claude Code stored (login Keychain on macOS, or `.credentials.json` in the config directory) and sends it to `https://api.anthropic.com/api/oauth/usage` to read the 5-hour and 7-day usage windows
  - The request carries `User-Agent: claude-code/<version>`, with the version of your installed CLI, so it looks like the requests Claude Code makes itself (`apps/server/src/usage/claude.ts`)
  - The endpoint is not a documented API, and the token belongs to Claude Code. The switch is off by default. Turning it on is your decision and your responsibility
- Codex: sessions run through the Codex CLI's own app-server and its own sign-in, which maru does not read
  - `codexUsage` is the exception. It reads the login token in `<CODEX_HOME>/auth.json` and calls OpenAI's private endpoint `https://chatgpt.com/backend-api/wham/usage` with the Codex CLI's `User-Agent`. The endpoint is not a documented API, and this README does not review OpenAI's terms for it. The switch is off by default. Turning it on is your decision and your responsibility

## Security model

maru starts agents with permission prompts off (Claude with `bypassPermissions`, Codex with approval policy `never` and full filesystem access) and opens shells. Whoever can use the UI can run commands as your user. The web listener has no login, so that includes every process on this Mac and every other OS user of this Mac: a request without an `Origin` header (curl, a script) passes the checks below and can start a shell.

- Network binding: the web listener binds to `127.0.0.1`, so other machines cannot reach it directly. On this machine the port is open to every local process and user. The `Host` and `Origin` checks stop web pages (DNS rebinding, cross-site requests), not local programs. On a Mac with several users, each of them controls your agents
- The web listener has no login of its own. Its protections are
  - `Host` check: a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (plus `MARU_HOSTS`) is refused with 403, which blocks DNS rebinding
  - `Origin` check: a browser request with an `Origin` that is not in the allowed list (loopback plus `MARU_ORIGINS`) is refused for HTTP and WebSocket
- Devices (the Android and desktop apps) connect to a second listener, the device listener, on `MARU_DEVICE_PORT` (also loopback, started only when the variable is set). Source: `apps/server/src/devices/`
  - Pairing: in the web UI (Settings, Devices) you open a pairing dialog. It shows a one-time code (a QR code for Android, a short code or link for desktop) that is valid while the dialog is open. The app sends it to `POST /api/device/pair` and receives a device token
  - Secrets are 256 random bits with a prefix (`maru_p_` pairing code, `maru_d_` device token, `maru_u_` update token). The server stores only their SHA-256 hashes. Pairing codes live in memory and end when the dialog closes or when a restart happens
  - Every request and WebSocket upgrade on the device listener is checked, and a request that names an `Origin` must come from a page of the host it asks. Removing a device in the web UI closes its open sockets at once
  - What a token reaches depends on the device kind, which the pairing code fixes. An Android token reaches an allowlist of routes (sessions, messages, rewind and fork, session management, attachments, shells, pictures). A desktop token reaches everything the web listener serves except device management. Device management exists only on the web listener
  - The OTA update token, built into every APK, opens only the update routes
- Session host: a unix socket in `~/.config/maru/`, mode 0600. The host runs Claude with permissions bypassed, so the socket is a command execution path for your user
- To reach maru from outside the machine, put it behind a reverse proxy that you configure and that authenticates users first
  - Route requests that carry `Authorization: Bearer maru_...` to the device port, and send everything else through your authentication to the web port
  - Add the public hostname to `MARU_HOSTS` (and `MARU_DEVICE_HOSTS`) and its origin, such as `https://maru.example.com`, to `MARU_ORIGINS`. Browser requests through the proxy carry that origin, and without it they fail the `Origin` check (`apps/server/src/http/guard.ts`). Serve HTTPS. The apps accept only `https` server addresses, with `http` allowed for loopback
  - Without your own authentication in front, anyone who can reach the web port controls the agents

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Desktop app

The desktop app is an Electron window that opens the web UI of the server it is paired with. The server must expose the device listener (see above).

```sh
pnpm --filter @maru/desktop start       # bundles and runs the app in development
node apps/desktop/scripts/build.ts --out <dir> --targets mac-arm64   # installers and a signed update manifest
```

`build.ts` takes `--targets` from `mac-arm64`, `mac-x64`, `win-x64`, `win-arm64` (or `MARU_DESKTOP_TARGETS`), builds with electron-builder, and signs the update manifest.

- You create the update signing key pair yourself (see [Update signing keys](#update-signing-keys)). `--key` and `--cert` of `build.ts` name another pair. The certificate is embedded in the desktop app and in the Android app, and the apps verify every update against it
- On macOS the app is signed with a local self-signed certificate in your login Keychain, because the build uses no Apple Developer ID (see [macOS signing certificate](#macos-signing-certificate)). Without it the build signs ad hoc, and the Keychain asks for access again after each update
- Unit tests of the app run with the root `pnpm test`

### Update signing keys

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

### macOS signing certificate

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

## Android app

### Install the released APK

Releases of this repository carry a ready-made APK (package `dev.maru.app`, OTA updates off).

1. Open the repository's Releases page on your phone and download `maru-<version>.apk` (a `.sha256` file sits next to it)
2. Open the file. Android asks once to allow installs from that app (the browser or the file manager)
3. Open maru and pair it with your server (below)

The app reads the repository's latest release at start and once a day while it stays open. When a newer one exists, the drawer shows "maru <version> is available" with a Download button that opens the APK in the browser. A failed check is silent.

### Reach your server from the phone

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

### Build it yourself

The Android app lives in `apps/mobile` (Expo SDK 58, a separate npm package root with its own `node_modules`). Signing keys, build settings and the release workflow are in `apps/mobile/README.md`.

```sh
cd apps/mobile
npm ci
scripts/build-apk.sh                     # builds a release APK with Gradle, no EAS
```

`build-apk.sh` runs `expo prebuild` in a build folder outside the repository, then `gradlew assembleRelease`, and writes the APK under `~/.local/share/maru/mobile/apk/`, where the server offers it for download. It needs `JAVA_HOME` (default: the JBR inside Android Studio) and `ANDROID_HOME`.

- Keys you create yourself (the commands are in `apps/mobile/README.md`)
  - The Android signing keystore (`keystore.properties` and a PKCS12 keystore, default folder `~/.config/maru/android/`)
  - The OTA update signing key pair (see [Update signing keys](#update-signing-keys)). JavaScript changes reach installed apps as signed OTA updates that the server serves
  - The OTA read token, which `build-apk.sh` creates once in `~/.config/maru/mobile-update-token`
- Build settings (package name `MARU_ANDROID_PACKAGE`, default `dev.maru.app`, the update URL `MARU_UPDATES_URL` and others) can be set in `~/.config/maru/build.env`. See `apps/mobile/README.md` and `build.env.example`
- Push notifications are optional and need a Firebase project (`apps/mobile/FCM-SETUP.md`)

## Project layout

```text
apps/server       Node 26 server, runs TypeScript directly (type stripping)
  src/claude        Claude transcripts, session index, driver, projection
  src/codex         Codex app-server connection, index, projection, generated protocol types
  src/host          Claude session host process and its socket protocol
  src/http          web listener, Host and Origin guard
  src/devices       pairing, device tokens, device listener
  src/shell         shell terminals (tmux and node-pty)
  src/usage         usage readers
apps/web          React and Vite web UI
apps/desktop      Electron app and its build scripts
apps/mobile       Expo Android app (own npm package root)
packages/shared   types and pure helpers shared by all of the above
scripts           version and host maintenance scripts
docs              architecture notes
patches           pnpm patches for two npm packages
```

The architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```sh
pnpm typecheck          # server, web and desktop (tsc)
pnpm test               # node --test over server, web, shared, desktop and scripts

cd apps/mobile
npx tsc --noEmit -p .
node --test 'src/**/*.test.ts' 'scripts/**/*.test.mts'
```

The mobile tests compare generated bundles with the packages that `apps/web` installs, so run `pnpm install` at the root first. GitHub Actions runs the same commands on macOS (`.github/workflows/ci.yml`). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Third-party code and bundled files, with their licenses, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
