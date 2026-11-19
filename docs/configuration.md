# Configuration

maru has a config file for the accounts and two usage switches, and environment variables for
ports, state paths and builds. The Accounts page in the web UI edits the config file for you.

## Config file

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
- `claudeUsage` (default `false`) turns on the Claude usage meters, which read Claude Code's stored OAuth token and send it to Anthropic. Read [Authentication and Anthropic's terms](../README.md#authentication-and-anthropics-terms) before enabling it
- `codexUsage` (default `false`) turns on the Codex usage meters. maru first asks the Codex app-server (`account/rateLimits/read`). When no app-server answers for that home, it reads the login token that the Codex CLI stored (`<CODEX_HOME>/auth.json`) and sends it to OpenAI's private usage endpoint `https://chatgpt.com/backend-api/wham/usage`, with the Codex CLI's `User-Agent`, and then falls back to the last rate-limit snapshot in a session rollout. Off, none of these run. Read the Codex paragraph of [Authentication and Anthropic's terms](../README.md#authentication-and-anthropics-terms) before enabling it

## Environment variables

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
| `MARU_DEVICE_PORT` | Port of the device listener (off when unset, see [Security model](security.md)) |
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

## Build and desktop variables

The web and Android builds also read them from `~/.config/maru/build.env` (see [build.env.example](../build.env.example); `MARU_BUILD_ENV` names another file).

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
